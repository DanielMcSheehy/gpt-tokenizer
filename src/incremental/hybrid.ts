import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  update(text: string): number
  applyEdit(start: number, deleteCount: number, insert: string): number
  count(): number
  reset(): void
}

export interface HybridPathCounts {
  append: number
  dirty: number
  full: number
}

/**
 * The required interface plus one additive accessor that lets benchmarks
 * report how edits were dispatched between the internal paths.
 */
export interface HybridIncrementalTokenCounter extends IncrementalTokenCounter {
  getPathCounts(): HybridPathCounts
}

/**
 * The split regexes used by this library decide where a piece ends using at
 * most one character of lookahead past the piece (the whitespace alternative
 * `(?!\P{White_Space})` sheds exactly one trailing character, and `$` only
 * fires at the very end of the segment). A piece whose end lies at least this
 * many characters before an edit therefore produces the identical match in
 * the edited text, which is what makes prefix reuse sound.
 */
const STABILITY_MARGIN = 2

/**
 * The dirty-window path only pays off when the edit touches a small fraction
 * of the tracked text.
 */
const DIRTY_EDIT_FRACTION = 0.25

interface LexedPieces {
  starts: number[]
  counts: number[]
  total: number
}

/**
 * Tracks a text and its token count, updating only the pieces an edit can
 * reach. Every count returned equals `encoding.countTokens` of the tracked
 * text under the encoding's default special-token policy, including thrown
 * errors on disallowed special tokens.
 *
 * Three internal paths are dispatched between:
 * 1. append/backspace: one tracked text is a prefix of the other; re-lex only
 *    from the start of the last affected piece.
 * 2. dirty window: the edit covers less than 25% of the previous text;
 *    re-lex a bounded window and stitch it to the untouched prefix and suffix.
 * 3. full recount: large edits, or any structural safety-check failure.
 */
