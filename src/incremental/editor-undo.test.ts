import { describe, expect, test } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100k from '../encoding/cl100k_base.js'
import o200k from '../encoding/o200k_base.js'
import {
  createIncrementalCounter,
  type IncrementalTokenCounter,
} from './editor-undo.js'

const encodings: Array<[name: string, encoding: GptEncoding]> = [
  ['o200k_base', o200k],
  ['cl100k_base', cl100k],
]

function edited(
  text: string,
  start: number,
  deleteCount: number,
  insert: string,
): string {
  return text.slice(0, start) + insert + text.slice(start + deleteCount)
}

/** Applies the edit to the counter and asserts it matches countTokens. */
function checkEdit(
  encoding: GptEncoding,
  counter: IncrementalTokenCounter,
  text: string,
  start: number,
  deleteCount: number,
  insert: string,
): string {
  const next = edited(text, start, deleteCount, insert)
  expect(counter.applyEdit(start, deleteCount, insert)).toBe(
    encoding.countTokens(next),
  )
  return next
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

const PROSE_WORDS = [
  'the',
  'quick',
  'brown',
  'fox',
  'jumps',
  'over',
  'lazy',
  'dogs',
  '你好',
  '世界',
  '🌍',
  '🎉',
  '42',
  "don't",
  'well-known',
  'naïve',
  '日本語',
  'テキスト',
]

function buildProse(length: number, phase = 0): string {
  let text = ''
  let i = phase
  while (text.length < length) {
    text += PROSE_WORDS[i % PROSE_WORDS.length]
    i++
    text += i % 17 === 0 ? '\n' : ' '
  }
  return text.slice(0, length)
}

for (const [name, encoding] of encodings) {
  describe(`incremental token counter (${name})`, () => {
    test('empty string', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.update('')).toBe(encoding.countTokens(''))
      expect(counter.count()).toBe(0)
      expect(counter.applyEdit(0, 0, '')).toBe(0)
    })

    test('ascii append, delete, and middle substitution', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'Hello world'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      text = checkEdit(encoding, counter, text, text.length, 0, ' and more')
      text = checkEdit(encoding, counter, text, text.length, 0, ' text here')
      // delete "Hello " from the front
      text = checkEdit(encoding, counter, text, 0, 6, '')
      // middle substitution
      text = checkEdit(encoding, counter, text, 6, 4, 'WORLD')
      // delete a middle chunk
      text = checkEdit(encoding, counter, text, 5, 9, '')
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('edit at index 0 and at the end', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'The first token matters, and so does the last one.'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      text = checkEdit(encoding, counter, text, 0, 1, 'A')
      text = checkEdit(encoding, counter, text, 0, 0, 'Indeed, ')
      text = checkEdit(encoding, counter, text, text.length - 1, 1, '!')
      text = checkEdit(encoding, counter, text, text.length, 0, ' Truly.')
      text = checkEdit(encoding, counter, text, text.length - 7, 7, '')
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('emoji and CJK (surrogate pairs)', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'emoji 🌍 and 🎉 parties 你好世界 日本語テキスト end'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      // insert between surrogate pairs
      text = checkEdit(encoding, counter, text, 6, 0, '🌟')
      // delete a whole surrogate pair (2 UTF-16 units)
      text = checkEdit(encoding, counter, text, 14, 2, '')
      // substitute a CJK word
      text = checkEdit(encoding, counter, text, 30, 2, ' Seoul')
      // append CJK
      text = checkEdit(encoding, counter, text, text.length, 0, ' 서울')
      // split a surrogate pair: deletes the high surrogate only,
      // leaving a lone low surrogate for both countTokens and the counter
      let highSurrogateIndex = -1
      for (let i = 0; i + 1 < text.length; i++) {
        const code = text.charCodeAt(i)
        if (
          code >= 0xd800 &&
          code <= 0xdbff &&
          text.charCodeAt(i + 1) >= 0xdc00
        ) {
          highSurrogateIndex = i
          break
        }
      }
      expect(highSurrogateIndex).toBeGreaterThanOrEqual(0)
      text = checkEdit(encoding, counter, text, highSurrogateIndex, 1, '')
      text = checkEdit(
        encoding,
        counter,
        text,
        Math.max(0, highSurrogateIndex - 1),
        2,
        '💫',
      )
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('whitespace insertion and deletion (lookahead and trailing $)', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'Hello world'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      // append trailing whitespace: exercises the end-anchored `$` branch
      text = checkEdit(encoding, counter, text, text.length, 0, '   ')
      // extend the trailing whitespace run
      text = checkEdit(encoding, counter, text, text.length, 0, ' \t\n')
      // append text after trailing whitespace: the `$` piece is invalidated
      text = checkEdit(encoding, counter, text, text.length, 0, 'tail')
      // delete all trailing whitespace again
      text = checkEdit(encoding, counter, text, text.length - 4, 6, '')
      // double space between words (lookahead keeps the run in one piece)
      text = checkEdit(encoding, counter, text, 5, 0, ' ')
      // collapse the double space back to one
      text = checkEdit(encoding, counter, text, 5, 1, '')
      // insert a non-breaking space (U+00A0 has the White_Space property)
      text = checkEdit(encoding, counter, text, 5, 0, ' ')
      // newline insertion inside a word run
      text = checkEdit(encoding, counter, text, 3, 0, '\n')
      // delete that newline
      text = checkEdit(encoding, counter, text, 3, 1, '')
      // leading whitespace
      text = checkEdit(encoding, counter, text, 0, 0, '  ')
      text = checkEdit(encoding, counter, text, 0, 2, '')
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('long stable prefix with a small suffix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const base = buildProse(3000)
      let text = base
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      for (let i = 0; i < 12; i++) {
        text = checkEdit(encoding, counter, text, text.length, 0, ' suffix')
      }
      text = checkEdit(encoding, counter, text, text.length - 3, 3, 'X')
      text = checkEdit(encoding, counter, text, text.length - 12, 12, '')
      text = checkEdit(encoding, counter, text, text.length, 0, ' 你好')
      expect(counter.count()).toBe(encoding.countTokens(text))
      expect(text.startsWith(base.slice(0, 2900))).toBe(true)
    })

    test('long stable suffix with a small prefix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const base = buildProse(3000)
      let text = base
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      text = checkEdit(encoding, counter, text, 0, 1, 'A')
      text = checkEdit(encoding, counter, text, 0, 0, 'And now: ')
      text = checkEdit(encoding, counter, text, 10, 8, 'modified')
      text = checkEdit(encoding, counter, text, 4, 11, '')
      expect(counter.count()).toBe(encoding.countTokens(text))
      expect(text.endsWith(base.slice(500))).toBe(true)
    })

    test('default special-token policy matches countTokens, including errors', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'a normal prompt with no specials'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      const badTexts = [
        'hello <|endoftext|> world',
        '<|fim_prefix|>',
        'prefix <| not a special |> but this one is: <|fim_middle|>',
      ]
      for (const bad of badTexts) {
        let countTokensMessage = 'NO THROW'
        try {
          encoding.countTokens(bad)
        } catch (error) {
          countTokensMessage = (error as Error).message
        }
        expect(countTokensMessage).toMatch(/^Disallowed special token found: /)

        let counterMessage = 'NO THROW'
        try {
          counter.update(bad)
        } catch (error) {
          counterMessage = (error as Error).message
        }
        expect(counterMessage).toBe(countTokensMessage)

        // inserting a special via applyEdit must throw identically
        const start = 8
        const withSpecial = edited(text, start, 0, '<|endoftext|>')
        let insertMessage = 'NO THROW'
        try {
          encoding.countTokens(withSpecial)
        } catch (error) {
          insertMessage = (error as Error).message
        }
        let counterInsertMessage = 'NO THROW'
        try {
          counter.applyEdit(start, 0, '<|endoftext|>')
        } catch (error) {
          counterInsertMessage = (error as Error).message
        }
        expect(counterInsertMessage).toBe(insertMessage)
      }

      // the failed edits left the tracked text untouched
      expect(counter.count()).toBe(encoding.countTokens(text))
      text = checkEdit(encoding, counter, text, 1, 1, 'still fine')
      expect(counter.count()).toBe(encoding.countTokens(text))

      // an incomplete lookalike is not a special token
      text = checkEdit(encoding, counter, text, 0, 0, '<|endo')
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('20 edits undone by inverse edits, checked at every step', () => {
      const counter = createIncrementalCounter(encoding)
      const random = mulberry32(0x5eed_0001)
      const base = buildProse(2500, 3)
      let text = base
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      const edits: Array<{
        start: number
        deleteCount: number
        insert: string
        removed: string
      }> = []
      for (let i = 0; i < 20; i++) {
        const start = Math.floor(random() * text.length)
        const deleteCount = Math.floor(random() * 24)
        const insert = buildProse(1 + Math.floor(random() * 13), i)
        edits.push({ start, deleteCount, insert, removed: '' })
        const next = edited(text, start, deleteCount, insert)
        edits[edits.length - 1]!.removed = text.slice(
          start,
          start + deleteCount,
        )
        expect(counter.applyEdit(start, deleteCount, insert)).toBe(
          encoding.countTokens(next),
        )
        text = next
      }

      for (let i = edits.length - 1; i >= 0; i--) {
        const { start, insert, removed } = edits[i]!
        const next = edited(text, start, insert.length, removed)
        expect(counter.applyEdit(start, insert.length, removed)).toBe(
          encoding.countTokens(next),
        )
        text = next
      }

      expect(text).toBe(base)
      expect(counter.count()).toBe(encoding.countTokens(base))
    })

    test('200 seeded random edits match countTokens', () => {
      const counter = createIncrementalCounter(encoding)
      const random = mulberry32(0xba5e_feed)
      let text = buildProse(4000, 7)
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      const pool = [
        'a',
        'Z',
        '9',
        ' ',
        '  ',
        '\n',
        '\t',
        '　',
        ' ',
        'é',
        '你',
        '🌍',
        '<|',
        '|>',
        '-',
        "'",
        '42',
        '!!',
      ]
      let throwsChecked = 0

      for (let i = 0; i < 200; i++) {
        const start = Math.floor(random() * (text.length + 1))
        const op = random()
        let insert = ''
        let deleteCount = 0
        if (op < 0.35) {
          deleteCount = Math.min(text.length - start, Math.floor(random() * 30))
        } else if (op < 0.7) {
          insert = ''
          for (let j = 0; j < 1 + Math.floor(random() * 12); j++) {
            insert += pool[Math.floor(random() * pool.length)]
          }
        } else {
          deleteCount = Math.min(text.length - start, Math.floor(random() * 10))
          insert = ''
          for (let j = 0; j < 1 + Math.floor(random() * 8); j++) {
            insert += pool[Math.floor(random() * pool.length)]
          }
        }
        if (random() < 0.02) {
          // deliberately complete a special token so the error path runs
          insert += '<|endoftext|>'
        }

        const next = edited(text, start, deleteCount, insert)
        let oracleThrew = false
        let expected: number | undefined
        try {
          expected = encoding.countTokens(next)
        } catch {
          oracleThrew = true
        }

        if (!oracleThrew) {
          expect(counter.applyEdit(start, deleteCount, insert)).toBe(expected)
          text = next
        } else {
          // the counter must throw like countTokens and keep its state
          expect(() => counter.applyEdit(start, deleteCount, insert)).toThrow(
            /^Disallowed special token found: /,
          )
          throwsChecked++
          expect(counter.count()).toBe(encoding.countTokens(text))
        }
      }
      expect(throwsChecked).toBeGreaterThan(0)
    })

    test('snapshot ring returns exact counts and survives overflow', () => {
      const counter = createIncrementalCounter(encoding)
      const texts = Array.from({ length: 10 }, (_, i) => buildProse(600, i))
      for (const text of texts) {
        expect(counter.update(text)).toBe(encoding.countTokens(text))
      }
      // returning to a recent snapshot hits the ring (no BPE) and is exact
      expect(counter.update(texts[3]!)).toBe(encoding.countTokens(texts[3]!))
      expect(counter.update(texts[9]!)).toBe(encoding.countTokens(texts[9]!))

      // more distinct texts than the ring capacity: still exact either way
      for (let i = 0; i < 24; i++) {
        const text = `ring overflow variant ${i} ${buildProse(200, i)}`
        expect(counter.update(text)).toBe(encoding.countTokens(text))
      }
      expect(counter.update(texts[0]!)).toBe(encoding.countTokens(texts[0]!))
    })

    test('dirty window reuses a nearby snapshot when current is unrelated', () => {
      const counter = createIncrementalCounter(encoding)
      const stable = buildProse(2000, 5)
      expect(counter.update(stable)).toBe(encoding.countTokens(stable))
      // current becomes unrelated to the next text
      const unrelated = buildProse(800, 11)
      expect(counter.update(unrelated)).toBe(encoding.countTokens(unrelated))
      // long shared prefix with the older snapshot, not with current
      const next = `${stable} plus a changed tail 🎉`
      expect(counter.update(next)).toBe(encoding.countTokens(next))
      expect(counter.count()).toBe(encoding.countTokens(next))
    })

    test('reset clears state', () => {
      const counter = createIncrementalCounter(encoding)
      const text = buildProse(1000, 2)
      expect(counter.update(text)).toBe(encoding.countTokens(text))
      counter.reset()
      expect(counter.count()).toBe(0)
      expect(counter.update('fresh start')).toBe(
        encoding.countTokens('fresh start'),
      )
    })
  })
}
