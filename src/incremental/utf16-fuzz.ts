import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  update(text: string): number
  applyEdit(start: number, deleteCount: number, insert: string): number
  count(): number
  reset(): void
}

/**
 * One regex piece of the tracked text. Ends are exclusive UTF-16 indexes.
 * `total` is the token count from the start of the text through this piece.
 */
interface CachedSpan {
  end: number
  count: number
  total: number
}

/**
 * How far past a piece end an edit can still change that piece.
 * Whitespace `+` backtracks one code unit. o200k contractions (`'ll`, `'ve`,
 * `'re`) are three code units, so the last unit sits two past the word piece.
 * Pieces that end before `editStart - PIECE_LOOKAHEAD` are reused.
 */
const PIECE_LOOKAHEAD = 2

/**
 * Dirty-window counter. Piece spans are cached. The regex runs on the full
 * string from the first unstable piece, so `$` and lookahead see real
 * context, until a piece end lands on a cached boundary in the unchanged
 * suffix.
 */
export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  return new Utf16FuzzCounter(encoding)
}

class Utf16FuzzCounter implements IncrementalTokenCounter {
  private text = ''
  private spans: CachedSpan[] = []
  private total = 0
  private invalid: string | undefined
  private readonly encoding: GptEncoding
  private readonly splitRegex: RegExp
  private readonly disallowed: RegExp | undefined
  private readonly countPiece: (piece: string) => number

  constructor(encoding: GptEncoding) {
    this.encoding = encoding
    this.splitRegex = encoding.createTokenSplitRegex()
    const disallowed = encoding.defaultDisallowedSpecialRegex()
    this.disallowed = disallowed
      ? new RegExp(disallowed.source, disallowed.flags.replaceAll('g', ''))
      : undefined
    this.countPiece = (piece) => encoding.countMergePiece(piece)
  }

  update(text: string): number {
    if (text === this.text) {
      this.throwIfInvalid()
      return this.total
    }
    const { editStart, removed, insert } = diffSplice(this.text, text)
    return this.commit(text, editStart, removed, insert)
  }

  applyEdit(start: number, deleteCount: number, insert: string): number {
    if (
      start >= 0 &&
      deleteCount >= 0 &&
      Number.isFinite(start) &&
      Number.isFinite(deleteCount)
    ) {
      const editStart = Math.min(start, this.text.length)
      const editEnd = Math.min(editStart + deleteCount, this.text.length)
      const next =
        this.text.slice(0, editStart) + insert + this.text.slice(editEnd)
      return this.commit(next, editStart, editEnd - editStart, insert)
    }

    const next =
      this.text.slice(0, start) + insert + this.text.slice(start + deleteCount)
    return this.update(next)
  }

  count(): number {
    this.throwIfInvalid()
    if (this.text.length === 0) {
      return 0
    }
    if (!this.cacheCovers(this.text.length)) {
      return this.rebuildFromScratch()
    }
    return this.total
  }

  reset(): void {
    this.text = ''
    this.spans = []
    this.total = 0
    this.invalid = undefined
  }

  private throwIfInvalid(): void {
    if (this.invalid !== undefined) {
      throw new Error(`Disallowed special token found: ${this.invalid}`)
    }
  }

  private cacheCovers(length: number): boolean {
    if (length === 0) {
      return this.spans.length === 0
    }
    return this.spans[this.spans.length - 1]?.end === length
  }

  private commit(
    next: string,
    editStart: number,
    removed: number,
    insert: string,
  ): number {
    const special = this.matchSpecial(next)
    if (special !== undefined) {
      this.text = next
      this.spans = []
      this.total = 0
      this.invalid = special
      throw new Error(`Disallowed special token found: ${special}`)
    }

    if (next === this.text) {
      this.throwIfInvalid()
      return this.total
    }

    const oldLength = next.length - insert.length + removed
    this.text = next
    this.invalid = undefined

    if (next.length === 0) {
      this.spans = []
      this.total = 0
      return 0
    }

    if (!this.cacheCovers(oldLength)) {
      return this.rebuildFromScratch()
    }

    return this.resync(editStart, removed, insert.length)
  }

