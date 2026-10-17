import type { GptEncoding } from '../GptEncoding.js'

export interface IncrementalTokenCounter {
  /**
   * Replaces the tracked text entirely and returns the new token count.
   * Matches `encoding.countTokens(text)` for the default special-token
   * policy, including thrown errors on disallowed special tokens.
   */
  update(text: string): number
  /**
   * Applies a splice to the tracked text and returns the new token count.
   * `start` and `deleteCount` are JavaScript UTF-16 indexes with the same
   * clamping behavior as `String.prototype.slice` arguments, so the result
   * is `text.slice(0, start) + insert + text.slice(start + deleteCount)`.
   * Matches `encoding.countTokens` of the resulting text, including thrown
   * errors on disallowed special tokens.
   */
  applyEdit(start: number, deleteCount: number, insert: string): number
  /**
   * The current token count, in O(1) from the rope's subtree sums.
   */
  count(): number
  /**
   * Clears the tracked text.
   */
  reset(): void
}

/**
 * A rope leaf holds one real encoder piece: a match of the encoding's token
 * split regex, with its cached token count. Pieces are the only leaf
 * boundaries, so counts can never drift from what re-encoding the text
 * would produce.
 */
class RopeLeaf {
  readonly length: number
  readonly count: number
  readonly priority: number

  constructor(
    readonly text: string,
    count: number,
  ) {
    this.length = text.length
    this.count = count
    this.priority = Math.random()
  }
}

class RopeBranch {
  length = 0
  count = 0
  priority = 0

  constructor(
    public left: RopeNode,
    public right: RopeNode,
  ) {
    this.recompute()
  }

  recompute(): void {
    this.length = this.left.length + this.right.length
    this.count = this.left.count + this.right.count
    this.priority = Math.max(this.left.priority, this.right.priority)
  }
}

type RopeNode = RopeLeaf | RopeBranch

/**
 * Treap merge: every leaf in `left` precedes every leaf in `right`.
 * Destructive: may rewire child pointers of the given nodes.
 */
function mergeNodes(left: RopeNode, right: RopeNode): RopeNode {
  if (left.priority >= right.priority) {
    if (left instanceof RopeLeaf) {
      return new RopeBranch(left, right)
    }
    left.right = mergeNodes(left.right, right)
    left.recompute()
    return left
  }
  if (right instanceof RopeLeaf) {
    return new RopeBranch(left, right)
  }
  right.left = mergeNodes(left, right.left)
  right.recompute()
  return right
}

function merge(left: RopeNode | null, right: RopeNode | null): RopeNode | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return mergeNodes(left, right)
}

/**
 * Splits the rope at a UTF-16 index that must fall on a piece boundary.
 * Destructive towards the input tree; the caller must not reuse it.
 */
function splitAt(
  node: RopeNode | null,
  index: number,
): [RopeNode | null, RopeNode | null] {
  if (node === null || index <= 0) {
    return [null, node]
  }
  if (index >= node.length) {
    return [node, null]
  }
  if (node instanceof RopeLeaf) {
    throw new Error('Internal error: rope split inside a piece')
  }
  const leftLength = node.left.length
  if (index < leftLength) {
    const [head, tail] = splitAt(node.left, index)
    return [head, merge(tail, node.right)]
  }
  if (index > leftLength) {
    const [head, tail] = splitAt(node.right, index - leftLength)
    return [merge(node.left, head), tail]
  }
  return [node.left, node.right]
}

function buildFromLeaves(leaves: readonly RopeLeaf[]): RopeNode | null {
  if (leaves.length === 0) {
    return null
  }
  const build = (from: number, to: number): RopeNode => {
    if (to - from === 1) {
      return leaves[from]!
    }
    const mid = (from + to) >> 1
    return new RopeBranch(build(from, mid), build(mid, to))
  }
  return build(0, leaves.length)
}

function sliceTextInto(
  node: RopeNode | null,
  start: number,
  end: number,
  out: string[],
): void {
  if (node === null || end <= 0 || start >= node.length) {
    return
  }
  if (node instanceof RopeLeaf) {
    out.push(node.text.slice(Math.max(0, start), Math.min(node.length, end)))
    return
  }
  sliceTextInto(node.left, start, end, out)
  sliceTextInto(
    node.right,
    start - node.left.length,
    end - node.left.length,
    out,
  )
}

/**
 * Start offset of the piece that contains or ends at `position`: when
 * `position` is a piece boundary it belongs to the piece on the left,
 * because an edit there can extend that piece (e.g. letters joining a
 * word, or whitespace joining a trailing run).
 */
function pieceStartForEdit(root: RopeNode | null, position: number): number {
  if (root === null) {
    return 0
  }
  let node: RopeNode = root
  let base = 0
  while (node instanceof RopeBranch) {
    const boundary = base + node.left.length
    if (position < boundary) {
      node = node.left
    } else if (position > boundary) {
      base = boundary
      node = node.right
    } else {
      let last: RopeNode = node.left
      while (last instanceof RopeBranch) {
        last = last.right
      }
      return base + node.left.length - last.length
    }
  }
  return base
}

