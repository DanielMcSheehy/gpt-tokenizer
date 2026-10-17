import { describe, expect, test } from 'vitest'
import cl100k from '../encoding/cl100k_base.js'
import o200k from '../encoding/o200k_base.js'
import type { GptEncoding } from '../GptEncoding.js'
import { EndOfText } from '../specialTokens.js'
import { createIncrementalCounter } from './span-cache.js'

const encodings: { name: string; encoding: GptEncoding }[] = [
  { name: 'o200k_base', encoding: o200k },
  { name: 'cl100k_base', encoding: cl100k },
]

function expectCount(
  encoding: GptEncoding,
  counter: ReturnType<typeof createIncrementalCounter>,
  text: string,
  got: number,
) {
  expect(got).toBe(encoding.countTokens(text))
  expect(counter.count()).toBe(got)
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d_2b_79_f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function buildBaseText(length: number, seed = 1): string {
  const words = [
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
  ]
  const rand = mulberry32(seed)
  let out = ''
  let wordIndex = 0
  while (out.length < length) {
    if (out.length > 0) {
      out += wordIndex % 17 === 0 ? '\n' : ' '
    }
    out += words[wordIndex % words.length]!
    if (rand() < 0.05) {
      out += '  '
    }
    wordIndex++
  }
  return out.slice(0, length)
}

describe.each(encodings)('span-cache ($name)', ({ encoding }) => {
  test('empty string', () => {
    const counter = createIncrementalCounter(encoding)
    expectCount(encoding, counter, '', counter.update(''))
    expectCount(encoding, counter, '', counter.applyEdit(0, 0, ''))
  })

  test('ascii append, delete, and middle substitution', () => {
    const counter = createIncrementalCounter(encoding)
    let text = 'hello world'
    expectCount(encoding, counter, text, counter.update(text))

    text += ' again'
    expectCount(encoding, counter, text, counter.applyEdit(11, 0, ' again'))

    text = text.slice(0, 5) + text.slice(6)
    expectCount(encoding, counter, text, counter.applyEdit(5, 1, ''))

    text = `${text.slice(0, 6)}WORLD${text.slice(11)}`
    expectCount(encoding, counter, text, counter.applyEdit(6, 5, 'WORLD'))
  })

  test('edit at index 0 and at the end', () => {
    const counter = createIncrementalCounter(encoding)
    let text = 'prefix body suffix'
    expectCount(encoding, counter, text, counter.update(text))

    text = `XX${text}`
    expectCount(encoding, counter, text, counter.applyEdit(0, 0, 'XX'))

    text += 'YY'
    expectCount(
      encoding,
      counter,
      text,
      counter.applyEdit(text.length - 2, 0, 'YY'),
    )

    text = text.slice(2)
    expectCount(encoding, counter, text, counter.applyEdit(0, 2, ''))
  })

  test('emoji and CJK surrogate pairs', () => {
    const counter = createIncrementalCounter(encoding)
    let text = 'hello 👋 世界'
    expectCount(encoding, counter, text, counter.update(text))

    text = `😀${text}`
    expectCount(encoding, counter, text, counter.applyEdit(0, 0, '😀'))

    const waveIndex = text.indexOf('👋')
    text = `${text.slice(0, waveIndex)}🎉${text.slice(waveIndex + 2)}`
    expectCount(encoding, counter, text, counter.applyEdit(waveIndex, 2, '🎉'))

    text += '漢字'
    expectCount(
      encoding,
      counter,
      text,
      counter.applyEdit(text.length - 2, 0, '漢字'),
    )
  })

  test('whitespace insertion and deletion (lookahead and $ branch)', () => {
    const counter = createIncrementalCounter(encoding)
    let text = 'word1 word2'
    expectCount(encoding, counter, text, counter.update(text))

    // Insert whitespace in the middle — affects lookahead (?!\P{White_Space}).
    text = 'word1  word2'
    expectCount(encoding, counter, text, counter.applyEdit(5, 1, '  '))

    // Trailing whitespace — exercises end-of-segment / `$` alternatives.
    const beforeTrail = text
    text = `${beforeTrail}   `
    expectCount(
      encoding,
      counter,
      text,
      counter.applyEdit(beforeTrail.length, 0, '   '),
    )

    text = beforeTrail
    expectCount(
      encoding,
      counter,
      text,
      counter.applyEdit(beforeTrail.length, 3, ''),
    )

    // cl100k `$` branch: trailing whitespace as its own piece.
    text = 'abc   '
    expectCount(encoding, counter, text, counter.update(text))
    text = 'abc  '
    expectCount(encoding, counter, text, counter.applyEdit(5, 1, ''))
    text = 'abc\n'
    expectCount(encoding, counter, text, counter.update(text))
    text = 'abc \n'
    expectCount(encoding, counter, text, counter.applyEdit(3, 0, ' '))
  })

  test('long stable prefix with a small suffix edit', () => {
    const counter = createIncrementalCounter(encoding)
    const prefix = buildBaseText(3_500, 7)
    let text = `${prefix}TAIL`
    expectCount(encoding, counter, text, counter.update(text))

    text = `${prefix}NEXT`
    expectCount(
      encoding,
      counter,
      text,
      counter.applyEdit(prefix.length, 4, 'NEXT'),
    )
  })

  test('long stable suffix with a small prefix edit', () => {
    const counter = createIncrementalCounter(encoding)
    const suffix = buildBaseText(3_500, 11)
    let text = `HEAD${suffix}`
    expectCount(encoding, counter, text, counter.update(text))

    text = `NODE${suffix}`
    expectCount(encoding, counter, text, counter.applyEdit(0, 4, 'NODE'))
  })

  test('default special-token policy matches countTokens, including errors', () => {
    const counter = createIncrementalCounter(encoding)
    const safe = 'hello there'
    expectCount(encoding, counter, safe, counter.update(safe))

    const withSpecial = `hello ${EndOfText} there`
    expect(() => encoding.countTokens(withSpecial)).toThrowError(
      /Disallowed special token/,
    )
    expect(() => counter.update(withSpecial)).toThrowError(
      /Disallowed special token/,
    )
    expect(() => counter.applyEdit(6, 0, EndOfText)).toThrowError(
      /Disallowed special token/,
    )
  })

  test('200 seeded random edits on ~4000 character base', () => {
    const counter = createIncrementalCounter(encoding)
    const rand = mulberry32(42)
    let text = buildBaseText(4_000, 99)
    expectCount(encoding, counter, text, counter.update(text))

    const alphabet =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t'

    for (let i = 0; i < 200; i++) {
      const op = rand()
      if (op < 0.34 && text.length > 0) {
        const start = Math.floor(rand() * text.length)
        const deleteCount = Math.min(
          text.length - start,
          1 + Math.floor(rand() * 8),
        )
        text = text.slice(0, start) + text.slice(start + deleteCount)
        expectCount(
          encoding,
          counter,
          text,
          counter.applyEdit(start, deleteCount, ''),
        )
      } else if (op < 0.67) {
        const start = Math.floor(rand() * (text.length + 1))
        const len = 1 + Math.floor(rand() * 12)
        let insert = ''
        for (let j = 0; j < len; j++) {
          insert += alphabet[Math.floor(rand() * alphabet.length)]!
        }
        text = text.slice(0, start) + insert + text.slice(start)
        expectCount(
          encoding,
          counter,
          text,
          counter.applyEdit(start, 0, insert),
        )
      } else {
        const start = text.length === 0 ? 0 : Math.floor(rand() * text.length)
        const deleteCount = Math.min(
          text.length - start,
          Math.floor(rand() * 10),
        )
        const len = 1 + Math.floor(rand() * 10)
        let insert = ''
        for (let j = 0; j < len; j++) {
          insert += alphabet[Math.floor(rand() * alphabet.length)]!
        }
        text = text.slice(0, start) + insert + text.slice(start + deleteCount)
        expectCount(
          encoding,
          counter,
          text,
          counter.applyEdit(start, deleteCount, insert),
        )
      }
    }
  })
})
