import type { CountingSpan } from '../BytePairEncodingCore.js'
import type { GptEncoding } from '../GptEncoding.js'

/** Lookahead margin for `(?!\P{White_Space})` and nearby boundary effects. */
const LOOKAHEAD_MARGIN = 2
/** Consecutive matching piece texts required to treat the suffix as synced. */
const SYNC_RUN = 3

export interface IncrementalTokenCounter {
  update(text: string): number
  applyEdit(start: number, deleteCount: number, insert: string): number
  count(): number
  reset(): void
}

interface PieceRecord {
  start: number
  end: number
  text: string
  count: number
  kind: 'bpe' | 'special'
  segmentEnd: number
}

export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  let text = ''
  let pieces: PieceRecord[] = []
  let total = 0

  const sumCounts = (list: PieceRecord[]): number => {
    let sum = 0
    for (const piece of list) {
      sum += piece.count
    }
    return sum
  }

  const rebuild = (next: string): number => {
    const spans = encoding.enumerateCountingSpans(next)
    text = next
    pieces = spans.map(spanToRecord)
    total = sumCounts(pieces)
    return total
  }

  const findInvalidateIndex = (editStart: number): number => {
    const margin = Math.max(0, editStart - LOOKAHEAD_MARGIN)
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i]!.end > margin) {
        return i
      }
    }
    return pieces.length
  }

  const applyEditInternal = (
    start: number,
    deleteCount: number,
    insert: string,
  ): number => {
    if (start < 0 || deleteCount < 0 || start + deleteCount > text.length) {
      throw new RangeError('applyEdit indices out of range')
    }

    const nextText =
      text.slice(0, start) + insert + text.slice(start + deleteCount)
    const delta = insert.length - deleteCount

    if (pieces.length === 0 || text.length === 0) {
      return rebuild(nextText)
    }

    // Default special-token policy: same throw behavior as countTokens.
    if (nextText.includes('<|') || text.includes('<|')) {
      return rebuild(nextText)
    }

    const invalidateIndex = findInvalidateIndex(start)
    const kept = pieces.slice(0, invalidateIndex).map((p) => ({ ...p }))

    const rescanStart =
      invalidateIndex < pieces.length ? pieces[invalidateIndex]!.start : start

    // Old suffix pieces entirely after the deleted range, shifted by delta.
    const oldSuffix: PieceRecord[] = []
    for (let i = invalidateIndex; i < pieces.length; i++) {
      const piece = pieces[i]!
      if (piece.start >= start + deleteCount) {
        oldSuffix.push({
          ...piece,
          start: piece.start + delta,
          end: piece.end + delta,
          segmentEnd: piece.segmentEnd + delta,
        })
      }
    }

    // Regex-split through end of the affected special-token segment (whole
    // string under the default no-allowed-specials policy) so `$` is correct.
    // BPE-count only until a sync point; reuse old counts afterward.
    const segmentEnd = nextText.length
    const window = nextText.slice(rescanStart, segmentEnd)
    const splitPieces = encoding.splitSegmentPieces(window, rescanStart)

    const sync = findSyncPoint(splitPieces, oldSuffix)

    const recounted: PieceRecord[] = []
    const recountUntil = sync ? sync.newIndex : splitPieces.length
    for (let i = 0; i < recountUntil; i++) {
      const piece = splitPieces[i]!
      recounted.push({
        start: piece.start,
        end: piece.end,
        text: piece.text,
        count: encoding.countSinglePiece(piece.text),
        kind: 'bpe',
        segmentEnd,
      })
    }

    const nextPieces = sync
      ? [...kept, ...recounted, ...oldSuffix.slice(sync.oldIndex)]
      : [...kept, ...recounted]

    text = nextText
    pieces = nextPieces
    total = sumCounts(pieces)
    return total
  }

  return {
    update(next: string): number {
      if (next === text) {
        return total
      }
      if (text.length === 0 || next.length === 0 || pieces.length === 0) {
        return rebuild(next)
      }

      let first = 0
      const minLen = Math.min(text.length, next.length)
      while (
        first < minLen &&
        text.charCodeAt(first) === next.charCodeAt(first)
      ) {
        first++
      }
      let backOld = text.length - 1
      let backNew = next.length - 1
      while (
        backOld >= first &&
        backNew >= first &&
        text.charCodeAt(backOld) === next.charCodeAt(backNew)
      ) {
        backOld--
        backNew--
      }
      const deleteCount = Math.max(0, backOld - first + 1)
      const insert = next.slice(first, backNew + 1)
      return applyEditInternal(first, deleteCount, insert)
    },

    applyEdit(start: number, deleteCount: number, insert: string): number {
      return applyEditInternal(start, deleteCount, insert)
    },

    count(): number {
      return total
    },

    reset(): void {
      text = ''
      pieces = []
      total = 0
    },
  }
}

function spanToRecord(span: CountingSpan): PieceRecord {
  return {
    start: span.start,
    end: span.end,
    text: span.text,
    count: span.count,
    kind: span.kind,
    segmentEnd: span.segmentEnd,
  }
}

/**
 * Sync point: SYNC_RUN consecutive piece texts match the old suffix at the
 * same absolute offsets. Unchanged text after the edit guarantees the rest
 * of the split agrees once the regex ripple settles.
 */
function findSyncPoint(
  newPieces: { start: number; end: number; text: string }[],
  oldSuffix: PieceRecord[],
): { newIndex: number; oldIndex: number } | undefined {
  if (newPieces.length < SYNC_RUN || oldSuffix.length < SYNC_RUN) {
    return undefined
  }

  for (let ni = 0; ni <= newPieces.length - SYNC_RUN; ni++) {
    for (let oi = 0; oi <= oldSuffix.length - SYNC_RUN; oi++) {
      if (newPieces[ni]!.start !== oldSuffix[oi]!.start) {
        continue
      }
      let matched = true
      for (let k = 0; k < SYNC_RUN; k++) {
        if (newPieces[ni + k]!.text !== oldSuffix[oi + k]!.text) {
          matched = false
          break
        }
      }
      if (matched) {
        return { newIndex: ni, oldIndex: oi }
      }
    }
  }

  return undefined
}