function isPieceStart(root: RopeNode | null, position: number): boolean {
  if (root === null || position < 0 || position >= root.length) {
    return false
  }
  let node: RopeNode = root
  let base = 0
  while (node instanceof RopeBranch) {
    const boundary = base + node.left.length
    if (position < boundary) {
      node = node.left
    } else if (position > boundary) {
      base = boundary
      node = node.right
    } else {
      return true
    }
  }
  return position === base
}

interface DisallowedSpecialPattern {
  regex: RegExp
  maxTokenLength: number
}

interface RelexResult {
  leaves: RopeLeaf[]
  /** End offset (in the new text) of the re-lexed span. */
  newEnd: number
}

export function createIncrementalCounter(
  encoding: GptEncoding,
): IncrementalTokenCounter {
  return new RopeIncrementalCounter(encoding)
}

class RopeIncrementalCounter implements IncrementalTokenCounter {
  private root: RopeNode | null = null
  private readonly encoding: GptEncoding
  private readonly splitRegex: RegExp
  private readonly disallowedSpecial?: DisallowedSpecialPattern

  constructor(encoding: GptEncoding) {
    this.encoding = encoding
    const split = encoding.getSplitTokenRegex()
    this.splitRegex = new RegExp(
      split.source,
      split.flags.includes('g') ? split.flags : `${split.flags}g`,
    )
    const disallowed = encoding.getDisallowedSpecialTokens()
    if (disallowed) {
      this.disallowedSpecial = {
        regex: new RegExp(disallowed.regex.source, disallowed.regex.flags),
        maxTokenLength: disallowed.maxTokenLength,
      }
    }
  }

  count(): number {
    return this.root?.count ?? 0
  }

  reset(): void {
    this.root = null
  }

  update(text: string): number {
    if (this.disallowedSpecial) {
      const match = text.match(this.disallowedSpecial.regex)
      if (match !== null) {
        throw new Error(`Disallowed special token found: ${match[0]}`)
      }
    }
    const oldLength = this.root?.length ?? 0
    const prefix = this.commonPrefixLength(text)
    const suffix = this.commonSuffixLength(
      text,
      Math.min(oldLength, text.length) - prefix,
    )
    const replaced = text.length - prefix - suffix
    return this.splice(
      prefix,
      oldLength - prefix - suffix,
      text.slice(prefix, prefix + replaced),
    )
  }

  applyEdit(start: number, deleteCount: number, insert: string): number {
    const length = this.root?.length ?? 0
    if (Number.isFinite(start) && Number.isFinite(deleteCount)) {
      const resolve = (index: number): number =>
        index < 0 ? Math.max(length + index, 0) : Math.min(index, length)
      const from = resolve(start)
      const to = resolve(start + deleteCount)
      if (to >= from) {
        return this.splice(from, to - from, insert)
      }
    }
    // Degenerate ranges (e.g. a negative deleteCount reaching back across
    // the insertion point) duplicate text; mirror String.prototype.slice
    // exactly instead of trying to express them as one splice.
    const whole = this.readText()
    return this.update(
      whole.slice(0, start) + insert + whole.slice(start + deleteCount),
    )
  }

  /**
   * Core operation: replace `oldText[s, s+deleted)` with `inserted`.
   * Requires 0 <= s <= s + deleted <= length.
   */
  private splice(s: number, deleted: number, inserted: string): number {
    if (deleted === 0 && inserted.length === 0) {
      return this.count()
    }
    this.assertNoDisallowedSpecialAroundEdit(s, deleted, inserted)

    const start = pieceStartForEdit(this.root, s)
    const { leaves, newEnd } = this.relex(start, s, deleted, inserted)

    const delta = inserted.length - deleted
    const replacedEndOld = newEnd - delta
    const [before, rest] = splitAt(this.root, start)
    const [, after] = splitAt(rest, replacedEndOld - start)
    this.root = merge(merge(before, buildFromLeaves(leaves)), after)
    return this.count()
  }

