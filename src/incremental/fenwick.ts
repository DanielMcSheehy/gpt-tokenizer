import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  /**
   * Replaces the tracked text entirely and returns the new token count.
   * Throws exactly like `encoding.countTokens` does when the text contains a
   * disallowed special token.
   */
  update(text: string): number
  /**
   * Applies a splice-style edit to the tracked text and returns the new token
   * count. `start` and `deleteCount` are JavaScript UTF-16 indexes with the
   * same clamping behavior as `String.prototype.slice`, and the result always
   * equals `encoding.countTokens` of the resulting text, including thrown
   * errors on disallowed special tokens.
   */
  applyEdit(start: number, deleteCount: number, insert: string): number
  /** Returns the token count of the currently tracked text. */
  count(): number
  /** Forgets the tracked text and resets the internal structures. */
  reset(): void
  /**
   * Optional extension: returns whether the tracked text stays within
   * `limit` tokens, mirroring `encoding.isWithinTokenLimit(text, limit)`.
   * Returns false as soon as a prefix of already-counted pieces exceeds the
   * limit, without examining the remaining pieces.
   */
  withinLimit?(limit: number): boolean
}

const WHITE_SPACE_CHAR = /\p{White_Space}/u
const LETTER_CHAR = /\p{L}/u
const NUMBER_CHAR = /\p{N}/u

const EMPTY_ARRAY: number[] = []

type CharKind = 'letter' | 'digit' | 'punct' | 'ws-newline' | 'ws-other'

function charKind(codePoint: number): CharKind {
  if (codePoint === /* \r */ 0x0d || codePoint === /* \n */ 0x0a) {
    return 'ws-newline'
  }
  const ch = String.fromCodePoint(codePoint)
  if (WHITE_SPACE_CHAR.test(ch)) {
    return 'ws-other'
  }
  if (LETTER_CHAR.test(ch)) {
    return 'letter'
  }
  if (NUMBER_CHAR.test(ch)) {
    return 'digit'
  }
  return 'punct'
}

/**
 * Whether two adjacent code points could ever end up inside the same split
 * piece, for any of the supported token split regexes. When this returns
 * false, the position between the two characters is a hard piece boundary in
 * every possible split, so pieces on either side can be reused independently.
 *
 * The mapping is deliberately conservative: unknown or unpaired characters
 * (including lone surrogates) classify as punctuation, which only ever
 * widens the dirty window, never narrows it.
 */
function canSharePiece(before: CharKind, after: CharKind): boolean {
  if (before === after) {
    return true
  }
  const isWhiteSpace = (kind: CharKind) =>
    kind === 'ws-newline' || kind === 'ws-other'
  if (isWhiteSpace(before) && isWhiteSpace(after)) {
    return true
  }
  if (before === 'punct') {
    // word-prefix character or contraction suffix before letters,
    // or a `[\r\n]*` / `[\r\n/]*` punctuation tail
    return after === 'letter' || after === 'ws-newline'
  }
  if (before === 'letter') {
    // contraction suffix, e.g. "don't"
    return after === 'punct'
  }
  if (before === 'ws-other') {
    // optional space/word-prefix before words, punctuation or digits
    return after === 'letter' || after === 'punct' || after === 'digit'
  }
  return false
}

/** Reads the code point that starts at a (code-point aligned) position. */
function codePointAt(text: string, index: number): number {
  return text.codePointAt(index) ?? 0
}

/**
 * Whether the boundary just before `index` is safe for splicing: no piece of
 * any split of this text can straddle it.
 */
function isSafeBoundary(text: string, index: number): boolean {
  return !canSharePiece(
    charKind(codePointAt(text, index - 1)),
    charKind(codePointAt(text, index)),
  )
}

const PIECE_COUNT_CACHE_LIMIT = 16_384

/**
 * Fenwick (binary indexed) tree over per-piece values.
 *
 * Pieces are the consecutive matches of the encoding's token split regex over
 * the tracked text. One tree indexes piece lengths (UTF-16 units), turning a
 * character offset into a piece index in O(log n); the other indexes per-piece
 * token counts, so the total count is a single prefix query. Piece values are
 * only ever derived from BPE-encoding that single piece, so an edit updates
 * the affected range of pieces without re-encoding the rest of the prompt.
 */
class FenwickTree {
  private tree = new Int32Array(0)
  private size = 0

  rebuild(values: ArrayLike<number>): void {
    const n = values.length
    const tree = new Int32Array(n + 1)
    for (let i = 0; i < n; i++) {
      tree[i + 1] = values[i]!
    }
    for (let i = 1; i <= n; i++) {
      const parent = i + (i & -i)
      if (parent <= n) {
        tree[parent] = tree[parent]! + tree[i]!
      }
    }
    this.tree = tree
    this.size = n
  }

