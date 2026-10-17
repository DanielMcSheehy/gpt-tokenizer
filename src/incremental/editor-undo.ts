import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  /**
   * Replaces the tracked text entirely and returns the new token count.
   * Equivalent to `encoding.countTokens(text)` under the default
   * special-token policy, including thrown errors.
   */
  update(text: string): number
  /**
   * Applies `text.slice(0, start) + insert + text.slice(start + deleteCount)`
   * (JavaScript UTF-16 indexes, same clamping as String.prototype.slice) and
   * returns the new token count. Equivalent to `encoding.countTokens` of the
   * resulting text, including thrown errors.
   */
  applyEdit(start: number, deleteCount: number, insert: string): number
  /** Token count of the currently tracked text. */
  count(): number
  /** Clears the tracked text, the snapshot ring, and the piece-count cache. */
  reset(): void
}

/**
 * Creates an incremental token counter optimized for the editor pattern:
 * many small `applyEdit` calls, including undos that restore a recent text.
 *
 * Every count returned equals `encoding.countTokens(text)` for the same
 * encoding and the same (default) special-token policy.
 */
export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  return new EditorUndoCounter(encoding)
}

interface Piece {
  /** UTF-16 offset of the piece start within its state's text. */
  start: number
  /** UTF-16 offset of the piece end within its state's text. */
  end: number
  /** Number of BPE tokens this piece encodes to (1 for direct rank hits). */
  count: number
}

interface State {
  text: string
  /** Consecutive regex pieces of `text` in order (gaps possible, never empty matches). */
  pieces: Piece[]
  count: number
}

/** Recent texts and their piece snapshots; at least 8 entries per the design. */
const RING_CAPACITY = 16
/** Piece string -> token count cache; cleared wholesale when exceeded. */
const PIECE_CACHE_LIMIT = 65_536
/**
 * A base piece is only provably unchanged when everything its match could
 * depend on lies inside a region shared with the new text:
 * - the one-character lookaheads (`\p{White_Space}+(?!\P{White_Space})`),
 * - `$`-anchored alternatives (those end at end of text, so they are never
 *   copied from a prefix region),
 * - the optional contraction suffixes in the o200k word alternatives
 *   (`" don"` can grow into `" don't"` / `" don'll"`-style matches), which
 *   can extend a match up to 3 characters past the base piece's end.
 */
const PREFIX_LOOKAHEAD_MARGIN = 3
const COMPARE_CHUNK = 512

const EMPTY_STATE: State = { text: '', pieces: [], count: 0 }

function isLowSurrogateAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return false
  }
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Longest common prefix length, compared in chunks so long shared prefixes
 * stay cheap. Never splits a surrogate pair: if either string continues a
 * pair across the boundary, the boundary is moved back.
 */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix + COMPARE_CHUNK <= max) {
    if (
      a.slice(prefix, prefix + COMPARE_CHUNK) !==
      b.slice(prefix, prefix + COMPARE_CHUNK)
    ) {
      break
    }
    prefix += COMPARE_CHUNK
  }
  const limit = Math.min(max, prefix + COMPARE_CHUNK)
  while (prefix < limit && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix++
  }
  while (
    prefix > 0 &&
    (isLowSurrogateAt(a, prefix) || isLowSurrogateAt(b, prefix))
  ) {
    prefix--
  }
  return prefix
}

/**
 * Longest common suffix length (capped at `cap`), never splitting a
 * surrogate pair at the suffix start.
 */
function commonSuffixLength(a: string, b: string, cap: number): number {
  const max = Math.min(a.length, b.length, cap)
  let suffix = 0
  while (suffix + COMPARE_CHUNK <= max) {
    if (
      a.slice(a.length - suffix - COMPARE_CHUNK, a.length - suffix) !==
      b.slice(b.length - suffix - COMPARE_CHUNK, b.length - suffix)
    ) {
      break
    }
    suffix += COMPARE_CHUNK
  }
  const limit = Math.min(max, suffix + COMPARE_CHUNK)
  while (
    suffix < limit &&
    a.charCodeAt(a.length - suffix - 1) === b.charCodeAt(b.length - suffix - 1)
  ) {
    suffix++
  }
  while (
    suffix > 0 &&
    (isLowSurrogateAt(a, a.length - suffix) ||
      isLowSurrogateAt(b, b.length - suffix))
  ) {
    suffix--
  }
  return suffix
}

/** Index of the piece starting exactly at `start`, or -1. */
function findPieceStartingAt(pieces: Piece[], start: number): number {
  let lo = 0
  let hi = pieces.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const pieceStart = pieces[mid]!.start
    if (pieceStart === start) {
      return mid
    }
    if (pieceStart < start) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return -1
}

class EditorUndoCounter implements IncrementalTokenCounter {
  /**
   * Private clones (same source and flags) of the encoding's regexes so the
   * shared instances used by encode/countTokens are never disturbed.
   */
  private specialTokensScan: RegExp
  private splitRegex: RegExp
  private countPieceTokens: (piece: string) => number
  private pieceCache = new Map<string, number>()
  private current: State = EMPTY_STATE
  /** Oldest first; the last entry is the most recent state (=== current). */
  private ring: State[] = []