  /**
   * Re-lexes the new text from `start` (the start of the first affected old
   * piece) through the edit, stopping at the first old piece boundary at or
   * beyond the edit that the new lexing lands on exactly; if the lexing
   * never realigns, it runs to the end of the text. Chunks that do not
   * reach the end of the text are grown until they do, and pieces are only
   * accepted with enough trailing context for the regex's lookahead and `$`
   * alternatives to decide exactly as they would on the full text.
   */
  private relex(
    start: number,
    s: number,
    deleted: number,
    inserted: string,
  ): RelexResult {
    const oldLength = this.root?.length ?? 0
    const suffixStart = s + deleted
    const prefixParts: string[] = []
    sliceTextInto(this.root, start, s, prefixParts)
    const prefix = prefixParts.join('')
    const insertStart = s - start
    const insertEnd = insertStart + inserted.length

    let margin = 64
    while (true) {
      const chunkEndOld = Math.min(oldLength, suffixStart + margin)
      const atRealEnd = chunkEndOld >= oldLength
      const suffixParts: string[] = []
      sliceTextInto(this.root, suffixStart, chunkEndOld, suffixParts)
      const chunk = prefix + inserted + suffixParts.join('')
      const chunkLength = chunk.length
      const leaves: RopeLeaf[] = []
      let pos = 0
      let settled = false

      while (true) {
        if (pos === chunkLength) {
          settled = atRealEnd
          break
        }
        // Never accept boundaries or pieces whose match could still change
        // once more of the real text is visible.
        if (!atRealEnd && pos + 2 >= chunkLength) {
          break
        }
        if (
          pos >= insertEnd &&
          isPieceStart(this.root, suffixStart + (pos - insertEnd))
        ) {
          settled = true
          break
        }
        this.splitRegex.lastIndex = pos
        const match = this.splitRegex.exec(chunk)
        if (match === null) {
          if (atRealEnd) {
            // The rest of the text takes part in no match at all.
            if (pos < chunkLength) {
              leaves.push(new RopeLeaf(chunk.slice(pos), 0))
            }
            pos = chunkLength
            settled = true
          }
          break
        }
        const piece = match[0]
        const pieceEnd = match.index + piece.length
        if (!atRealEnd && pieceEnd + 2 > chunkLength) {
          break
        }
        if (match.index > pos) {
          // Characters no alternative matches (impossible for the shipped
          // split regexes, but countNative would skip them too).
          leaves.push(new RopeLeaf(chunk.slice(pos, match.index), 0))
        }
        leaves.push(new RopeLeaf(piece, this.encoding.countPieceTokens(piece)))
        pos = piece.length === 0 ? match.index + 1 : pieceEnd
      }

      if (settled) {
        return { leaves, newEnd: start + pos }
      }
      margin *= 4
    }
  }

  /**
   * The tracked text is kept free of disallowed special tokens, so a new
   * occurrence can only appear overlapping the edit. Scanning the window
   * around it finds the globally first occurrence, whose error message
   * matches `countTokens`.
   */
  private assertNoDisallowedSpecialAroundEdit(
    s: number,
    deleted: number,
    inserted: string,
  ): void {
    if (!this.disallowedSpecial) {
      return
    }
    const { regex, maxTokenLength } = this.disallowedSpecial
    const oldLength = this.root?.length ?? 0
    const newLength = oldLength - deleted + inserted.length
    const windowStart = Math.max(0, s - (maxTokenLength - 1))
    const windowEndNew = Math.min(
      newLength,
      s + inserted.length + (maxTokenLength - 1),
    )
    const windowEndOld =
      windowEndNew === newLength
        ? oldLength
        : windowEndNew - inserted.length + deleted
    const parts: string[] = []
    sliceTextInto(this.root, windowStart, s, parts)
    parts.push(inserted)
    sliceTextInto(this.root, s + deleted, windowEndOld, parts)
    const match = parts.join('').match(regex)
    if (match !== null) {
      throw new Error(`Disallowed special token found: ${match[0]}`)
    }
  }

  private readText(): string {
    const parts: string[] = []
    sliceTextInto(this.root, 0, this.root?.length ?? 0, parts)
    return parts.join('')
  }

  private commonPrefixLength(text: string): number {
    let matched = 0
    const visit = (node: RopeNode | null): boolean => {
      if (node === null) {
        return false
      }
      if (node instanceof RopeLeaf) {
        if (text.startsWith(node.text, matched)) {
          matched += node.length
          return false
        }
        const comparable = Math.min(node.length, text.length - matched)
        for (let i = 0; i < comparable; i++) {
          if (node.text.charCodeAt(i) !== text.charCodeAt(matched + i)) {
            matched += i
            return true
          }
        }
        matched += comparable
        return true
      }
      return visit(node.left) || visit(node.right)
    }
    visit(this.root)
    return matched
  }

  private commonSuffixLength(text: string, cap: number): number {
    let matched = 0
    const visit = (node: RopeNode | null): boolean => {
      if (node === null || matched >= cap) {
        return true
      }
      if (node instanceof RopeLeaf) {
        const take = Math.min(node.length, cap - matched)
        const segment =
          take === node.length ? node.text : node.text.slice(node.length - take)
        const endPosition = text.length - matched
        if (text.endsWith(segment, endPosition)) {
          matched += take
          return false
        }
        let i = take
        while (
          i > 0 &&
          node.text.charAt(node.length - i) === text.charAt(endPosition - i)
        ) {
          i--
        }
        matched += take - i
        return true
      }
      return visit(node.right) || visit(node.left)
    }
    visit(this.root)
    return Math.min(matched, cap)
  }
}
