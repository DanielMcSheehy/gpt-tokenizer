import { describe, expect, test } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100kBase from '../encoding/cl100k_base.js'
import o200kBase from '../encoding/o200k_base.js'
import { createIncrementalCounter } from './fenwick.js'

const encodings: Record<string, GptEncoding> = {
  cl100k_base: cl100kBase,
  o200k_base: o200kBase,
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

describe.each(Object.entries(encodings))(
  'incremental fenwick counter (%s)',
  (name, encoding) => {
    test('empty string counts as zero', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.update('')).toBe(0)
      expect(counter.count()).toBe(0)
      expect(counter.withinLimit!(0)).toBe(true)
    })

    test('ascii append, delete, and middle substitution', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'the quick brown fox jumps over the lazy dog'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      // append
      text += ' and runs away'
      expect(
        counter.applyEdit(
          text.length - ' and runs away'.length,
          0,
          ' and runs away',
        ),
      ).toBe(encoding.countTokens(text))

      // middle substitution
      const mid = Math.floor(text.length / 2)
      text = `${text.slice(0, mid)}cat${text.slice(mid + 3)}`
      expect(counter.applyEdit(mid, 3, 'cat')).toBe(encoding.countTokens(text))

      // delete a word
      const idx = text.indexOf('quick')
      text = `${text.slice(0, idx)}${text.slice(idx + 6)}`
      expect(counter.applyEdit(idx, 6, '')).toBe(encoding.countTokens(text))

      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('edits at index 0 and at the end', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'leading words followed by trailing words'
      counter.update(text)

      text = `X ${text}`
      expect(counter.applyEdit(0, 0, 'X ')).toBe(encoding.countTokens(text))

      // replace the "X " prefix with "Y "
      text = `Y ${text.slice(2)}`
      expect(counter.applyEdit(0, 2, 'Y ')).toBe(encoding.countTokens(text))

      text += ' end'
      expect(counter.applyEdit(text.length - ' end'.length, 0, ' end')).toBe(
        encoding.countTokens(text),
      )

      text += '!'
      expect(counter.applyEdit(text.length - 1, 0, '!')).toBe(
        encoding.countTokens(text),
      )

      // delete from the end
      text = text.slice(0, -5)
      expect(counter.applyEdit(text.length, 5, '')).toBe(
        encoding.countTokens(text),
      )

      // delete from the start
      text = text.slice(2)
      expect(counter.applyEdit(0, 2, '')).toBe(encoding.countTokens(text))
    })

    test('emoji and CJK surrogate pairs', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'hello 👋🌍 world 你好世界 ありがとう 🚀🚀 done'
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      // append an emoji
      text += ' 😀'
      expect(counter.applyEdit(text.length - 2, 0, ' 😀')).toBe(
        encoding.countTokens(text),
      )

      // substitute an emoji for a word
      const waveIndex = text.indexOf('👋')
      text = `${text.slice(0, waveIndex)}食べる${text.slice(waveIndex + 2)}`
      expect(counter.applyEdit(waveIndex, 2, '食べる')).toBe(
        encoding.countTokens(text),
      )

      // edit that splits a surrogate pair (position inside an emoji)
      const rocketIndex = text.indexOf('🚀🚀')
      text = `${text.slice(0, rocketIndex + 1)}x${text.slice(rocketIndex + 1)}`
      expect(counter.applyEdit(rocketIndex + 1, 0, 'x')).toBe(
        encoding.countTokens(text),
      )
      // and repair it
      text = `${text.slice(0, rocketIndex + 1)}${text.slice(rocketIndex + 2)}`
      expect(counter.applyEdit(rocketIndex + 1, 1, '')).toBe(
        encoding.countTokens(text),
      )
    })

    test('whitespace insertion and deletion (lookahead and $ branches)', () => {
      const counter = createIncrementalCounter(encoding)

      // a text ending in a whitespace run exercises the `$` and lookahead
      // branches at the true end of the text
      let text = 'word    '
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      // extend the trailing run
      text += '  '
      expect(counter.applyEdit(text.length - 2, 0, '  ')).toBe(
        encoding.countTokens(text),
      )

      // append a word after the run (the run's last piece now joins the word)
      text += 'end'
      expect(counter.applyEdit(text.length - 3, 0, 'end')).toBe(
        encoding.countTokens(text),
      )

      // delete from the middle of the whitespace run
      const runStart = 'word'.length
      text = `${text.slice(0, runStart + 3)}${text.slice(runStart + 4)}`
      expect(counter.applyEdit(runStart + 3, 1, '')).toBe(
        encoding.countTokens(text),
      )

      // insert a newline into the middle of the run
      text = `${text.slice(0, runStart + 2)}\n${text.slice(runStart + 2)}`
      expect(counter.applyEdit(runStart + 2, 0, '\n')).toBe(
        encoding.countTokens(text),
      )

      // whitespace runs around words mid-text
      let mid = 'alpha beta\n\n  gamma delta\n \n epsilon'
      counter.update(mid)
      const twoSpaces = mid.indexOf('  ')
      mid = `${mid.slice(0, twoSpaces)} \n${mid.slice(twoSpaces + 2)}`
      expect(counter.applyEdit(twoSpaces, 2, ' \n')).toBe(
        encoding.countTokens(mid),
      )

      // inserting a newline into a run of plain spaces extends the
      // newline-run piece backwards past previous piece boundaries
      const spaces = mid.indexOf(' \n')
      mid = `${mid.slice(0, spaces)}\n${mid.slice(spaces + 1)}`
      expect(counter.applyEdit(spaces, 1, '\n')).toBe(encoding.countTokens(mid))

      // joining words by deleting separating whitespace
      const beta = mid.indexOf('beta')
      mid = `${mid.slice(0, beta + 4)}${mid.slice(beta + 5)}`
      expect(counter.applyEdit(beta + 4, 1, '')).toBe(encoding.countTokens(mid))
    })

    test('long stable prefix with small suffix edits', () => {
      const counter = createIncrementalCounter(encoding)
      const words =
        'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split(
          ' ',
        )
      let text = ''
      let i = 0
      while (text.length < 6000) {
        text += `${words[i++ % words.length]}${i % 17 === 0 ? '\n' : ' '}`
      }
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      for (let edit = 0; edit < 30; edit++) {
        const tail = ` suffix edit number ${edit} with 🎉`
        const start = text.length
        text += tail
        expect(counter.applyEdit(start, 0, tail)).toBe(
          encoding.countTokens(text),
        )
        // replace part of the tail
        const marker = text.indexOf('number')
        text = `${text.slice(0, marker)}idx-${edit}${text.slice(marker + 6)}`
        expect(counter.applyEdit(marker, 6, `idx-${edit}`)).toBe(
          encoding.countTokens(text),
        )
      }
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('long stable suffix with small prefix edits', () => {
      const counter = createIncrementalCounter(encoding)
      const words =
        'the quick brown fox jumps over a lazy dog while counting tokens repeatedly'.split(
          ' ',
        )
      let text = ''
      let i = 0
      while (text.length < 6000) {
        text += `${words[i++ % words.length]}${i % 17 === 0 ? '\n' : ' '}`
      }
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      for (let edit = 0; edit < 30; edit++) {
        const replacement = `edit-${edit}-`
        text = `${text.slice(0, 10)}${replacement}${text.slice(18)}`
        expect(counter.applyEdit(10, 8, replacement)).toBe(
          encoding.countTokens(text),
        )
      }
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('default special-token policy matches countTokens, including errors', () => {
      const counter = createIncrementalCounter(encoding)
      const text = 'an ordinary prompt with no special tokens'
      counter.update(text)

      // update() throws exactly like countTokens()
      const bad = 'prefix <|endoftext|> suffix'
      expect(() => encoding.countTokens(bad)).toThrowError(
        'Disallowed special token found: <|endoftext|>',
      )
      expect(() => counter.update(bad)).toThrowError(
        'Disallowed special token found: <|endoftext|>',
      )

      // state is untouched by the failed update
      expect(counter.count()).toBe(encoding.countTokens(text))

      // applyEdit() that introduces a special token throws the same error
      expect(() =>
        counter.applyEdit(text.length, 0, ' <|endoftext|>'),
      ).toThrowError('Disallowed special token found: <|endoftext|>')
      expect(counter.count()).toBe(encoding.countTokens(text))

      // a special token assembled by appending next to existing text
      counter.update('partial token <|endoftex')
      const completion = 't|> completed'
      const partial = 'partial token <|endoftex'
      const joined = partial + completion
      expect(() => encoding.countTokens(joined)).toThrowError(
        'Disallowed special token found: <|endoftext|>',
      )
      expect(() =>
        counter.applyEdit(partial.length, 0, completion),
      ).toThrowError('Disallowed special token found: <|endoftext|>')

      // a special token assembled by deleting text between two fragments
      const straddle = 'keep <|endoftext' + ' removable junk ' + '|> tail'
      counter.update(straddle)
      const junkStart = straddle.indexOf(' removable junk ')
      const junkLength = ' removable junk '.length
      const joinedByDelete = `${straddle.slice(0, junkStart)}${straddle.slice(junkStart + junkLength)}`
      expect(() => encoding.countTokens(joinedByDelete)).toThrowError(
        'Disallowed special token found: <|endoftext|>',
      )
      expect(() => counter.applyEdit(junkStart, junkLength, '')).toThrowError(
        'Disallowed special token found: <|endoftext|>',
      )

      // edits next to (but not forming) a special-looking string stay valid
      const near = 'text with <|endoftex and more words'
      counter.update(near)
      const edited = `${near.slice(0, 20)}X${near.slice(20)}`
      expect(counter.applyEdit(20, 1, 'X')).toBe(encoding.countTokens(edited))
    })

    test('withinLimit matches isWithinTokenLimit', () => {
      const counter = createIncrementalCounter(encoding)
      const text = 'counting tokens for the limit check ' + 'bla '.repeat(40)
      const total = counter.update(text)

      for (const limit of [0, 1, 5, total - 1, total, total + 1, total + 100]) {
        const oracle = encoding.isWithinTokenLimit(text, limit)
        expect(counter.withinLimit!(limit)).toBe(oracle !== false)
      }

      // after edits too
      const edited = `${text}plus more words at the end`
      counter.applyEdit(text.length, 0, 'plus more words at the end')
      for (const limit of [0, 1, 7, total - 2, total, total + 50]) {
        const oracle = encoding.isWithinTokenLimit(edited, limit)
        expect(counter.withinLimit!(limit)).toBe(oracle !== false)
      }
    })

    test('reset clears tracked state', () => {
      const counter = createIncrementalCounter(encoding)
      counter.update('some text to track ' + 'xyz '.repeat(30))
      counter.reset()
      expect(counter.count()).toBe(0)
      const next = 'fresh text after reset'
      expect(counter.update(next)).toBe(encoding.countTokens(next))
    })

    test('200 seeded random edits stay exact', () => {
      const random = mulberry32(0x5eed + name.length)
      const fragments = [
        'alpha',
        'beta',
        'gamma',
        'delta',
        ' the ',
        'word',
        '1234',
        '42',
        '!!',
        '...',
        '---',
        '\n',
        '\n\n',
        '  ',
        '\t',
        ' \r\n',
        ' ',
        '👋',
        '🌍',
        '你好',
        '世界',
        '日本語テキスト',
        'emoji 👍 mixes',
        "don't",
        "can't stop",
        'UPPER',
        'MiXeD CaSe',
        'trailing spaces   ',
        '   leading',
        'tabs\tand\tspaces',
        'a1b2c3',
        'φιλοσοφία',
        'Привет мир',
        '🚀🚀🚀',
      ]

      let text = ''
      while (text.length < 4000) {
        text += `${fragments[Math.floor(random() * fragments.length)]!}${
          random() < 0.15 ? '\n' : ''
        }`
      }

      const counter = createIncrementalCounter(encoding)
      expect(counter.update(text)).toBe(encoding.countTokens(text))

      for (let step = 0; step < 200; step++) {
        const roll = random()
        const start = Math.floor(random() * (text.length + 1))
        if (roll < 0.4) {
          // insert
          const insert = fragments[Math.floor(random() * fragments.length)]!
          text = `${text.slice(0, start)}${insert}${text.slice(start)}`
          expect(counter.applyEdit(start, 0, insert)).toBe(
            encoding.countTokens(text),
          )
        } else if (roll < 0.7 && text.length > 0) {
          // delete
          const length = Math.min(
            text.length - start,
            1 + Math.floor(random() * 24),
          )
          text = `${text.slice(0, start)}${text.slice(start + length)}`
          expect(counter.applyEdit(start, length, '')).toBe(
            encoding.countTokens(text),
          )
        } else if (text.length > 0) {
          // substitute
          const length = Math.min(
            text.length - start,
            1 + Math.floor(random() * 12),
          )
          const insert = fragments[Math.floor(random() * fragments.length)]!
          text = `${text.slice(0, start)}${insert}${text.slice(start + length)}`
          expect(counter.applyEdit(start, length, insert)).toBe(
            encoding.countTokens(text),
          )
        }

        if (step % 50 === 25) {
          expect(counter.count()).toBe(encoding.countTokens(text))
          const limit = Math.floor(random() * 500)
          expect(counter.withinLimit!(limit)).toBe(
            encoding.isWithinTokenLimit(text, limit) !== false,
          )
        }
      }

      // final full replacement agrees as well
      text = 'completely different text 👋 with unicode 漢字 and 123 numbers'
      expect(counter.update(text)).toBe(encoding.countTokens(text))
    })
  },
)