  /** Adds `delta` to the element at 0-based index `index`. */
  update(index: number, delta: number): void {
    const n = this.size
    for (let i = index + 1; i <= n; i += i & -i) {
      this.tree[i] = this.tree[i]! + delta
    }
  }

  /** Returns the sum of the first `k` elements (0 <= k <= size). */
  query(k: number): number {
    let sum = 0
    for (; k > 0; k -= k & -k) {
      sum += this.tree[k]!
    }
    return sum
  }

  /**
   * Returns the number of leading elements whose cumulative sum is <= target.
   * With strictly positive values this is the 0-based index of the first
   * element whose cumulative sum exceeds `target`.
   */
  countPrefixUpTo(target: number): number {
    let pos = 0
    let acc = 0
    let bit = 1
    while (bit <= this.size) {
      bit <<= 1
    }
    for (bit >>= 1; bit > 0; bit >>= 1) {
      const next = pos + bit
      if (next <= this.size && acc + this.tree[next]! <= target) {
        pos = next
        acc += this.tree[next]!
      }
    }
    return pos
  }
}

/**
 * Creates an incremental token counter bound to a `GptEncoding` instance.
 *
 * The counter tracks a single text (no special tokens are permitted, matching
 * the default special-token policy of `countTokens`) as a list of regex split
 * pieces with per-piece token counts stored in Fenwick trees. Edits re-split
 * only a dirty window around the edit, so unchanged regions of the prompt are
 * never re-encoded.
 */
