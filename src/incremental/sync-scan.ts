import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  /** Replaces the tracked text and returns the new token count. */
  update(text: string): number
  /**
   * Applies an edit to the tracked text and returns the new token count.
   * `start` and `deleteCount` are JavaScript UTF-16 indexes in
   * String.prototype.slice coordinates: the resulting text equals
   * `text.slice(0, start) + insert + text.slice(start + deleteCount)`
   * for non-negative, in-range arguments.
   */
  applyEdit(start: number, deleteCount: number, insert: string): number
  /** Returns the token count of the currently tracked text. */
  count(): number
  /** Clears the tracked text and the cached piece counts. */
  reset(): void
}

interface PieceTable {
  /** Piece texts in order; together they cover the counted regions of the text. */
  texts: string[]
  /** Token count of each piece. */
  counts: number[]
  /** UTF-16 start offset of each piece (match offsets, ascending). */
  starts: number[]
  /** prefix[i] = sum of counts[0..i); prefix[prefix.length - 1] is the total. */
  prefix: number[]
}

/** Single-code-unit White_Space test, matching the split regexes' class. */
const WHITE_SPACE_RE = /\p{White_Space}/u

const isAllWhiteSpace = (piece: string): boolean => {
  for (const char of piece) {
    if (!WHITE_SPACE_RE.test(char)) {
      return false
    }
  }
  return true
}

/** Whether `newText.slice(newEnd)` === `oldText.slice(oldEnd)`. */
const rawSuffixEqual = (
  newText: string,
  newEnd: number,
  oldText: string,
  oldEnd: number,
): boolean => {
  const remaining = newText.length - newEnd
  if (remaining !== oldText.length - oldEnd) {
    return false
  }
  for (let i = 0; i < remaining; i++) {
    if (newText.charCodeAt(newEnd + i) !== oldText.charCodeAt(oldEnd + i)) {
      return false
    }
  }
  return true
}

/**
 * Number of consecutively re-lexed pieces that must line up with old pieces
 * before the (linear) raw-suffix comparison is attempted to re-sync.
 */
const SYNC_STREAK = 3

const emptyPieceTable = (): PieceTable => ({
  texts: [],
  counts: [],
  starts: [],
  prefix: [0],
})

const totalOf = (pieces: PieceTable): number =>
  pieces.prefix[pieces.prefix.length - 1]!

/**
 * Exact incremental token counting for repeatedly edited strings.
 *
 * The counter mirrors `encoding.countTokens(text)` under the default
 * special-token policy (all special tokens disallowed, so a text containing
 * one throws the same error) by tracking the split-regex pieces of the text
 * together with their token counts. After an edit it re-lexes forward from
 * the last piece boundary strictly before the edit — boundaries at or after
 * the edit cannot be trusted, because the whitespace alternatives match
 * with a one-character lookahead and some alternatives match only at the `$`
 * end of the segment. While re-lexing, it compares piece texts against the
 * old piece list shifted by the length delta, and once several pieces line
 * up AND the remaining raw suffix of the new string equals the remaining raw
 * suffix of the old one, it stops and reuses the old suffix counts.
 */
