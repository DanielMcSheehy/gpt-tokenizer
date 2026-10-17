import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  update(text: string): number
  applyEdit(start: number, deleteCount: number, insert: string): number
  count(): number
  reset(): void
}

const PIECE_CACHE_SIZE = 10_000

interface CountedPiece {
  text: string
  count: number
}

/**
 * LRU of piece text to token count. Map insertion order is oldest-first.
 * Keyed per encoding object so two vocabularies never share a count.
 */
class PieceCountCache {
  private readonly entries = new Map<string, number>()

  get(piece: string): number | undefined {
    const count = this.entries.get(piece)
    if (count === undefined) return undefined
    this.entries.delete(piece)
    this.entries.set(piece, count)
    return count
  }

  set(piece: string, count: number): void {
    if (this.entries.has(piece)) {
      this.entries.delete(piece)
    } else if (this.entries.size >= PIECE_CACHE_SIZE) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(piece, count)
  }
}

const pieceCaches = new WeakMap<GptEncoding, PieceCountCache>()

function pieceCacheFor(encoding: GptEncoding): PieceCountCache {
  const existing = pieceCaches.get(encoding)
  if (existing) return existing
  const created = new PieceCountCache()
  pieceCaches.set(encoding, created)
  return created
}

function countPieces(
  pieces: readonly string[],
  previous: CountedPiece[],
  cache: PieceCountCache,
  countPiece: (piece: string) => number,
): { total: number; pieces: CountedPiece[] } {
  const nextLength = pieces.length
  const previousLength = previous.length
  let prefix = 0
  let prefixTotal = 0
  const sharedPrefix = Math.min(nextLength, previousLength)
  while (prefix < sharedPrefix && pieces[prefix] === previous[prefix]?.text) {
    prefixTotal += previous[prefix]?.count ?? 0
    prefix += 1
  }

  // Same piece list: reuse the stored objects and skip every hash lookup.
  if (prefix === nextLength && prefix === previousLength) {
    return { total: prefixTotal, pieces: previous }
  }

  let suffix = 0
  while (
    suffix < nextLength - prefix &&
    suffix < previousLength - prefix &&
    pieces[nextLength - 1 - suffix] ===
      previous[previousLength - 1 - suffix]?.text
  ) {
    suffix += 1
  }

  const counted: CountedPiece[] = []
  let total = prefixTotal
  for (let index = 0; index < prefix; index += 1) {
    const piece = previous[index]
    if (piece) counted.push(piece)
  }

  const middleEnd = nextLength - suffix
  for (let index = prefix; index < middleEnd; index += 1) {
    const pieceText = pieces[index]
    if (pieceText === undefined) continue
    let count = cache.get(pieceText)
    if (count === undefined) {
      count = countPiece(pieceText)
      cache.set(pieceText, count)
    }
    counted.push({ text: pieceText, count })
    total += count
  }

  for (let offset = suffix; offset > 0; offset -= 1) {
    const piece = previous[previousLength - offset]
    if (!piece) continue
    counted.push(piece)
    total += piece.count
  }

  return { total, pieces: counted }
}

export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  const cache = pieceCacheFor(encoding)
  let text = ''
  let pieces: CountedPiece[] = []
  let total = 0

  const replace = (next: string): number => {
    const special = encoding.matchDisallowedSpecialToken(next)
    if (special !== undefined) {
      throw new Error(`Disallowed special token found: ${special}`)
    }

    // Always rescan. Lookahead and `$` can change a piece outside the edit.
    const split = encoding.splitTokenPieces(next)
    const counted = countPieces(split, pieces, cache, (piece) =>
      encoding.countTokenizedPiece(piece),
    )
    text = next
    pieces = counted.pieces
    total = counted.total
    return total
  }

  return {
    update: replace,
    applyEdit(start: number, deleteCount: number, insert: string): number {
      return replace(
        text.slice(0, start) + insert + text.slice(start + deleteCount),
      )
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
