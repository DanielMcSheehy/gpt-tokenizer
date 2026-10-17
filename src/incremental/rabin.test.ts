import { describe, expect, test } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100k_base from '../encoding/cl100k_base.js'
import o200k_base from '../encoding/o200k_base.js'
import { createIncrementalCounter } from './rabin.js'

const oracleEncodings: readonly [name: string, encoding: GptEncoding][] = [
  ['o200k_base', o200k_base],
  ['cl100k_base', cl100k_base],
]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildProse(length: number, wordOffset = 0): string {
  const words = [
    'the',
    'quick',
    'brown',
    'fox',
    'jumps',
    'over',
    'lazy',
    'dog',
    'hello',
    'world',
    'token',
    'counting',
    'rabin',
    'rolling',
    'hash',
    'pieces',
    'cache',
    'regex',
    'splitting',
    'merges',
    '42',
    '3.14',
    "don't",
    'naïve',
    'café',
    ' привет',
    '你好',
    '😀',
  ]
  let out = ''
  let index = wordOffset
  let wordCount = 0
  while (out.length < length) {
    if (wordCount > 0 && wordCount % 17 === 0) {
      out += '\n'
    } else {
      if (out.length > 0 && !out.endsWith('\n')) {
        out += ' '
      }
      out += words[index++ % words.length]!
    }
    wordCount++
  }
  return out.slice(0, length)
}

/**
 * Applies a sequence of `[start, deleteCount, insert]` edits through the
 * counter, mirroring each edit with String.prototype.slice and comparing
 * every returned count (and count()) against encoding.countTokens.
 */
function expectEditsMatch(
  encoding: GptEncoding,
  initial: string,
  edits: readonly (readonly [number, number, string])[],
): void {
  const counter = createIncrementalCounter(encoding)
  let mirror = initial
  expect(counter.update(mirror)).toBe(encoding.countTokens(mirror))
  for (const [start, deleteCount, insert] of edits) {
    mirror = mirror.slice(0, start) + insert + mirror.slice(start + deleteCount)
    const count = counter.applyEdit(start, deleteCount, insert)
    expect(count).toBe(encoding.countTokens(mirror))
    expect(counter.count()).toBe(encoding.countTokens(mirror))
  }
}