  constructor(encoding: GptEncoding) {
    const { specialTokensScan, tokenSplitRegex, countPieceTokens } =
      encoding.getIncrementalCountingSupport()
    this.specialTokensScan = new RegExp(
      specialTokensScan.source,
      specialTokensScan.flags,
    )
    this.splitRegex = new RegExp(tokenSplitRegex.source, tokenSplitRegex.flags)
    this.countPieceTokens = countPieceTokens
  }

  count(): number {
    return this.current.count
  }

  reset(): void {
    this.current = EMPTY_STATE
    this.ring.length = 0
    this.pieceCache.clear()
  }

  update(text: string): number {
    return this.setNewText(text)
  }

  applyEdit(start: number, deleteCount: number, insert: string): number {
    const { text } = this.current
    return this.setNewText(
      text.slice(0, start) + insert + text.slice(start + deleteCount),
    )
  }

  private setNewText(next: string): number {
    if (next === this.current.text) {
      return this.current.count
    }

    // Editor undo pattern: landing exactly on a recent snapshot costs one
    // string compare and no BPE at all. Ring texts are pre-validated, so
    // they cannot contain special tokens.
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const entry = this.ring[i]!
      if (entry.text === next) {
        this.ring.splice(i, 1)
        this.ring.push(entry)
        this.current = entry
        return entry.count
      }
    }

    // Mirror countTokens' default special-token policy: any special token
    // found in the text is disallowed and throws before any counting.
    const specialMatch = this.specialTokensScan.exec(next)
    if (specialMatch !== null) {
      throw new Error(`Disallowed special token found: ${specialMatch[0]}`)
    }

    const state = this.rebuild(next)
    this.current = state
    this.ring.push(state)
    if (this.ring.length > RING_CAPACITY) {
      this.ring.shift()
    }
    return state.count
  }

  /** Picks the snapshot sharing the longest prefix with `next`. */
  private selectBase(next: string): { base: State; prefix: number } {
    let best = EMPTY_STATE
    let bestPrefix = 0
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const candidate = this.ring[i]!
      const prefix = commonPrefixLength(candidate.text, next)
      if (prefix > bestPrefix) {
        best = candidate
        bestPrefix = prefix
      }
      // The candidate is a prefix of `next`, or all but a tail window
      // matches: no older snapshot can be a materially better base.
      if (
        bestPrefix >= candidate.text.length ||
        bestPrefix >= next.length - COMPARE_CHUNK
      ) {
        break
      }
    }
    return { base: best, prefix: bestPrefix }
  }

  /**
   * Rebuilds the piece decomposition of `next` by reusing the stable
   * prefix/suffix pieces of the closest snapshot and recomputing only the
   * dirty window in between (lookahead- and `$`-safe by construction):
   *
   * - pieces whose match (plus the lookahead character and any contraction
   *   suffix it could have consumed) ends well before the common prefix are
   *   copied verbatim;
   * - matching restarts at the last such boundary and runs over the rest of
   *   the text (so `$` still means end of text);
   * - once a match boundary inside the common suffix lines up with a base
   *   piece boundary, everything from there on is copied from the base
   *   (shifted by the length delta), because the remaining strings are
   *   identical and the regex has no lookbehind.
   */
  private rebuild(next: string): State {
    const { base, prefix } = this.selectBase(next)
    const baseText = base.text
    const basePieces = base.pieces
    const suffix = commonSuffixLength(
      baseText,
      next,
      Math.min(baseText.length, next.length) - prefix,
    )
    const delta = next.length - baseText.length

    const pieces: Piece[] = []
    let count = 0

    let copyIndex = 0
    while (
      copyIndex < basePieces.length &&
      basePieces[copyIndex]!.end + PREFIX_LOOKAHEAD_MARGIN <= prefix
    ) {
      const piece = basePieces[copyIndex]!
      pieces.push(piece)
      count += piece.count
      copyIndex++
    }
    const matchStart = copyIndex === 0 ? 0 : basePieces[copyIndex - 1]!.end

    if (matchStart < next.length) {
      // Ends at the end of `next`, so the final lookahead and the `$`
      // alternative behave exactly like countNative's matchAll.
      const tail = next.slice(matchStart)
      const suffixStartInNext = next.length - suffix
      const regex = this.splitRegex
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = regex.exec(tail)) !== null) {
        const absoluteStart = matchStart + match.index
        if (absoluteStart >= suffixStartInNext) {
          const resyncIndex = findPieceStartingAt(
            basePieces,
            absoluteStart - delta,
          )
          if (resyncIndex !== -1) {
            for (let k = resyncIndex; k < basePieces.length; k++) {
              const piece = basePieces[k]!
              pieces.push({
                start: piece.start + delta,
                end: piece.end + delta,
                count: piece.count,
              })
              count += piece.count
            }
            return { text: next, pieces, count }
          }
        }

        const pieceText = match[0]
        let pieceCount = this.pieceCache.get(pieceText)
        if (pieceCount === undefined) {
          pieceCount = this.countPieceTokens(pieceText)
          if (this.pieceCache.size >= PIECE_CACHE_LIMIT) {
            this.pieceCache.clear()
          }
          this.pieceCache.set(pieceText, pieceCount)
        }
        pieces.push({
          start: absoluteStart,
          end: absoluteStart + pieceText.length,
          count: pieceCount,
        })
        count += pieceCount
      }
    }

    return { text: next, pieces, count }
  }
}
