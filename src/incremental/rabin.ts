import type { GptEncoding } from '../GptEncoding.js'
import { escapeRegExp } from '../util.js'

export interface IncrementalTokenCounter {
  /**
   * Replaces the tracked text and returns the new token count.
   * Matches `encoding.countTokens(text)` for the default special-token policy,
   * including thrown errors on disallowed special tokens.
   */
  update(text: string): number
  /**
   * Applies an edit to the tracked text and returns the new token count.
   * `start` and `deleteCount` are JavaScript UTF-16 indexes with the same
   * normalization as `String.prototype.slice`.
   * Matches `encoding.countTokens` of the resulting text, including thrown
   * errors on disallowed special tokens.
   */
  applyEdit(start: number, deleteCount: number, insert: string): number
  /** Returns the token count of the currently tracked text. */
  count(): number
  /** Clears all tracked state. */
  reset(): void
}

const WHITE_SPACE_CHAR = /\p{White_Space}/u

/**
 * Shared-prefix length of `a` and `b`, starting the comparison at `from`
 * (i.e. `a[0..from)` and `b[0..from)` are already known to be equal).
 *
 * This is the Rabin–Karp diffing step of the algorithm, implemented as the
 * equivalent O(n) two-pointer scan the assignment explicitly allows.
 */
function commonPrefixLen(a: string, b: string, from: number): number {
  const n = Math.min(a.length, b.length)
  let i = from
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i - from
}

/**
 * Shared-suffix length of `a` and `b`, comparing backward from the string
 * ends, capped so the suffix never overlaps a known common prefix.
 */
function commonSuffixLen(a: string, b: string, cap: number): number {
  const n = Math.min(a.length, b.length, cap)
  let i = 0
  while (
    i < n &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i++
  }
  return i
}

/** First index i in a sorted array with arr[i] >= target, searching from `lo`. */
function lowerBound(arr: number[], target: number, lo = 0): number {
  let low = lo
  let high = arr.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (arr[mid]! < target) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}

/**
 * Length of the leading run of pieces that forms a contiguous chain from
 * offset 0 (`starts[0] === 0` and `ends[i - 1] === starts[i]`), given the
 * chain is known to be intact up to (not including) `knownGoodFrom`.
 *
 * `matchAll` can in principle skip characters that match no alternative
 * (gaps). Pieces before a gap cannot all be reused, so the kept prefix is
 * capped at the chain length. For the bundled split regexes every character
 * is matchable and gaps do not occur, but the guard keeps the counter exact
 * for arbitrary regexes and for text with unpaired surrogates.
 */
function chainLength(
  starts: number[],
  ends: number[],
  knownGoodFrom: number,
): number {
  const n = starts.length
  if (n === 0) {
    return 0
  }
  let i = knownGoodFrom
  if (i === 0) {
    if (starts[0]! !== 0) {
      return 0
    }
    i = 1
  }
  while (i < n && ends[i - 1]! === starts[i]!) {
    i++
  }
  return i
}

function spliceIn(
  arr: number[],
  from: number,
  deleteCount: number,
  insert: number[],
): void {
  // Avoid spreading very large insert arrays into splice (argument-count limits).
  if (insert.length <= 256) {
    arr.splice(from, deleteCount, ...insert)
    return
  }
  const tail = arr.slice(from + deleteCount)
  arr.length = from
  for (const value of insert) {
    arr.push(value)
  }
  for (const value of tail) {
    arr.push(value)
  }
}

/**
 * Exact incremental token counting for repeated, slightly modified prompts.
 *
 * The text is kept decomposed into the pieces produced by the encoding's
 * token split regex (the same pieces `countNative` walks), each with its
 * cached token count. On an edit, the longest shared prefix and suffix
 * between the old and new text are found with an O(n) scan (the Rabin–Karp
 * diff step), giving a dirty range. The dirty range is expanded outward to a
 * safe piece boundary: at least one piece before it (plus one character of
 * lookahead, which for whitespace pieces means back to the start of the
 * whitespace run, since the split regex splits runs with a one-character
 * lookahead and matches trailing runs through `$`), and forward until the
 * re-run regex realigns with cached piece boundaries beyond the dirty range.
 * Piece counts are reused only where boundaries have been confirmed to still
 * align; otherwise the counter falls back to a full re-split (which is still
 * exact).
 */