describe.each(oracleEncodings)(
  'incremental counter (%s)',
  (_name, encoding) => {
    test('empty string', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.update('')).toBe(encoding.countTokens(''))
      expect(counter.count()).toBe(0)
      expect(counter.applyEdit(0, 0, '')).toBe(encoding.countTokens(''))
      expect(counter.applyEdit(0, 0, 'hello')).toBe(
        encoding.countTokens('hello'),
      )
    })

    test('ascii append, delete and middle substitution', () => {
      const base = 'the quick brown fox jumps over the lazy dog'
      expectEditsMatch(encoding, base, [
        // append at the end
        [base.length, 0, ' and runs away'],
        // delete in the middle
        [10, 6, ''],
        // substitution in the middle
        [4, 5, 'slow'],
        // delete everything
        [0, 9999, ''],
        // type back some words
        [0, 0, 'hello world'],
        [5, 0, ' beautiful'],
        [0, 1, 'H'],
      ])
    })

    test('edit at index 0 and at the end', () => {
      const base = buildProse(600)
      expectEditsMatch(encoding, base, [
        [0, 4, 'A'],
        [0, 0, '"'],
        [base.length - 2, 2, '!!'],
        [base.length, 0, ' tail'],
        [base.length - 5, 5, ''],
        [0, 1, ''],
      ])
    })

    test('edit indexes normalize like String.prototype.slice', () => {
      const base = 'abcdefghijklmnopqrstuvwxyz'
      expectEditsMatch(encoding, base, [
        // negative start counts from the end
        [-3, 2, 'X'],
        // start beyond the length appends
        [999, 5, 'Y'],
        // huge negative start clamps to 0
        [-999, 4, 'Z'],
        // negative effective deleteCount deletes nothing
        [4, -2, 'W'],
      ])
    })

    test('emoji and CJK (surrogate pairs)', () => {
      const base =
        'hello 😀 world 你好世界 🇺🇸 flag café naïve 中文与English混合的文本 ✨🎉✨ end'
      expectEditsMatch(encoding, base, [
        // insert emoji mid-word
        [6, 0, '🙂'],
        // insert CJK
        [13, 0, '汉字'],
        // delete exactly one half of a surrogate pair (creates a lone surrogate)
        [6, 1, ''],
        // replace a range that starts inside a surrogate pair
        [7, 4, 'x'],
        // insert a lone high surrogate
        [20, 0, '\ud83d'],
        // delete the lone surrogate again
        [20, 1, ''],
        // append emoji at the end
        [base.length + 20, 0, '🚀🚀'],
        // substitute around the flag emoji
        [16, 6, '国'],
      ])
    })

    test('whitespace insertion and deletion (lookahead and trailing $)', () => {
      const base = 'alpha beta   gamma\n\ndelta    epsilon   '
      expectEditsMatch(encoding, base, [
        // insert a space in the middle of a run (lookahead re-split)
        [12, 0, ' '],
        // delete one space from a run
        [11, 1, ''],
        // collapse the whole run
        [10, 4, ' '],
        // insert a newline into a space run
        [21, 0, '\n'],
        // append after trailing whitespace (kills the trailing-run piece)
        [base.length, 0, 'x'],
        // make it trailing whitespace again
        [base.length, 1, ''],
        // extend the trailing run
        [base.length - 1, 0, '  '],
        // append a newline after trailing spaces
        [base.length + 2, 0, '\n'],
        // delete the trailing newline
        [base.length + 2, 1, ''],
        // delete all trailing whitespace at once
        [22, 99, ''],
        // new trailing run via substitution
        [5, 1, '\t'],
        [5, 0, '\u00a0'],
      ])
    })

    test('long stable prefix with a small suffix edit', () => {
      const base = buildProse(4000)
      const edits: (readonly [number, number, string])[] = []
      let length = base.length
      for (let i = 0; i < 25; i++) {
        edits.push([length - 12, 6, `word${i}`])
        length += `word${i}`.length - 6
      }
      edits.push([length - 30, 0, '   '])
      edits.push([length - 27, 0, 'x'])
      expectEditsMatch(encoding, base, edits)
    })

    test('long stable suffix with a small prefix edit', () => {
      const base = buildProse(4000, 5)
      const edits: (readonly [number, number, string])[] = []
      for (let i = 0; i < 25; i++) {
        edits.push([10 + (i % 3), 8, `pref${i}`])
      }
      edits.push([0, 0, '  '])
      edits.push([0, 2, ''])
      expectEditsMatch(encoding, base, edits)
    })

    test('default special-token policy matches countTokens, including errors', () => {
      const counter = createIncrementalCounter(encoding)
      const good = 'a perfectly normal prompt with no special tokens'
      expect(counter.update(good)).toBe(encoding.countTokens(good))

      const badTexts = [
        'text with <|endoftext|> inside',
        '<|endofprompt|>',
        'partial <|endoftext|><|endoftext|> doubled',
      ]
      for (const bad of badTexts) {
        let countTokensMessage = 'NO THROW'
        try {
          encoding.countTokens(bad)
        } catch (error) {
          countTokensMessage = (error as Error).message
        }
        // countTokens must throw for these inputs under the default policy
        expect(countTokensMessage).not.toBe('NO THROW')
        expect(() => counter.update(bad)).toThrowError(countTokensMessage)
        // state is unchanged after the rejected update
        expect(counter.count()).toBe(encoding.countTokens(good))
      }

      // partial lookalikes do not throw
      const partial = 'looks like <|endoftext but is not a token'
      expect(counter.update(partial)).toBe(encoding.countTokens(partial))

      // inserting a special token through an edit throws the same error
      const before = 'prefix <'
      expect(counter.update(before)).toBe(encoding.countTokens(before))
      let insertMessage = 'NO THROW'
      try {
        encoding.countTokens('prefix <|endoftext|>')
      } catch (error) {
        insertMessage = (error as Error).message
      }
      expect(insertMessage).not.toBe('NO THROW')
      expect(() => counter.applyEdit(8, 0, '|endoftext|>')).toThrowError(
        insertMessage,
      )
      // state is still the last good text
      expect(counter.count()).toBe(encoding.countTokens(before))
      // and further good edits keep matching
      expect(counter.applyEdit(0, 0, 'x')).toBe(
        encoding.countTokens('xprefix <'),
      )

      // deleting text so that a special token forms across the junction throws too
      const counter2 = createIncrementalCounter(encoding)
      const spread = 'a<|eXndoftext|>b'
      expect(counter2.update(spread)).toBe(encoding.countTokens(spread))
      let junctionMessage = 'NO THROW'
      try {
        encoding.countTokens('a<|endoftext|>b')
      } catch (error) {
        junctionMessage = (error as Error).message
      }
      expect(junctionMessage).not.toBe('NO THROW')
      expect(() => counter2.applyEdit(4, 1, '')).toThrowError(junctionMessage)
    })

    test('reset clears state', () => {
      const counter = createIncrementalCounter(encoding)
      counter.update(buildProse(500))
      counter.reset()
      expect(counter.count()).toBe(0)
      const fresh = 'after reset'
      expect(counter.update(fresh)).toBe(encoding.countTokens(fresh))
    })

    test('200 seeded random edits on a ~4000 character base match countTokens', () => {
      const rng = mulberry32(0x5eed_1234)
      const insertPool = [
        '',
        ' ',
        '  ',
        '\n',
        '\n\n',
        '\t',
        '\u00a0',
        'word',
        'Hello',
        "don't",
        '123',
        '3.14',
        '汉字',
        '你好世界',
        '😀',
        '🇺🇸🎉',
        '!!!',
        '...?',
        ' <|partial',
        'e',
        'AB',
      ]
      let mirror =
        buildProse(2000) + ' 😀 中英混合 ' + buildProse(1500, 11) + '   \n'
      const counter = createIncrementalCounter(encoding)
      expect(counter.update(mirror)).toBe(encoding.countTokens(mirror))
      for (let i = 0; i < 200; i++) {
        const start = Math.floor(rng() * mirror.length)
        const deleteCount = Math.floor(rng() * 16)
        const insert = insertPool[Math.floor(rng() * insertPool.length)]!
        mirror =
          mirror.slice(0, start) + insert + mirror.slice(start + deleteCount)
        const count = counter.applyEdit(start, deleteCount, insert)
        expect(count).toBe(encoding.countTokens(mirror))
        expect(counter.count()).toBe(count)
        if (i % 37 === 36) {
          // full replace must stay exact too
          expect(counter.update(mirror)).toBe(encoding.countTokens(mirror))
        }
      }
    })
  },
)