export function createIncrementalCounter(
  encoding: GptEncoding,
): HybridIncrementalTokenCounter {
  const support = encoding.getIncrementalCountingSupport()

  // Private regex clones so lastIndex bookkeeping can never leak into (or
  // from) the encoding's own stateful regexes.
  const splitRegex = new RegExp(
    support.tokenSplitRegex.source,
    support.tokenSplitRegex.flags,
  )
  const specialRegexSource = support.disallowedSpecialRegex
  const specialRegex =
    specialRegexSource === undefined
      ? undefined
      : new RegExp(
          specialRegexSource.source,
          specialRegexSource.flags.includes('g')
            ? specialRegexSource.flags
            : `${specialRegexSource.flags}g`,
        )
  const maxSpecialTokenLength = support.maxSpecialTokenLength
  const countPiece = support.countPiece

  let text = ''
  let starts: number[] = []
  let counts: number[] = []
  let total = 0
  // False when the split regex does not cover the tracked text contiguously
  // (no known encoding produces this). Counting stays exact via full recounts.
  let cleanlySegmented = true

  const pathCounts: HybridPathCounts = { append: 0, dirty: 0, full: 0 }

  const pieceEnd = (index: number): number =>
    index + 1 < starts.length ? starts[index + 1]! : text.length

  const sumCounts = (from: number, until: number): number => {
    let sum = 0
    for (let i = from; i < until; i++) {
      sum += counts[i]!
    }
    return sum
  }

  /** Index of the first piece whose end is at or after `threshold`. */
  const firstPieceEndingAtOrAfter = (threshold: number): number => {
    let low = 0
    let high = starts.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (pieceEnd(mid) >= threshold) {
        high = mid
      } else {
        low = mid + 1
      }
    }
    return low
  }

  /** Whether `position` is the start of a tracked piece (binary search). */
  const findPieceStartingAt = (position: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const start = starts[mid]!
      if (start === position) {
        return mid
      }
      if (start < position) {
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return -1
  }

  /**
   * Lex `source.slice(from)` into pieces, counting each one exactly like
   * `countNative` does. Returns null when the matches do not cover the region
   * contiguously, which disqualifies the result from piece stitching.
   */
  const lexTail = (source: string, from: number): LexedPieces | null => {
    const tail = from === 0 ? source : source.slice(from)
    const pieceStarts: number[] = []
    const pieceCounts: number[] = []
    let total = 0
    let expected = 0
    for (const match of tail.matchAll(splitRegex)) {
      const index = match.index ?? 0
      if (index !== expected) {
        return null
      }
      const piece = match[0]
      const pieceCount = countPiece(piece)
      pieceStarts.push(from + index)
      pieceCounts.push(pieceCount)
      total += pieceCount
      expected = index + piece.length
    }
    if (expected !== tail.length) {
      return null
    }
    return { starts: pieceStarts, counts: pieceCounts, total }
  }

  /**
   * Longest common prefix/suffix of `previous` and `next`. The suffix is
   * clamped so the two regions never overlap.
   */
  const diffPrefixSuffix = (
    previous: string,
    next: string,
  ): [prefixLength: number, suffixLength: number] => {
    const minLength = Math.min(previous.length, next.length)
    let prefix = 0
    while (
      prefix < minLength &&
      previous.charCodeAt(prefix) === next.charCodeAt(prefix)
    ) {
      prefix++
    }
    let suffix = 0
    const maxSuffix = minLength - prefix
    while (
      suffix < maxSuffix &&
      previous.charCodeAt(previous.length - 1 - suffix) ===
        next.charCodeAt(next.length - 1 - suffix)
    ) {
      suffix++
    }
    return [prefix, suffix]
  }

  /**
   * Mirrors the special-token gate of `countTokens` under the default policy:
   * any special token anywhere throws. Since the previously tracked text is
   * known to be free of special tokens, a new occurrence must overlap the
   * edited region, so only a window around it has to be scanned. The leftmost
   * match in that window is the leftmost match overall, keeping the thrown
   * message identical.
   */
  const throwIfDisallowedSpecial = (
    candidate: string,
    prefixLength: number,
    suffixLength: number,
  ): void => {
    if (!specialRegex) {
      return
    }
    if (maxSpecialTokenLength === 0) {
      // Degenerate special-token set: the pattern can match the empty string,
      // so fall back to the exact whole-text check countTokens performs.
      const match = candidate.match(specialRegex)
      if (match !== null) {
        throw new Error(`Disallowed special token found: ${match[0]}`)
      }
      return
    }
    const scanFrom = Math.max(0, prefixLength - maxSpecialTokenLength + 1)
    const scanTo = Math.min(
      candidate.length,
      candidate.length - suffixLength + maxSpecialTokenLength,
    )
    if (scanFrom >= scanTo) {
      return
    }
    const window = candidate.slice(scanFrom, scanTo)
    specialRegex.lastIndex = 0
    const match = specialRegex.exec(window)
    if (match !== null) {
      throw new Error(`Disallowed special token found: ${match[0]}`)
    }
  }

  /**
   * Path 1: the new text and the old one share a full prefix (pure append or
   * pure backspace). Only the trailing pieces whose end reaches within
   * STABILITY_MARGIN of the cut point can change, so the text is re-lexed
   * from the start of the earliest such piece. Returns false on structural
   * failure so the caller can fall back to a full recount.
   */
  const prefixPath = (candidate: string, boundary: number): boolean => {
    const pieceCount = starts.length
    const firstAffected =
      pieceCount === 0
        ? 0
        : firstPieceEndingAtOrAfter(boundary - STABILITY_MARGIN)
    const relexFrom = pieceCount === 0 ? 0 : starts[firstAffected]!
    const lexed = lexTail(candidate, relexFrom)
    if (!lexed) {
      return false
    }
    const keptTotal = sumCounts(0, firstAffected)
    starts.length = firstAffected
    counts.length = firstAffected
    for (let i = 0; i < lexed.starts.length; i++) {
      starts.push(lexed.starts[i]!)
      counts.push(lexed.counts[i]!)
    }
    total = keptTotal + lexed.total
    return true
  }

  /**
   * Path 2: small in-place edit. Re-lexes forward from the last certainly
   * stable piece boundary. At every new boundary that lies inside the
   * unchanged suffix, an aligned old piece start stitches the untouched tail
   * back on (shifted by the length delta); otherwise the lex simply runs to
   * the end of the text, which is still exact. Returns false on structural
   * failure.
   */
  const dirtyPath = (
    candidate: string,
    prefixLength: number,
    suffixLength: number,
  ): boolean => {
    const oldLength = text.length
    const newLength = candidate.length
    const delta = newLength - oldLength
    const firstAffected = firstPieceEndingAtOrAfter(
      prefixLength - STABILITY_MARGIN,
    )
    const relexFrom = starts[firstAffected]!
    const suffixStart = newLength - suffixLength

    const tail = candidate.slice(relexFrom)
    const windowStarts: number[] = []
    const windowCounts: number[] = []
    let windowTotal = 0
    let expected = 0
    let stitchIndex = -1
    let absoluteEnd = 0

    for (const match of tail.matchAll(splitRegex)) {
      const index = match.index ?? 0
      if (index !== expected) {
        return false
      }
      const piece = match[0]
      const pieceCount = countPiece(piece)
      windowStarts.push(relexFrom + index)
      windowCounts.push(pieceCount)
      windowTotal += pieceCount
      expected = index + piece.length
      absoluteEnd = relexFrom + expected
      if (absoluteEnd >= suffixStart) {
        const mapped = absoluteEnd - delta
        const indexInOld =
          mapped >= 0 && mapped <= oldLength ? findPieceStartingAt(mapped) : -1
        if (indexInOld >= firstAffected) {
          stitchIndex = indexInOld
          break
        }
      }
    }
    if (stitchIndex < 0 && expected !== tail.length) {
      // No stitch fired, so the window must have covered the whole text.
      return false
    }

    const keptTotal = sumCounts(0, firstAffected)
    if (stitchIndex >= 0) {
      const tailStarts: number[] = []
      const tailCounts: number[] = []
      let tailTotal = 0
      for (let i = stitchIndex; i < starts.length; i++) {
        tailStarts.push(starts[i]! + delta)
        tailCounts.push(counts[i]!)
        tailTotal += counts[i]!
      }
      starts.length = firstAffected
      counts.length = firstAffected
      for (let i = 0; i < windowStarts.length; i++) {
        starts.push(windowStarts[i]!)
        counts.push(windowCounts[i]!)
      }
      for (let i = 0; i < tailStarts.length; i++) {
        starts.push(tailStarts[i]!)
        counts.push(tailCounts[i]!)
      }
      total = keptTotal + windowTotal + tailTotal
      return true
    }

    starts.length = firstAffected
    counts.length = firstAffected
    for (let i = 0; i < windowStarts.length; i++) {
      starts.push(windowStarts[i]!)
      counts.push(windowCounts[i]!)
    }
    total = keptTotal + windowTotal
    return true
  }

  /**
   * Path 3: re-lex everything. Exact by construction: it sums the same
   * matchAll pieces countNative sums.
   */
  const fullPath = (candidate: string): void => {
    const lexed = lexTail(candidate, 0)
    if (lexed) {
      starts = lexed.starts
      counts = lexed.counts
      total = lexed.total
      cleanlySegmented = true
      return
    }
    // The split regex leaves a gap somewhere (no known encoding does).
    // Count exactly like countNative: gap characters contribute no tokens,
    // and piece stitching is disabled until the text changes again.
    starts = []
    counts = []
    let recount = 0
    for (const match of candidate.matchAll(splitRegex)) {
      recount += countPiece(match[0])
    }
    total = recount
    cleanlySegmented = false
  }

  const performEdit = (candidate: string): number => {
    if (candidate === text) {
      return total
    }
    const oldLength = text.length
    const newLength = candidate.length
    const [prefixLength, suffixLength] = diffPrefixSuffix(text, candidate)
    // Must run before any state is touched: a rejected edit leaves the
    // tracked text and count unchanged.
    throwIfDisallowedSpecial(candidate, prefixLength, suffixLength)

    const changedOld = oldLength - prefixLength - suffixLength
    const changedNew = newLength - prefixLength - suffixLength

    let path: keyof HybridPathCounts
    let succeeded: boolean
    if (!cleanlySegmented) {
      path = 'full'
      succeeded = false
    } else if (
      (prefixLength === oldLength && newLength >= oldLength) ||
      (prefixLength === newLength && newLength < oldLength)
    ) {
      // One text is a prefix of the other: append or backspace.
      path = 'append'
      succeeded = prefixPath(candidate, Math.min(oldLength, newLength))
    } else if (
      oldLength > 0 &&
      changedOld + changedNew < DIRTY_EDIT_FRACTION * oldLength
    ) {
      path = 'dirty'
      succeeded = dirtyPath(candidate, prefixLength, suffixLength)
    } else {
      path = 'full'
      succeeded = false
    }

    if (!succeeded) {
      path = 'full'
      fullPath(candidate)
    }
    pathCounts[path] += 1
    text = candidate
    return total
  }

  const counter = {
    update(next: string): number {
      return performEdit(next)
    },
    applyEdit(start: number, deleteCount: number, insert: string): number {
      return performEdit(
        text.slice(0, start) + insert + text.slice(start + deleteCount),
      )
    },
    count(): number {
      return total
    },
    reset(): void {
      text = ''
      starts = []
      counts = []
      total = 0
      cleanlySegmented = true
    },
    /** How many edits were served by each internal path so far. */
    getPathCounts(): HybridPathCounts {
      return { ...pathCounts }
    },
  }
  return counter
}