export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  const splitRegex = encoding.getTokenSplitRegex()

  let maxSpecialTokenLength = 0
  for (const token of encoding.getSpecialTokens()) {
    if (token.length > maxSpecialTokenLength) {
      maxSpecialTokenLength = token.length
    }
  }

  let text = ''
  let pieceLengths: number[] = []
  let pieceCounts: number[] = []
  /**
   * Whether the piece list covers the tracked text contiguously (which the
   * split regexes guarantee for any input). If an unexpected input ever broke
   * contiguity, offset-based windowing would be unsafe, so every subsequent
   * edit falls back to a full re-split while counts stay exact.
   */
  let contiguous = true
  const lengthTree = new FenwickTree()
  const countTree = new FenwickTree()
  const pieceCountCache = new Map<string, number>()

  const countPiece = (piece: string): number => {
    const cached = pieceCountCache.get(piece)
    if (cached !== undefined) {
      // Refresh recency so repeated pieces stay cached under load.
      pieceCountCache.delete(piece)
      pieceCountCache.set(piece, cached)
      return cached
    }
    // `encode` on a single split piece runs the exact same per-piece path as
    // `countNative`: a direct rank hit or a byte-pair merge through the
    // shared LRU merge cache. No token ids are retained beyond this call.
    const count = encoding.encode(piece).length
    if (pieceCountCache.size >= PIECE_COUNT_CACHE_LIMIT) {
      pieceCountCache.clear()
    }
    pieceCountCache.set(piece, count)
    return count
  }

  /**
   * Runs the same default special-token policy check as `countTokens`.
   * `encodeGenerator` performs the regex check eagerly (before the generator
   * body would run) and throws the identical error message; creating and
   * abandoning the generator does no encoding work.
   */
  const assertNoDisallowedSpecial = (candidate: string): void => {
    void encoding.encodeGenerator(candidate)
  }

  const replaceAllPieces = (newText: string): number => {
    splitRegex.lastIndex = 0
    const lengths: number[] = []
    const counts: number[] = []
    let covered = 0
    contiguous = true
    for (const match of newText.matchAll(splitRegex)) {
      const piece = match[0]
      const index = match.index ?? 0
      if (index !== covered) {
        contiguous = false
      }
      lengths.push(piece.length)
      counts.push(countPiece(piece))
      covered = index + piece.length
    }
    if (covered !== newText.length) {
      contiguous = false
    }
    pieceLengths = lengths
    pieceCounts = counts
    lengthTree.rebuild(lengths)
    countTree.rebuild(counts)
    text = newText
    return countTree.query(counts.length)
  }

  const applyEdit = (
    start: number,
    deleteCount: number,
    insert: string,
  ): number => {
    const head = text.slice(0, start)
    const tail = text.slice(start + deleteCount)
    const newText = head + insert + tail
    const editStart = head.length
    const editEnd = text.length - tail.length
    const deletedLength = editEnd - editStart
    const delta = insert.length - deletedLength

    // The tracked text is special-free, so any special token in the new text
    // must overlap the edit or straddle one of its junctions, putting it
    // within `maxSpecialTokenLength` of either side. Checking this window
    // reproduces the exact leftmost-match error of `countTokens` on the full
    // text.
    const windowStart = Math.max(0, editStart - maxSpecialTokenLength)
    const windowEnd = Math.min(
      newText.length,
      editStart + insert.length + maxSpecialTokenLength,
    )
    assertNoDisallowedSpecial(newText.slice(windowStart, windowEnd))

    if (!contiguous) {
      return replaceAllPieces(newText)
    }

    // Locate the dirty piece range. Pieces are found through the length tree:
    // `i0` is the first piece ending after the edit start, `i1` the last piece
    // starting before the edit end.
    const i0 = lengthTree.countPrefixUpTo(editStart)
    const i1 =
      editStart + deletedLength > 0
        ? lengthTree.countPrefixUpTo(editStart + deletedLength - 1)
        : -1

    // Left invalidation: the piece ending at the edit start may have matched
    // through its one-character lookahead into the edited region, so always
    // dirty at least one piece to its left. Then keep extending left until
    // the window starts at a safe boundary: a place where no piece of any
    // split (old or new) can straddle, so the piece before the window is
    // fully self-contained. This covers run-regrouping hazards such as
    // `\p{N}{1,3}` digit chunks, letter runs, contractions and whitespace
    // runs (whose pieces depend on lookahead and `$` context).
    let from = Math.max(0, i0 - 1)
    let windowNewStart = lengthTree.query(from)
    while (from > 0 && !isSafeBoundary(text, windowNewStart)) {
      from--
      windowNewStart = lengthTree.query(from)
    }

    // Right invalidation: extend until the window ends at a safe boundary
    // (or at the end of the text, where the end-of-string context is real).
    // Two hazards: a piece could straddle the boundary (run regrouping), and
    // the re-split window otherwise ends at an artificial end-of-string where
    // lookahead and `$` branches succeed vacuously — which happens exactly
    // when the window text ends with a whitespace character, so such edges
    // are never reusable either.
    let to = i1
    let windowOldEnd = to >= 0 ? lengthTree.query(to + 1) : editEnd
    while (windowOldEnd < text.length) {
      const boundary = windowOldEnd + delta
      const kindBefore = charKind(codePointAt(newText, boundary - 1))
      if (
        kindBefore !== 'ws-newline' &&
        kindBefore !== 'ws-other' &&
        isSafeBoundary(newText, boundary)
      ) {
        break
      }
      to++
      windowOldEnd = lengthTree.query(to + 1)
    }
    const windowText = newText.slice(windowNewStart, windowOldEnd + delta)

    // Re-split the dirty window. Every character must be covered by exactly
    // the returned pieces, otherwise the window cannot be spliced in.
    splitRegex.lastIndex = 0
    const newLengths: number[] = []
    const newCounts: number[] = []
    let covered = 0
    let windowContiguous = true
    for (const match of windowText.matchAll(splitRegex)) {
      const piece = match[0]
      const index = match.index ?? 0
      if (index !== covered) {
        windowContiguous = false
      }
      newLengths.push(piece.length)
      newCounts.push(countPiece(piece))
      covered = index + piece.length
    }
    if (!windowContiguous || covered !== windowText.length) {
      return replaceAllPieces(newText)
    }

    const removed = to - from + 1
    if (newLengths.length === removed) {
      // Same piece count: point-update both trees instead of rebuilding.
      for (let i = 0; i < newLengths.length; i++) {
        const oldLength = pieceLengths[from + i]!
        const newLength = newLengths[i]!
        if (oldLength !== newLength) {
          lengthTree.update(from + i, newLength - oldLength)
          pieceLengths[from + i] = newLength
        }
        const oldCount = pieceCounts[from + i]!
        const newCount = newCounts[i]!
        if (oldCount !== newCount) {
          countTree.update(from + i, newCount - oldCount)
          pieceCounts[from + i] = newCount
        }
      }
    } else {
      pieceLengths.splice(from, removed, ...newLengths)
      pieceCounts.splice(from, removed, ...newCounts)
      lengthTree.rebuild(pieceLengths)
      countTree.rebuild(pieceCounts)
    }

    text = newText
    return countTree.query(pieceCounts.length)
  }

  return {
    applyEdit,
    count: () => countTree.query(pieceCounts.length),
    reset: () => {
      text = ''
      pieceLengths = []
      pieceCounts = []
      contiguous = true
      lengthTree.rebuild(EMPTY_ARRAY)
      countTree.rebuild(EMPTY_ARRAY)
    },
    update: (newText: string) => {
      assertNoDisallowedSpecial(newText)
      return replaceAllPieces(newText)
    },
    withinLimit: (limit: number) => {
      // Early exit: stop as soon as a prefix of already-counted pieces
      // exceeds the limit; later pieces cannot reduce the partial sum.
      let partial = 0
      for (let i = 0; i < pieceCounts.length; i++) {
        partial += pieceCounts[i]!
        if (partial > limit) {
          return false
        }
      }
      return true
    },
  }
}
