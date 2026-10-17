import { describe, expect, it } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100k from '../encoding/cl100k_base.js'
import o200k from '../encoding/o200k_base.js'
import { createIncrementalCounter } from './sync-scan.js'

const encodings: [name: string, encoding: GptEncoding][] = [
  ['o200k_base', o200k],
  ['cl100k_base', cl100k],
]

const applyToString = (
  text: string,
  start: number,
  deleteCount: number,
  insert: string,
): string => text.slice(0, start) + insert + text.slice(start + deleteCount)

/** An edit computed lazily against the current text. */
type Edit = (
  text: string,
) => [start: number, deleteCount: number, insert: string]

const runEdits = (
  encoding: GptEncoding,
  counter: ReturnType<typeof createIncrementalCounter>,
  initialText: string,
  edits: Edit[],
): string => {
  let text = initialText
  expect(counter.update(text)).toBe(encoding.countTokens(text))
  for (const edit of edits) {
    const [start, deleteCount, insert] = edit(text)
    text = applyToString(text, start, deleteCount, insert)
    const expected = encoding.countTokens(text)
    expect(
      counter.applyEdit(start, deleteCount, insert),
      `after ${JSON.stringify({ start, deleteCount, insert })} → ${JSON.stringify(text)}`,
    ).toBe(expected)
    expect(counter.count()).toBe(expected)
  }
  return text
}

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
  'uniform',
  'victor',
  'whiskey',
  'xray',
  'yankee',
  'zulu',
]

const buildProse = (length: number): string => {
  let out = ''
  for (let i = 0; out.length < length; i++) {
    out += WORDS[i % WORDS.length]
    out += (i + 1) % 17 === 0 ? '\n' : ' '
  }
  return out.slice(0, length)
}

const makeRng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 0x19660d) + 0x3c6ef35f) >>> 0
    return state / 0x1_0000_0000
  }
}

const SNIPPET_PARTS = [
  ...WORDS,
  ' ',
  '  ',
  '\n',
  '\t',
  '.,!? ',
  ' - ',
  '\u0085',
  '\ufeff',
  '😀',
  '👨‍👩‍👧‍👦',
  '你好',
  '世界',
  'Über Straße',
  "'s ",
  '1234',
  '  \n  ',
]

const randomSnippet = (rng: () => number): string => {
  const length = 1 + Math.floor(rng() * 8)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += SNIPPET_PARTS[Math.floor(rng() * SNIPPET_PARTS.length)]
  }
  return out
}

const randomBase = (rng: () => number, length: number): string => {
  let out = ''
  while (out.length < length) {
    out += randomSnippet(rng)
    if (rng() < 0.2) {
      out += '\n'
    }
  }
  return out.slice(0, length)
}

const countTokensOrThrow = (
  encoding: GptEncoding,
  text: string,
): { count: number; threw: boolean } => {
  try {
    return { count: encoding.countTokens(text), threw: false }
  } catch {
    return { count: -1, threw: true }
  }
}