  private matchSpecial(text: string): string | undefined {
    if (this.disallowed === undefined || text.length === 0) {
      return undefined
    }
    const match = text.match(this.disallowed)
    return match?.[0]
  }

  private resync(editStart: number, removed: number, inserted: number): number {
    const delta = inserted - removed
    const editEndNew = editStart + inserted
    const suffixStartOld = editStart + removed
    const prefixIndex = firstIndexWithEndAtLeast(
      this.spans,
      Math.max(0, editStart - PIECE_LOOKAHEAD),
    )
    const from = prefixIndex === 0 ? 0 : this.spans[prefixIndex - 1]!.end

    const fresh: { end: number; count: number }[] = []
    let cursor = from
    let syncIndex = -1

    while (cursor < this.text.length) {
      const piece = readPiece(
        this.splitRegex,
        this.text,
        cursor,
        this.countPiece,
      )
      if (piece === undefined) {
        return this.rebuildFromScratch()
      }
      fresh.push(piece)
      cursor = piece.end
      if (cursor >= editEndNew) {
        const oldEnd = cursor - delta
        if (oldEnd >= suffixStartOld) {
          const found = findSpanEndingAt(this.spans, oldEnd, prefixIndex)
          if (found !== -1) {
            syncIndex = found
            break
          }
        }
      }
    }

    if (cursor !== this.text.length && syncIndex === -1) {
      return this.rebuildFromScratch()
    }

    const suffix = syncIndex === -1 ? [] : this.spans.slice(syncIndex + 1)
    this.spans.length = prefixIndex
    let running = prefixIndex === 0 ? 0 : this.spans[prefixIndex - 1]!.total
    for (const piece of fresh) {
      running += piece.count
      this.spans.push({ end: piece.end, count: piece.count, total: running })
    }
    for (const span of suffix) {
      running += span.count
      this.spans.push({
        end: span.end + delta,
        count: span.count,
        total: running,
      })
    }
    this.total = running

    if (!this.cacheCovers(this.text.length)) {
      return this.rebuildFromScratch()
    }
    return this.total
  }

  private rebuildFromScratch(): number {
    const text = this.text
    const spans: CachedSpan[] = []
    let cursor = 0
    let running = 0
    while (cursor < text.length) {
      const piece = readPiece(this.splitRegex, text, cursor, this.countPiece)
      if (piece === undefined) {
        const total = this.encoding.countTokens(text)
        this.spans = [{ end: text.length, count: total, total }]
        this.total = total
        return total
      }
      running += piece.count
      cursor = piece.end
      spans.push({ end: cursor, count: piece.count, total: running })
    }
    this.spans = spans
    this.total = running
    return running
  }
}

function readPiece(
  regex: RegExp,
  text: string,
  cursor: number,
  countPiece: (piece: string) => number,
): { end: number; count: number } | undefined {
  regex.lastIndex = cursor
  const match = regex.exec(text)
  if (match === null || match.index !== cursor || match[0].length === 0) {
    return undefined
  }
  const end = match.index + match[0].length
  if (end <= cursor) {
    return undefined
  }
  return { end, count: countPiece(match[0]) }
}

function firstIndexWithEndAtLeast(
  spans: readonly CachedSpan[],
  target: number,
): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (spans[mid]!.end < target) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

function findSpanEndingAt(
  spans: readonly CachedSpan[],
  end: number,
  startIndex: number,
): number {
  let lo = startIndex
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const value = spans[mid]!.end
    if (value === end) {
      return mid
    }
    if (value < end) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return -1
}

function diffSplice(
  before: string,
  after: string,
): { editStart: number; removed: number; insert: string } {
  let prefix = 0
  const max = Math.min(before.length, after.length)
  while (
    prefix < max &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix++
  }
  let suffix = 0
  const limit = max - prefix
  while (
    suffix < limit &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++
  }
  const removed = before.length - prefix - suffix
  const insert =
    suffix === 0
      ? after.slice(prefix)
      : after.slice(prefix, after.length - suffix)
  return { editStart: prefix, removed, insert }
}
