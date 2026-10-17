import { describe, expect, test } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100k from '../encoding/cl100k_base.js'
import o200k from '../encoding/o200k_base.js'
import { EndOfText, ImStart } from '../specialTokens.js'
import {
  createIncrementalCounter,
  type IncrementalTokenCounter,
} from './piece-hash.js'

const encodings: readonly (readonly [string, GptEncoding])[] = [
  ['o200k_base', o200k],
  ['cl100k_base', cl100k],
]

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

function buildProse(targetLength: number): string {
  let text = ''
  let wordCount = 0
  let index = 0
  while (text.length < targetLength) {
    if (wordCount > 0) {
      text += wordCount % 17 === 0 ? '\n' : ' '
    }
    const word = WORDS[index % WORDS.length] ?? 'alpha'
    text += word
    if (wordCount % 23 === 0) text += ' 👋'
    if (wordCount % 29 === 0) text += '你好'
    wordCount += 1
    index += 1
  }
  return text.slice(0, targetLength)
}

function applySlice(
  text: string,
  start: number,
  deleteCount: number,
  insert: string,
): string {
  return text.slice(0, start) + insert + text.slice(start + deleteCount)
}

function errorMessage(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function expectCount(
  encoding: GptEncoding,
  counter: IncrementalTokenCounter,
  text: string,
  run: () => number,
): void {
  const failure = errorMessage(() => encoding.countTokens(text))
  if (failure !== undefined) {
    expect(errorMessage(run)).toBe(failure)
    return
  }
  const expected = encoding.countTokens(text)
  expect(run()).toBe(expected)
  expect(counter.count()).toBe(expected)
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

for (const [name, encoding] of encodings) {
  describe(name, () => {
    test('empty string', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.count()).toBe(0)
      expectCount(encoding, counter, '', () => counter.update(''))
      expectCount(encoding, counter, 'abc', () => counter.update('abc'))
      counter.reset()
      expect(counter.count()).toBe(0)
      expect(encoding.countTokens('')).toBe(0)
    })

    test('ascii append, delete, and middle substitution', () => {
      const counter = createIncrementalCounter(encoding)
      let text = "The quick brown fox jumps over the lazy dog. It's fine."
      expectCount(encoding, counter, text, () => counter.update(text))

      const appended = ' Then it rests.'
      text = applySlice(text, text.length, 0, appended)
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(text.length - appended.length, 0, appended),
      )

      const removed = ' quick'
      const removeAt = text.indexOf(removed)
      text = applySlice(text, removeAt, removed.length, '')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(removeAt, removed.length, ''),
      )

      const mid = Math.floor(text.length / 2)
      text = applySlice(text, mid, 4, 'WXYZ')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(mid, 4, 'WXYZ'),
      )
    })

    test('edit at index 0 and at the end', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'abcdefghijklmnopqrstuvwxyz'
      expectCount(encoding, counter, text, () => counter.update(text))

      text = applySlice(text, 0, 0, 'START')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(0, 0, 'START'),
      )

      text = applySlice(text, 0, 5, 'start')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(0, 5, 'start'),
      )

      const end = text.length
      text = applySlice(text, end, 0, 'END')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(end, 0, 'END'),
      )

      text = applySlice(text, text.length - 3, 3, '')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(text.length, 3, ''),
      )
    })

    test('emoji and CJK surrogate pairs', () => {
      const counter = createIncrementalCounter(encoding)
      let text = '你好👋世界🙂'
      expectCount(encoding, counter, text, () => counter.update(text))

      // 👋 is one surrogate pair. Insert another pair between 你 and 好.
      text = applySlice(text, 1, 0, '😀')
      expectCount(encoding, counter, text, () => counter.applyEdit(1, 0, '😀'))

      const wave = text.indexOf('👋')
      text = applySlice(text, wave, 2, '')
      expectCount(encoding, counter, text, () => counter.applyEdit(wave, 2, ''))

      // Split a pair: drop only the leading surrogate of 🙂.
      const smile = text.indexOf('🙂')
      text = applySlice(text, smile, 1, '')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(smile, 1, ''),
      )

      text = applySlice(text, 0, 0, '漢字')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(0, 0, '漢字'),
      )

      const stable = encoding.countTokens('hello 👋')
      counter.update('hello 👋')
      expect(encoding.countTokens('hello 👋')).toBe(stable)
    })

    test('whitespace insertion and deletion', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'hello'
      expectCount(encoding, counter, text, () => counter.update(text))

      // Trailing spaces exercise `\p{White_Space}+$` (cl100k) and the
      // final whitespace alternative (o200k).
      const edits: readonly (readonly [number, number, string])[] = [
        [5, 0, '   '],
        [8, 0, 'world'],
        [5, 3, ' '],
        [6, 0, '   '],
        [5, 1, '\n'],
        [0, 0, '  '],
        [2, 0, '\n\n'],
        [4, 1, ' \t '],
      ]

      for (const [start, deleteCount, insert] of edits) {
        text = applySlice(text, start, deleteCount, insert)
        expectCount(encoding, counter, text, () =>
          counter.applyEdit(start, deleteCount, insert),
        )
      }

      // Lookahead: grow and shrink a whitespace run that is not at the end.
      text = 'a    b'
      expectCount(encoding, counter, text, () => counter.update(text))
      text = applySlice(text, 2, 0, '   ')
      expectCount(encoding, counter, text, () => counter.applyEdit(2, 0, '   '))
      text = applySlice(text, 1, 4, ' ')
      expectCount(encoding, counter, text, () => counter.applyEdit(1, 4, ' '))

      // Appending a letter after trailing whitespace extends the previous
      // piece instead of only adding a suffix piece.
      text = 'tail   '
      expectCount(encoding, counter, text, () => counter.update(text))
      text = applySlice(text, text.length, 0, 'x')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(text.length - 1, 0, 'x'),
      )

      text = applySlice(text, 0, 0, '\u0085\uFEFF')
      expectCount(encoding, counter, text, () =>
        counter.applyEdit(0, 0, '\u0085\uFEFF'),
      )
      text = applySlice(text, 0, 2, '\n')
      expectCount(encoding, counter, text, () => counter.applyEdit(0, 2, '\n'))
    })

    test('long stable prefix with a small suffix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const prefix = buildProse(5000)
      let text = `${prefix}ALPHA`
      expectCount(encoding, counter, text, () => counter.update(text))
      for (const tail of ['beta', 'gamma!!', ' x ', 'Z']) {
        const deleteCount = text.length - prefix.length
        text = prefix + tail
        expectCount(encoding, counter, text, () =>
          counter.applyEdit(prefix.length, deleteCount, tail),
        )
      }
    })

    test('long stable suffix with a small prefix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const suffix = buildProse(5000)
      let text = `ALPHA ${suffix}`
      expectCount(encoding, counter, text, () => counter.update(text))
      for (const head of ['b', 'beta', 'QQ', 'hello']) {
        const headLength = text.length - suffix.length
        text = `${head} ${suffix}`
        expectCount(encoding, counter, text, () =>
          counter.applyEdit(0, headLength, `${head} `),
        )
      }
    })

    test('default special-token policy matches countTokens', () => {
      const counter = createIncrementalCounter(encoding)
      const safe = 'hello world'
      expectCount(encoding, counter, safe, () => counter.update(safe))

      const embedded = `hello ${EndOfText} world`
      expect(errorMessage(() => counter.update(embedded))).toBe(
        errorMessage(() => encoding.countTokens(embedded)),
      )
      expect(counter.count()).toBe(encoding.countTokens(safe))

      const insertedAt = safe.indexOf(' ')
      expect(
        errorMessage(() => counter.applyEdit(insertedAt, 0, EndOfText)),
      ).toBe(
        errorMessage(() =>
          encoding.countTokens(applySlice(safe, insertedAt, 0, EndOfText)),
        ),
      )
      expect(counter.count()).toBe(encoding.countTokens(safe))

      const both = `${ImStart} then ${EndOfText}`
      expect(errorMessage(() => counter.update(both))).toBe(
        errorMessage(() => encoding.countTokens(both)),
      )

      // Completing a special token changes the disallowed-token scan, not
      // just the piece list. A failed edit leaves the previous text in place.
      const almost = 'Say <|endoftext please'
      expectCount(encoding, counter, almost, () => counter.update(almost))
      const cut = 'Say <|endoftext'.length
      expect(errorMessage(() => counter.applyEdit(cut, 0, '|>'))).toBe(
        errorMessage(() =>
          encoding.countTokens(applySlice(almost, cut, 0, '|>')),
        ),
      )
      expect(counter.count()).toBe(encoding.countTokens(almost))

      const long = buildProse(2000)
      expectCount(encoding, counter, long, () => counter.update(long))
      expect(errorMessage(() => counter.applyEdit(100, 0, EndOfText))).toBe(
        errorMessage(() =>
          encoding.countTokens(applySlice(long, 100, 0, EndOfText)),
        ),
      )
      expect(counter.count()).toBe(encoding.countTokens(long))
    })

    test('200 seeded random edits', () => {
      const counter = createIncrementalCounter(encoding)
      const random = mulberry32(name === 'o200k_base' ? 20261016 : 20261017)
      let text = buildProse(4000)
      expectCount(encoding, counter, text, () => counter.update(text))

      const inserts = [
        'a',
        ' ',
        '  ',
        '\n',
        ' the',
        '👋',
        '你',
        '   ',
        '.\n',
        'xyz',
        '\t',
        '  x',
        'end',
        '   \n',
      ]

      for (let step = 0; step < 200; step += 1) {
        const roll = random()
        let start = Math.floor(random() * (text.length + 1))
        let deleteCount = 0
        let insert = ''
        if (text.length === 0 || roll < 0.4) {
          insert = inserts[Math.floor(random() * inserts.length)] ?? 'a'
        } else if (roll < 0.7) {
          deleteCount = 1 + Math.floor(random() * Math.min(8, text.length))
          start = Math.floor(random() * (text.length - deleteCount + 1))
        } else {
          deleteCount = 1 + Math.floor(random() * Math.min(8, text.length))
          start = Math.floor(random() * (text.length - deleteCount + 1))
          insert = inserts[Math.floor(random() * inserts.length)] ?? 'b'
        }
        text = applySlice(text, start, deleteCount, insert)
        expectCount(encoding, counter, text, () =>
          counter.applyEdit(start, deleteCount, insert),
        )
      }
    })
  })
}

test('piece cache is keyed by encoding identity', () => {
  const text = "it's a test of contractions 👋"
  const oCount = o200k.countTokens(text)
  const cCount = cl100k.countTokens(text)
  expect(oCount).not.toBe(cCount)

  const fromCl = createIncrementalCounter(cl100k)
  const fromO = createIncrementalCounter(o200k)
  expect(fromCl.update(text)).toBe(cCount)
  expect(fromO.update(text)).toBe(oCount)
  expect(fromO.count()).toBe(oCount)
  expect(fromCl.count()).toBe(cCount)
})
