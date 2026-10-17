import { describe, expect, test } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100kBase from '../encoding/cl100k_base.js'
import o200kBase from '../encoding/o200k_base.js'
import { EndOfText } from '../specialTokens.js'
import { createIncrementalCounter } from './rope.js'

const encodings = {
  o200k_base: o200kBase,
  cl100k_base: cl100kBase,
}

const WORDS = [
  'the',
  'quick',
  'brown',
  'fox',
  'jumps',
  'over',
  'a',
  'lazy',
  'dog',
  'while',
  'token',
  'models',
  'stream',
  'vectors',
  'align',
  'neatly',
  'here',
  'again',
  'soon',
  'today',
]

function prose(length: number, wordOffset = 0): string {
  let out = ''
  let i = wordOffset
  while (out.length < length) {
    out += WORDS[i % WORDS.length]!
    out += (i - wordOffset + 1) % 17 === 0 ? '\n' : ' '
    i++
  }
  return out.slice(0, length)
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Harness {
  mirror: string
  edit(start: number, deleteCount: number, insert: string): void
  replace(text: string): void
}

function createHarness(encoding: GptEncoding): Harness {
  const counter = createIncrementalCounter(encoding)
  const harness: Harness = {
    get mirror() {
      return mirror
    },
    edit(start, deleteCount, insert) {
      const next =
        mirror.slice(0, start) + insert + mirror.slice(start + deleteCount)
      let expected: number | undefined
      let error: string | undefined
      try {
        expected = encoding.countTokens(next)
      } catch (e) {
        error = (e as Error).message
      }
      if (error !== undefined) {
        expect(() => counter.applyEdit(start, deleteCount, insert)).toThrow(
          error,
        )
        return
      }
      expect(counter.applyEdit(start, deleteCount, insert)).toBe(expected)
      mirror = next
    },
    replace(text) {
      expect(counter.update(text)).toBe(encoding.countTokens(text))
      mirror = text
    },
  }
  let mirror = ''
  return harness
}

for (const [encodingName, encoding] of Object.entries(encodings)) {
  describe(`rope incremental counter (${encodingName})`, () => {
    test('counts the empty string', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.count()).toBe(0)
      expect(counter.update('')).toBe(0)
      expect(counter.count()).toBe(0)
      expect(counter.update('x')).toBe(encoding.countTokens('x'))
      expect(counter.update('')).toBe(0)
    })

    test('ascii append, delete and middle substitution', () => {
      const h = createHarness(encoding)
      h.replace('the quick brown fox')
      h.edit(h.mirror.length, 0, ' jumps over')
      h.edit(h.mirror.length, 0, ' the lazy dog again')
      h.edit(h.mirror.indexOf('quick'), 'quick'.length, 'slow')
      h.edit(h.mirror.indexOf('brown') - 1, 1, '')
      h.edit(h.mirror.indexOf('lazy'), 0, 'very ')
      h.edit(h.mirror.indexOf('dog'), 3, '')
      h.edit(h.mirror.indexOf('jumps'), 0, 'really ')
    })

    test('edits at index 0 and at the end', () => {
      const h = createHarness(encoding)
      h.replace('hello world')
      h.edit(0, 0, 'X')
      h.edit(0, 5, 'goodbye')
      h.edit(h.mirror.length, 0, '!!')
      h.edit(h.mirror.length - 2, 2, '?')
      h.edit(h.mirror.length, 0, ' again')
      h.edit(0, 0, '')
      h.edit(0, 1, '')
      h.edit(h.mirror.length - 6, 6, '.')
    })

    test('emoji and CJK surrogate pairs', () => {
      const h = createHarness(encoding)
      h.replace('hi 👨‍👩‍👧‍👦 你好世界 🌍ète done')
      h.edit(h.mirror.indexOf('你好'), 0, '😀')
      h.edit(h.mirror.indexOf('🌍'), 2, '')
      h.edit(h.mirror.indexOf('世界'), 2, '汉字测试')
      h.edit(h.mirror.length, 0, '🌍尾部')
      let pairIndex = -1
      for (let i = 0; i < h.mirror.length - 1; i++) {
        const high = h.mirror.charCodeAt(i)
        const low = h.mirror.charCodeAt(i + 1)
        if (
          high >= 0xd800 &&
          high <= 0xdbff &&
          low >= 0xdc00 &&
          low <= 0xdfff
        ) {
          pairIndex = i
          break
        }
      }
      expect(pairIndex).toBeGreaterThanOrEqual(0)
      // split a surrogate pair with an ASCII insert
      h.edit(pairIndex + 1, 0, 'x')
      // delete the lone high surrogate left behind
      h.edit(pairIndex, 1, '')
      // delete a low surrogate only
      const nextPair = h.mirror.search(/[\ud800-\udbff][\udc00-\udfff]/)
      h.edit(nextPair + 1, 1, '')
    })

    test('whitespace insertion and deletion', () => {
      const h = createHarness(encoding)
      h.replace('alpha beta   gamma\n\ndelta\t\teps')
      h.edit(h.mirror.indexOf('beta') + 'beta'.length, 0, ' ')
      h.edit(h.mirror.indexOf('gamma') - 4, 2, '')
      h.edit(h.mirror.indexOf('\n\n'), 2, '\n')
      h.edit(h.mirror.indexOf('\t\t'), 1, '')
      h.edit(0, 0, '  ')
      h.edit(0, 1, '')
      h.replace('trailing ws  ')
      h.edit(h.mirror.length, 0, ' ')
      h.edit(h.mirror.length - 2, 0, ' ')
      h.edit(h.mirror.length - 1, 1, 'x')
      h.edit(h.mirror.length, 3, '\t\n ')
      h.replace('end\n\n\n')
      h.edit(h.mirror.length - 1, 0, '\n')
      h.edit(h.mirror.length - 4, 3, 'x')
      h.replace('   \n\t  ')
      h.edit(1, 2, '')
      h.edit(h.mirror.length, 0, ' \n')
      h.replace('ab  ')
      h.edit(1, 1, '')
      h.edit(0, 0, ' ')
    })

    test('long stable prefix with small suffix edits', () => {
      const h = createHarness(encoding)
      h.replace(prose(4000))
      for (let i = 0; i < 25; i++) {
        const at = h.mirror.length - 30 - ((i * 7) % 20)
        h.edit(at, 3 + (i % 5), 'XYZ')
      }
      h.edit(h.mirror.length, 0, ' appended sentence here.')
    })

    test('long stable suffix with small prefix edits', () => {
      const h = createHarness(encoding)
      h.replace(prose(4000, 5))
      for (let i = 0; i < 25; i++) {
        h.edit(10 + ((i * 3) % 15), 4 + (i % 4), 'W')
      }
      h.edit(0, 0, 'prefix ')
    })

    test('default special-token policy matches countTokens, including errors', () => {
      const counter = createIncrementalCounter(encoding)
      counter.update('hello world')
      expect(() => encoding.countTokens(`some ${EndOfText} token`)).toThrow(
        'Disallowed special token found',
      )
      expect(() => counter.update(`some ${EndOfText} token`)).toThrow(
        `Disallowed special token found: ${EndOfText}`,
      )
      expect(counter.count()).toBe(encoding.countTokens('hello world'))
      expect(() => counter.applyEdit(5, 0, EndOfText)).toThrow(
        `Disallowed special token found: ${EndOfText}`,
      )
      expect(counter.count()).toBe(encoding.countTokens('hello world'))
      // still functional after the failed edits
      expect(counter.applyEdit(5, 0, ' there')).toBe(
        encoding.countTokens('hello there world'),
      )

      const h = createHarness(encoding)
      // fragments that are not special tokens must not throw
      h.replace('a <| b <|endoftext c')
      h.edit(h.mirror.length, 0, ' d')
      // an insertion completing a special token must throw
      h.replace(`a ${EndOfText.slice(0, -2)}`)
      h.edit(h.mirror.length, 0, '|>')
      // an insertion of a whole special token must throw
      h.replace('aa bb')
      h.edit(2, 0, EndOfText)
      // a deletion joining fragments into a special token must throw
      h.replace(`a<|ZZ${EndOfText.slice(2)}b`)
      h.edit(3, 2, '')
      expect(h.mirror).toBe(`a<|ZZ${EndOfText.slice(2)}b`)
      // state is intact after all the failed edits
      h.edit(0, 0, 'ok ')
    })

    test('update shares prefix and suffix with the tracked text', () => {
      const h = createHarness(encoding)
      h.replace('The quick brown fox')
      h.replace('The quick brown fox jumps')
      h.replace('quick brown fox')
      h.replace('The quick red fox')
      h.replace('')
      h.replace('completely different text')
      h.replace('completely different text')
      h.replace(prose(2000))
      h.replace(prose(2000).slice(0, 1800))
      h.replace(`x${prose(2000).slice(1)}`)
    })

    test('degenerate slice-style edit ranges', () => {
      const h = createHarness(encoding)
      h.replace('abcdef')
      h.edit(-3, 2, 'x')
      h.edit(5, -2, 'y')
      h.edit(100, 5, 'z')
      h.edit(Number.NaN, 2, 'w')
      h.edit(2, Number.NaN, 'q')
    })

    test('reset clears the tracked text', () => {
      const counter = createIncrementalCounter(encoding)
      counter.update(prose(500))
      expect(counter.count()).toBe(encoding.countTokens(prose(500)))
      counter.reset()
      expect(counter.count()).toBe(0)
      expect(counter.update('fresh start')).toBe(
        encoding.countTokens('fresh start'),
      )
    })

    test('200 seeded random edits match countTokens', () => {
      const rng = mulberry32(0x5eed0001 + encodingName.length)
      const fragments = [
        'a',
        'B',
        '9',
        ' ',
        '  ',
        '\n',
        '\t',
        '.',
        ',!',
        'é',
        'ß',
        '你',
        '好',
        '字',
        '😀',
        '🌍',
        '<|',
        'endoftext|>',
        '<|endoftext',
        '|>',
        '<|im_',
        'start|>',
        'word',
        'Tok',
      ]
      const randomInsert = (max: number): string => {
        const n = Math.floor(rng() * (max + 1))
        let out = ''
        while (out.length < n) {
          out += fragments[Math.floor(rng() * fragments.length)]!
        }
        return out.slice(0, n)
      }
      const h = createHarness(encoding)
      h.replace(prose(4000 + Math.floor(rng() * 500)))
      for (let i = 0; i < 200; i++) {
        let start: number
        let deleteCount: number
        if (rng() < 0.05) {
          // negative starts are fine as long as start + deleteCount stays
          // <= 0; going positive would duplicate huge text ranges (that
          // explosion is covered separately in the degenerate-ranges test)
          start = -(1 + Math.floor(rng() * 9))
          deleteCount = Math.floor(rng() * (1 - start))
        } else {
          start = Math.floor(rng() * (h.mirror.length + 1))
          deleteCount = Math.floor(rng() * 40)
        }
        const insert = randomInsert(12)
        if (rng() < 0.1) {
          // exercise update()'s prefix/suffix diffing path
          h.replace(
            h.mirror.slice(0, start) +
              insert +
              h.mirror.slice(start + deleteCount),
          )
        } else {
          h.edit(start, deleteCount, insert)
        }
      }
    })
  })
}