export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  const core = encoding.getBytePairEncodingCore()
  // A private clone so stateful exec loops never disturb the shared regex.
  const splitRegex = core.createTokenSplitRegexClone()

  const specialTokens = encoding.getSpecialTokenStrings()
  const specialTokenRegex =
    specialTokens.length > 0
      ? new RegExp(`(${specialTokens.map(escapeRegExp).join('|')})`)
      : undefined
  let specialTokenMaxLen = 0
  for (const token of specialTokens) {
    specialTokenMaxLen = Math.max(specialTokenMaxLen, token.length)
  }

  // Piece decomposition of `text`. Piece i spans [starts[i], ends[i]) and is
  // worth counts[i] tokens. Pieces are exactly the matches of the split
  // regex over the whole text (the default special-token policy disallows
  // special tokens, so the text is a single segment).
  let text = ''
  let starts: number[] = []
  let ends: number[] = []
  let counts: number[] = []
  let total = 0
  let chain = 0
  let fallbackCount = 0

  const isAllWhiteSpace = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) {
      if (!WHITE_SPACE_CHAR.test(text[i]!)) {
        return false
      }
    }
    return true
  }

  /**
   * Whether the whitespace run containing position `runFrom` in the old text
   * reaches into (or up to) the dirty start `p`: every character between
   * `runFrom` and `p` is whitespace.
   */
  const whiteSpaceRunReaches = (runFrom: number, p: number): boolean => {
    for (let i = runFrom; i < p; i++) {
      if (!WHITE_SPACE_CHAR.test(text[i]!)) {
        return false
      }
    }
    return true
  }

  /**
   * Throws exactly like `GptEncoding.countTokens` when the new text contains
   * a special token under the default policy. Any special token in the new
   * text must touch the dirty range or the junction around it (the old text
   * is clean), so scanning a window of one max-token-length on either side
   * is sufficient and finds the same leftmost match as a full scan.
   */
  const assertNoSpecialTokens = (
    newText: string,
    p: number,
    dirtyEnd: number,
  ): void => {
    if (specialTokenRegex === undefined) {
      return
    }
    const from = Math.max(0, p - specialTokenMaxLen)
    const to = Math.min(newText.length, dirtyEnd + specialTokenMaxLen)
    if (from >= to) {
      return
    }
    const match = newText.slice(from, to).match(specialTokenRegex)
    if (match !== null) {
      throw new Error(`Disallowed special token found: ${match[0]}`)
    }
  }

  /** Re-splits the whole text from offset 0. Exact by construction. */
  const fullResplit = (newText: string): void => {
    const nStarts: number[] = []
    const nEnds: number[] = []
    const nCounts: number[] = []
    let sum = 0
    splitRegex.lastIndex = 0
    while (true) {
      const match = splitRegex.exec(newText)
      if (match === null) {
        break
      }
      const start = match.index
      const end = start + match[0].length
      if (end === start) {
        // Defensive: mirror matchAll's advance on empty matches.
        splitRegex.lastIndex = start + 1
        continue
      }
      const count = core.countPieceTokens(newText.slice(start, end))
      nStarts.push(start)
      nEnds.push(end)
      nCounts.push(count)
      sum += count
      splitRegex.lastIndex = end
    }
    text = newText
    starts = nStarts
    ends = nEnds
    counts = nCounts
    total = sum
    chain = chainLength(starts, ends, 0)
  }

  /**
   * Core routine: apply newText (old text + edit), reusing cached piece
   * counts outside the dirty range. `knownPrefix` is a known-valid common
   * prefix length of the old and new text (0 for a full replace).
   */
  const recount = (newText: string, knownPrefix: number): number => {
    const oldText = text
    const oldLen = oldText.length
    const newLen = newText.length
    if (oldText === newText) {
      return total
    }

    const p = knownPrefix + commonPrefixLen(newText, oldText, knownPrefix)
    const suffixCap = Math.min(oldLen, newLen) - p
    const s = suffixCap > 0 ? commonSuffixLen(newText, oldText, suffixCap) : 0
    const dirtyEndNew = newLen - s
    const dirtyEndOld = oldLen - s
    const delta = newLen - oldLen

    assertNoSpecialTokens(newText, p, dirtyEndNew)

    // Choose the kept prefix of old pieces. A piece is safe to keep only if
    // its match cannot depend on any changed character: its content plus the
    // character where its greedy match stopped must lie before p, and if it
    // is a whitespace piece, its whole whitespace run must end before p (the
    // run split depends on the run extent and one character of lookahead,
    // and cl100k matches trailing runs through `$`).
    let k = lowerBound(ends, p)
    while (
      k > 0 &&
      isAllWhiteSpace(starts[k - 1]!, ends[k - 1]!) &&
      whiteSpaceRunReaches(ends[k - 1]!, p)
    ) {
      k--
    }
    if (k > chain) {
      k = chain
    }
    const rebuildFrom = k > 0 ? ends[k - 1]! : 0

    // Re-run the split regex from rebuildFrom, collecting new pieces until
    // the scan realigns with a cached piece boundary beyond the dirty range.
    const nStarts: number[] = []
    const nEnds: number[] = []
    const nCounts: number[] = []
    let rebuildSum = 0
    let alignedOldIndex = -1
    // Old piece candidates for alignment: pieces fully past the old dirty end.
    let j = lowerBound(starts, dirtyEndOld, k)
    const dirtySpan = dirtyEndNew - p
    const allowedSpan =
      p - rebuildFrom + dirtySpan + Math.max(1024, 3 * dirtySpan)

    splitRegex.lastIndex = rebuildFrom
    while (true) {
      const match = splitRegex.exec(newText)
      if (match === null) {
        break
      }
      const mi = match.index
      const me = mi + match[0].length
      if (me === mi) {
        // Defensive: mirror matchAll's advance on empty matches.
        splitRegex.lastIndex = mi + 1
        continue
      }
      if (mi >= dirtyEndNew) {
        // Past the dirty range: look for a confirmed boundary match with a
        // cached piece (shifted by the length delta). From there on, the
        // remaining text is identical to the old suffix, so every remaining
        // cached piece is still valid.
        while (j < starts.length && starts[j]! < mi - delta) {
          j++
        }
        if (
          j < starts.length &&
          starts[j]! === mi - delta &&
          ends[j]! === me - delta
        ) {
          alignedOldIndex = j
          break
        }
        if (mi - rebuildFrom > allowedSpan) {
          // Alignment not found within budget: fall back to a full re-split.
          fallbackCount++
          fullResplit(newText)
          return total
        }
      }
      const count = core.countPieceTokens(newText.slice(mi, me))
      nStarts.push(mi)
      nEnds.push(me)
      nCounts.push(count)
      rebuildSum += count
      splitRegex.lastIndex = me
    }

    if (alignedOldIndex >= 0) {
      const jAligned = alignedOldIndex
      let removedSum = 0
      for (let i = k; i < jAligned; i++) {
        removedSum += counts[i]!
      }
      spliceIn(starts, k, jAligned - k, nStarts)
      spliceIn(ends, k, jAligned - k, nEnds)
      spliceIn(counts, k, jAligned - k, nCounts)
      // Shift the reused suffix pieces to their new offsets.
      if (delta !== 0) {
        for (let i = k + nStarts.length; i < starts.length; i++) {
          starts[i] = starts[i]! + delta
          ends[i] = ends[i]! + delta
        }
      }
      total = total - removedSum + rebuildSum
    } else {
      let removedSum = 0
      for (let i = k; i < counts.length; i++) {
        removedSum += counts[i]!
      }
      spliceIn(starts, k, starts.length - k, nStarts)
      spliceIn(ends, k, ends.length - k, nEnds)
      spliceIn(counts, k, counts.length - k, nCounts)
      total = total - removedSum + rebuildSum
    }
    text = newText
    chain = chainLength(starts, ends, k)
    return total
  }

  const counter: IncrementalTokenCounter = {
    update(newText: string): number {
      return recount(newText, 0)
    },
    applyEdit(start: number, deleteCount: number, insert: string): number {
      const head = text.slice(0, start)
      const tail = text.slice(start + deleteCount)
      return recount(head + insert + tail, head.length)
    },
    count(): number {
      return total
    },
    reset(): void {
      text = ''
      starts = []
      ends = []
      counts = []
      total = 0
      chain = 0
    },
  }
  // Diagnostic accessor for benchmarks; not part of the required interface.
  Object.defineProperty(counter, 'fallbackCount', {
    get: () => fallbackCount,
  })
  return counter
}