export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  const guardRegex = encoding.getDefaultDisallowedSpecialTokenRegex()
  const splitRegex = encoding.getTokenSplitRegex()
  // A private clone, so mutating lastIndex never leaks into the shared regex.
  const lexRegex = new RegExp(splitRegex.source, splitRegex.flags)

  let text = ''
  let pieces = emptyPieceTable()

  const assertNoDisallowedSpecial = (input: string): void => {
    if (!guardRegex) {
      return
    }
    const match = input.match(guardRegex)
    if (match !== null) {
      throw new Error(`Disallowed special token found: ${match[0]}`)
    }
  }

  // Lex the whole string with the same matchAll chaining countNative uses.
  const buildPieces = (input: string): PieceTable => {
    const table = emptyPieceTable()
    let total = 0
    lexRegex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = lexRegex.exec(input)) !== null) {
      if (match[0].length === 0) {
        // matchAll skips one char past a zero-length match; these split
        // regexes can never produce one, but keep the chaining identical.
        lexRegex.lastIndex = match.index + 1
        continue
      }
      const pieceCount = encoding.countSplitPieceTokens(match[0])
      table.texts.push(match[0])
      table.counts.push(pieceCount)
      table.starts.push(match.index)
      total += pieceCount
      table.prefix.push(total)
    }
    return table
  }

  const update = (newText: string): number => {
    assertNoDisallowedSpecial(newText)
    text = newText
    pieces = buildPieces(newText)
    return totalOf(pieces)
  }

  const applyEdit = (
    start: number,
    deleteCount: number,
    insert: string,
  ): number => {
    const oldText = text
    // Slice-style normalization of the edit window; on thrown errors below,
    // the tracked state is left untouched.
    let from = start
    if (from < 0) {
      from += oldText.length
    }
    from = Math.max(0, Math.min(from, oldText.length))
    const to = Math.min(from + Math.max(0, deleteCount), oldText.length)
    const newText = oldText.slice(0, from) + insert + oldText.slice(to)

    assertNoDisallowedSpecial(newText)

    const old = pieces
    if (newText === oldText) {
      return totalOf(old)
    }
    const next = resync(newText, from, to, insert, old, oldText)
    text = newText
    pieces = next
    return totalOf(next)
  }

  /**
   * Re-lex `newText` from the last safe old boundary up to a re-sync point,
   * reusing old piece counts for the untouched prefix and (when the scan
   * re-syncs) for the identical raw suffix.
   */
  const resync = (
    newText: string,
    from: number,
    to: number,
    insert: string,
    old: PieceTable,
    oldText: string,
  ): PieceTable => {
    const m = old.texts.length
    const delta = insert.length - (to - from)
    const insertEnd = from + insert.length

    // Re-lex forward from the last old piece boundary strictly before the
    // edit. A boundary at the edit start is not safe: the piece ending there
    // may have matched via the whitespace lookahead (which examined the char
    // now replaced) or via `$` (the segment may have grown). The binary
    // search counts k = number of piece starts below `from` (starts[0] is
    // always 0); the boundary we resume from is starts[k-1], the last one of
    // those, so pieces 0..k-2 — all ending before `from` — are reused.
    let k = 0
    if (from > 0 && m > 0) {
      let lo = 0
      let hi = m - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (old.starts[mid]! < from) {
          k = mid + 1
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
    }
    let relex = Math.max(k - 1, 0) // first old piece to re-lex
    // Additionally, step back over whitespace pieces that were cut short of
    // their whitespace run (the run continues at the boundary): the split
    // regexes backtrack those alternatives, so when the inserted text lets
    // the run grow into the edit, the piece re-matches with a different end.
    // Non-whitespace pieces always end at their full greedy extent, so they
    // are stable as long as the boundary sits strictly before the edit.
    while (
      relex > 0 &&
      isAllWhiteSpace(old.texts[relex - 1]!) &&
      WHITE_SPACE_RE.test(oldText[old.starts[relex]!]!)
    ) {
      relex--
    }
    const b = m === 0 ? 0 : old.starts[relex]!

    const lexedTexts: string[] = []
    const lexedCounts: number[] = []
    const lexedStarts: number[] = []
    let streak = 0
    let j = relex // next old piece to align against
    let syncAfter = -1 // reuse old pieces from this index onwards
    lexRegex.lastIndex = b
    let match: RegExpExecArray | null
    while ((match = lexRegex.exec(newText)) !== null) {
      const piece = match[0]
      if (piece.length === 0) {
        lexRegex.lastIndex = match.index + 1
        continue
      }
      const start = match.index
      const end = start + piece.length
      const pieceCount = encoding.countSplitPieceTokens(piece)
      lexedTexts.push(piece)
      lexedCounts.push(pieceCount)
      lexedStarts.push(start)

      // A piece fully before the edit aligns with the old piece at the same
      // offset; a piece fully after it aligns with the old piece shifted by
      // the length delta. Pieces straddling the inserted region align with
      // nothing.
      let alignedStart = -1
      if (end <= from) {
        alignedStart = start
      } else if (start >= insertEnd) {
        alignedStart = start - delta
      }
      if (alignedStart < 0) {
        streak = 0
      } else {
        while (j < m && old.starts[j]! < alignedStart) {
          j++
        }
        if (j < m && old.starts[j] === alignedStart && old.texts[j] === piece) {
          streak++
          // Matching piece texts alone are not enough: an old `$` match or a
          // whitespace-lookahead match is only reproduced if everything that
          // follows is also identical, so compare the remaining raw suffixes
          // before trusting the sync.
          if (
            streak >= SYNC_STREAK &&
            rawSuffixEqual(
              newText,
              end,
              oldText,
              alignedStart + old.texts[j]!.length,
            )
          ) {
            syncAfter = j + 1
            break
          }
        } else {
          streak = 0
        }
      }
    }

    const table = emptyPieceTable()
    table.texts = old.texts.slice(0, relex)
    table.counts = old.counts.slice(0, relex)
    table.starts = old.starts.slice(0, relex)
    table.texts.push(...lexedTexts)
    table.counts.push(...lexedCounts)
    table.starts.push(...lexedStarts)
    if (syncAfter >= 0) {
      table.texts.push(...old.texts.slice(syncAfter))
      table.counts.push(...old.counts.slice(syncAfter))
      for (let i = syncAfter; i < m; i++) {
        table.starts.push(old.starts[i]! + delta)
      }
    }
    let acc = 0
    table.prefix = [0]
    for (const pieceCount of table.counts) {
      acc += pieceCount
      table.prefix.push(acc)
    }
    return table
  }

  return {
    update,
    applyEdit,
    count() {
      return totalOf(pieces)
    },
    reset() {
      text = ''
      pieces = emptyPieceTable()
    },
  }
}