describe.each(encodings)('%s incremental counter', (_name, encoding) => {
  it('counts the empty string', () => {
    const counter = createIncrementalCounter(encoding)
    expect(counter.update('')).toBe(encoding.countTokens(''))
    expect(counter.count()).toBe(0)
  })

  it('matches countTokens for ascii appends, deletions and middle substitutions', () => {
    const counter = createIncrementalCounter(encoding)
    runEdits(encoding, counter, 'the quick brown fox', [
      (t) => [t.length, 0, ' jumps over'],
      (t) => [t.length, 0, ' the lazy dog.'],
      () => [4, 6, 'slow red'],
      () => [0, 4, 'A'],
      (t) => [t.indexOf('slow') + 4, 0, 'very '],
      (t) => [t.length - 8, 8, ''],
      () => [7, 1, ''],
      (t) => [t.indexOf('brown'), 5, '  '],
    ])
  })

  it('matches countTokens for edits at index 0 and at the end', () => {
    const counter = createIncrementalCounter(encoding)
    runEdits(encoding, counter, 'abcdef ghijkl mnopqr', [
      // substitute at index 0
      () => [0, 3, 'XYZ'],
      // insert at index 0
      () => [0, 0, '>> '],
      // append at the very end
      (t) => [t.length, 0, ' tail'],
      // substitute at the very end
      (t) => [t.length - 2, 2, 'ED'],
      // delete at the very end
      (t) => [t.length - 3, 3, ''],
      // delete from index 0
      () => [0, 2, ''],
    ])
  })

  it('matches countTokens for emoji and CJK (surrogate pairs)', () => {
    const counter = createIncrementalCounter(encoding)
    const family = '👨‍👩‍👧‍👦'
    runEdits(
      encoding,
      counter,
      'emoji 👨‍👩‍👧‍👦 family and 中文 characters mixed 混合 text',
      [
        // append CJK
        (t) => [t.length, 0, '你好世界'],
        // substitute a whole ZWJ emoji sequence with a single surrogate pair
        (t) => [t.indexOf(family), family.length, '🙂'],
        // insert between the halves of a surrogate pair
        (t) => [t.indexOf('🙂') + 1, 0, 'X'],
        // delete only the high surrogate of the split pair, leaving a lone
        // low surrogate
        (t) => [t.indexOf('\ud83d'), 1, ''],
        // replace half of a CJK run
        (t) => [t.indexOf('你好世界') + 2, 2, '汉字'],
      ],
    )
  })

  it('matches countTokens for whitespace insertions and deletions (lookahead and $ branches)', () => {
    const counter = createIncrementalCounter(encoding)
    runEdits(
      encoding,
      counter,
      'alpha beta   gamma\n\ndelta  epsilon\t\tzeta',
      [
        // insert inside a whitespace run (lookahead re-split)
        (t) => [t.indexOf('   gamma') + 1, 0, ' '],
        // delete one space from the run
        (t) => [t.indexOf('   gamma') + 1, 1, ''],
        // append trailing whitespace...
        (t) => [t.length, 0, '   '],
        // ...then append text after it: the run held by the $ branch
        // (cl100k) or the end lookahead (o200k) must re-split
        (t) => [t.length, 0, 'x'],
        (t) => [t.length, 0, ' tail'],
        // delete the trailing word to re-expose trailing whitespace
        (t) => [t.length - 1, 1, ''],
        // delete all trailing whitespace at once
        (t) => [
          t.replace(/\s+$/, '').length,
          (t.match(/\s+$/)?.[0].length ?? 0) as number,
          '',
        ],
        // insert a newline inside the blank-line run
        (t) => [t.indexOf('\n\n') + 1, 0, '\n'],
        // delete a newline from the run
        (t) => [t.indexOf('\n\n\n') + 1, 1, ''],
        // U+0085 and U+FEFF interplay with the White_Space property
        (t) => [t.indexOf('beta') + 4, 0, '\u0085\u0085'],
        (t) => [t.indexOf('\u0085\u0085') + 1, 1, ''],
        (t) => [t.indexOf('alpha'), 0, '\ufeff'],
        // grow a word across the end (suffix append extends the last piece)
        (t) => [t.length, 0, 'more'],
      ],
    )
  })

  it('reuses a long stable prefix across small suffix edits', () => {
    const prefix = buildProse(2000)
    const counter = createIncrementalCounter(encoding)
    let text = `${prefix} tail sentence zero`
    expect(counter.update(text)).toBe(encoding.countTokens(text))
    for (let i = 1; i <= 25; i++) {
      const oldTailLength = text.length - prefix.length
      const replacement = ` tail sentence ${i} with varying length`
      text = applyToString(text, prefix.length, oldTailLength, replacement)
      const expected = encoding.countTokens(text)
      expect(counter.applyEdit(prefix.length, oldTailLength, replacement)).toBe(
        expected,
      )
      expect(counter.count()).toBe(expected)
    }
  })

  it('reuses a long stable suffix across small prefix edits', () => {
    const suffix = buildProse(2000)
    const counter = createIncrementalCounter(encoding)
    let text = `prefix sentence zero ${suffix}`
    expect(counter.update(text)).toBe(encoding.countTokens(text))
    for (let i = 1; i <= 25; i++) {
      const oldPrefixLength = text.length - suffix.length
      const replacement = `prefix sentence ${i} different`
      text = applyToString(text, 0, oldPrefixLength, replacement)
      const expected = encoding.countTokens(text)
      expect(counter.applyEdit(0, oldPrefixLength, replacement)).toBe(expected)
      expect(counter.count()).toBe(expected)
    }
  })

  it('matches the default special-token policy, including thrown errors', () => {
    const badText = 'text with <|endoftext|> inside'
    let countTokensMessage = ''
    try {
      encoding.countTokens(badText)
    } catch (error) {
      countTokensMessage = (error as Error).message
    }
    expect(countTokensMessage).not.toBe('')

    const counter = createIncrementalCounter(encoding)
    expect(() => counter.update(badText)).toThrow(countTokensMessage)
    // state is untouched by a throwing update
    expect(counter.count()).toBe(0)

    counter.update('hello world')
    expect(() => counter.applyEdit(5, 0, '<|endoftext|>')).toThrow(
      countTokensMessage,
    )
    // state still reflects the pre-edit text after a throwing applyEdit
    expect(counter.count()).toBe(encoding.countTokens('hello world'))
    expect(counter.applyEdit(5, 0, ' beautiful')).toBe(
      encoding.countTokens('hello beautiful world'),
    )

    // text that merely looks like a special token stays countable
    const lookalike = 'not <|a-real-token|> at all'
    expect(counter.update(lookalike)).toBe(encoding.countTokens(lookalike))
  })

  it('matches countTokens over 200 seeded random edits on a ~4000 char base', () => {
    const rng = makeRng(encoding === o200k ? 0xc0ffee : 0x0badf00d)
    let text = randomBase(rng, 4000)
    const counter = createIncrementalCounter(encoding)
    expect(counter.update(text)).toBe(encoding.countTokens(text))
    for (let i = 0; i < 200; i++) {
      const previousText = text
      const start = Math.floor(rng() * (text.length + 1))
      let deleteCount = 0
      let insert = ''
      const op = rng()
      if (op < 0.35) {
        insert = randomSnippet(rng)
      } else if (op < 0.65) {
        deleteCount = Math.min(1 + Math.floor(rng() * 10), text.length - start)
      } else {
        deleteCount = Math.min(1 + Math.floor(rng() * 8), text.length - start)
        insert = randomSnippet(rng)
      }
      if (rng() < 0.03) {
        insert += '<|endoftext|>'
      }
      text = applyToString(text, start, deleteCount, insert)
      const expected = countTokensOrThrow(encoding, text)
      if (expected.threw) {
        // the counter must throw too and keep tracking the previous text
        expect(() => counter.applyEdit(start, deleteCount, insert)).toThrow()
        text = previousText
      } else {
        expect(counter.applyEdit(start, deleteCount, insert)).toBe(
          expected.count,
        )
        if (i % 20 === 0) {
          expect(counter.count()).toBe(expected.count)
        }
      }
    }
  })
})

describe('incremental counter lifecycle', () => {
  it('update replaces the tracked text', () => {
    const counter = createIncrementalCounter(o200k)
    counter.update('first text here')
    const next = 'a completely different second text'
    expect(counter.update(next)).toBe(o200k.countTokens(next))
    expect(counter.count()).toBe(o200k.countTokens(next))
  })

  it('reset clears the tracked text', () => {
    const counter = createIncrementalCounter(o200k)
    counter.update('some text to discard')
    counter.reset()
    expect(counter.count()).toBe(0)
    expect(counter.update('')).toBe(0)
    // edits after reset start from the empty string
    expect(counter.applyEdit(0, 0, 'fresh')).toBe(o200k.countTokens('fresh'))
  })

  it('tracks applyEdit sequences from an empty initial state', () => {
    const counter = createIncrementalCounter(o200k)
    let text = ''
    for (const word of [
      'build ',
      'up ',
      'a ',
      'string ',
      'piece ',
      'by ',
      'piece',
    ]) {
      text += word
      expect(counter.applyEdit(text.length - word.length, 0, word)).toBe(
        o200k.countTokens(text),
      )
    }
  })
})
