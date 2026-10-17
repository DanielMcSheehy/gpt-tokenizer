import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  update(text: string): number
  applyEdit(start: number, deleteCount: number, insert: string): number
  count(): number
  reset(): void
  /** Updates that reused a stable prefix instead of retokenizing it. */
  readonly fastPathHits: number
  /** Updates that rebuilt the affected segment from scratch. */
  readonly segmentRescans: number
}

interface CachedPiece {
  end: number
  tokens: number
}

const whitespacePiece = /^\p{White_Space}+$/u

/**
 * Streaming counter for the common case where a prompt grows or shrinks at
 * the end. The whole string is one segment under the default special-token
 * policy (specials are disallowed and throw, matching `countTokens`).
 *
 * A reused prefix stops at the piece that touches the first changed index,
 * then walks back over the preceding whitespace run and one more piece.
 * That covers the lookahead / `$` whitespace split and a contraction or
 * letter run that can absorb the following piece. Everything after that
 * resume point is tokenized again. An edit at the start of the segment
 * rebuilds the segment.
 */
class AppendFastPathCounter implements IncrementalTokenCounter {
  private text = ''
  private pieces: CachedPiece[] = []
  private total = 0
  fastPathHits = 0
  segmentRescans = 0
  private readonly encoding: GptEncoding

  constructor(encoding: GptEncoding) {
    this.encoding = encoding
  }

  count(): number {
    return this.total
  }

  reset(): void {
    this.text = ''
    this.pieces = []
    this.total = 0
  }

  update(next: string): number {
    this.assertAllowed(next)
    if (next === this.text) {
      return this.total
    }

    const cut = commonPrefixLength(this.text, next)
    if (cut === 0 || this.pieces.length === 0) {
      return this.rebuild(next)
    }

    const resume = this.resumeIndex(cut)
    const kept: CachedPiece[] = []
    for (const piece of this.pieces) {
      if (piece.end > resume) {
        break
      }
      kept.push(piece)
    }
    if (kept.length === 0) {
      return this.rebuild(next)
    }

    const pieces = kept.slice()
    for (const piece of this.encoding.countTokenPieces(next.slice(resume))) {
      pieces.push({ end: resume + piece.end, tokens: piece.tokens })
    }
    return this.commit(next, pieces, true)
  }

  applyEdit(start: number, deleteCount: number, insert: string): number {
    const next =
      this.text.slice(0, start) + insert + this.text.slice(start + deleteCount)
    return this.update(next)
  }

  private assertAllowed(text: string): void {
    const special = this.encoding.matchDefaultDisallowedSpecial(text)
    if (special !== undefined) {
      throw new Error(`Disallowed special token found: ${special}`)
    }
  }

  private rebuild(next: string): number {
    return this.commit(next, this.encoding.countTokenPieces(next), false)
  }

  private commit(
    next: string,
    pieces: CachedPiece[],
    fastPath: boolean,
  ): number {
    let total = 0
    for (const piece of pieces) {
      total += piece.tokens
    }
    this.text = next
    this.pieces = pieces
    this.total = total
    if (fastPath) {
      this.fastPathHits++
    } else {
      this.segmentRescans++
    }
    return total
  }

  /**
   * First index of the segment that must be tokenized again.
   * `cut` is the first code unit that differs, or the end of the shorter
   * string when one text is a prefix of the other.
   */
  private resumeIndex(cut: number): number {
    const { pieces } = this
    let index = 0
    for (; index < pieces.length; index++) {
      if (pieces[index]!.end >= cut) {
        break
      }
    }
    if (index >= pieces.length) {
      index = pieces.length - 1
    }
    while (index > 0 && this.isWhitespacePiece(index - 1)) {
      index--
    }
    // One more piece: a contraction or cased letter run can swallow it.
    if (index > 0) {
      index--
      while (index > 0 && this.isWhitespacePiece(index - 1)) {
        index--
      }
    }
    return index === 0 ? 0 : pieces[index - 1]!.end
  }

  private isWhitespacePiece(index: number): boolean {
    const start = index === 0 ? 0 : this.pieces[index - 1]!.end
    return whitespacePiece.test(this.text.slice(start, this.pieces[index]!.end))
  }
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index++
  }
  return index
}

export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  return new AppendFastPathCounter(encoding)
}
