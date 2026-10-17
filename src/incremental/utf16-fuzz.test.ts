import { describe, expect, it } from 'vite-plus/test'
import type { GptEncoding } from '../GptEncoding.js'
import cl100k from '../encoding/cl100k_base.js'
import o200k from '../encoding/o200k_base.js'
import { EndOfText, ImEnd } from '../specialTokens.js'
import {
  type IncrementalTokenCounter,
  createIncrementalCounter,
} from './utf16-fuzz.js'

const oracles = [
  ['o200k_base', o200k],
  ['cl100k_base', cl100k],
] as const

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

function prose(target: number, offset = 0): string {
  let out = ''
  let wordCount = 0
  let index = offset
  while (out.length < target) {
    if (wordCount > 0 && wordCount % 17 === 0) {
      out += '\n'
    } else if (out.length > 0 && !out.endsWith('\n')) {
      out += ' '
    }
    out += WORDS[index % WORDS.length]!
    index++
    wordCount++
  }
  return out.slice(0, target)
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min))
}

function errorMessage(fn: () => void): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function expectSameCount(
  encoding: GptEncoding,
  counter: IncrementalTokenCounter,
  text: string,
  apply: () => number,
  label: string,
): void {
  const oracleError = errorMessage(() => {
    encoding.countTokens(text)
  })
  if (oracleError !== undefined) {
    expect(errorMessage(apply), label).toBe(oracleError)
    expect(
      errorMessage(() => counter.count()),
      label,
    ).toBe(oracleError)
    return
  }
  const expected = encoding.countTokens(text)
  expect(apply(), label).toBe(expected)
  expect(counter.count(), label).toBe(expected)
}

function edit(
  encoding: GptEncoding,
  counter: IncrementalTokenCounter,
  text: string,
  start: number,
  deleteCount: number,
  insert: string,
  label: string,
): string {
  const next = text.slice(0, start) + insert + text.slice(start + deleteCount)
  expectSameCount(
    encoding,
    counter,
    next,
    () => counter.applyEdit(start, deleteCount, insert),
    label,
  )
  return next
}

describe.each(oracles)('%s utf16-fuzz', (name, encoding) => {
  it('counts the empty string', () => {
    const counter = createIncrementalCounter(encoding)
    expect(counter.count()).toBe(0)
    expect(counter.update('')).toBe(0)
    expect(counter.count()).toBe(encoding.countTokens(''))
  })

  it('handles ascii append, delete, and middle substitution', () => {
    const counter = createIncrementalCounter(encoding)
    let text = ''
    text = edit(encoding, counter, text, 0, 0, 'hello', `${name} insert hello`)
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      ' world',
      `${name} append`,
    )
    text = edit(encoding, counter, text, 5, 1, '', `${name} delete space`)
    text = edit(encoding, counter, text, 2, 3, 'XYZ', `${name} middle replace`)
    expect(text).toBe('heXYZworld')
    expect(counter.count()).toBe(encoding.countTokens(text))
  })

  it('edits at index 0 and at the end', () => {
    const counter = createIncrementalCounter(encoding)
    let text = 'middle'
    expectSameCount(encoding, counter, text, () => counter.update(text), 'seed')
    text = edit(encoding, counter, text, 0, 0, 'START ', `${name} prepend`)
    text = edit(encoding, counter, text, 0, 6, '', `${name} delete prefix`)
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      ' END',
      `${name} append end`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length - 4,
      4,
      '!',
      `${name} replace end`,
    )
    text = edit(encoding, counter, text, 100, 10, 'Z', `${name} edit past end`)
    expect(counter.count()).toBe(encoding.countTokens(text))
  })

  it('handles emoji, CJK, ZWJ, and combining marks', () => {
    const counter = createIncrementalCounter(encoding)
    let text = ''
    text = edit(encoding, counter, text, 0, 0, '你好', `${name} cjk`)
    text = edit(encoding, counter, text, text.length, 0, '😀', `${name} emoji`)
    text = edit(encoding, counter, text, text.length, 0, '👨‍👩‍👧‍👦', `${name} zwj`)
    const emojiAt = text.indexOf('😀')
    text = edit(
      encoding,
      counter,
      text,
      emojiAt + 1,
      0,
      'X',
      `${name} insert inside surrogate pair`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.indexOf('👨') + 1,
      2,
      '',
      `${name} delete across surrogate`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      "don't",
      `${name} contraction`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      1,
      '',
      `${name} break contraction`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      't',
      `${name} complete contraction`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      " hello'll",
      `${name} long contraction`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length - 1,
      1,
      '',
      `${name} shorten contraction`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      'l',
      `${name} restore contraction`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      'e\u0301',
      `${name} combining`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length - 1,
      1,
      '',
      `${name} delete combining mark`,
    )
    expect(counter.count()).toBe(encoding.countTokens(text))
  })

  it('handles whitespace lookahead and the trailing end anchor', () => {
    const counter = createIncrementalCounter(encoding)
    let text = 'hello'
    expectSameCount(encoding, counter, text, () => counter.update(text), 'seed')
    for (const width of [1, 2, 3, 8, 40]) {
      const spaces = ' '.repeat(width)
      text = edit(
        encoding,
        counter,
        text,
        text.length,
        0,
        spaces,
        `${name} trailing spaces ${width}`,
      )
      text = edit(
        encoding,
        counter,
        text,
        text.length,
        0,
        'x',
        `${name} letter after trailing spaces ${width}`,
      )
      text = edit(
        encoding,
        counter,
        text,
        text.length - 1,
        1,
        '',
        `${name} remove letter ${width}`,
      )
      text = edit(
        encoding,
        counter,
        text,
        text.length - width,
        width,
        '',
        `${name} delete trailing spaces ${width}`,
      )
    }
    text = edit(encoding, counter, text, 0, 0, '   ', `${name} leading spaces`)
    text = edit(
      encoding,
      counter,
      text,
      2,
      1,
      '\n',
      `${name} newline inside spaces`,
    )
    text = edit(encoding, counter, text, 0, 0, '\r\n', `${name} crlf prefix`)
    text = edit(encoding, counter, text, 1, 1, '', `${name} split crlf`)
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      '\u0085',
      `${name} next line`,
    )
    text = edit(
      encoding,
      counter,
      text,
      text.length,
      0,
      '\ufeff',
      `${name} bom`,
    )
    text = edit(
      encoding,
      counter,
      text,
      0,
      1,
      '\ufeff',
      `${name} replace with bom`,
    )
    expect(counter.count()).toBe(encoding.countTokens(text))
  })

  it('reuses a long stable prefix and a long stable suffix', () => {
    const counter = createIncrementalCounter(encoding)
    let text = prose(4_000)
    expectSameCount(encoding, counter, text, () => counter.update(text), 'base')
    for (let step = 0; step < 20; step++) {
      text = edit(
        encoding,
        counter,
        text,
        text.length - 12,
        8,
        `s${step}xxxxx`.slice(0, 8),
        `${name} suffix edit ${step}`,
      )
    }
    for (let step = 0; step < 20; step++) {
      text = edit(
        encoding,
        counter,
        text,
        10,
        8,
        `p${step}xxxxx`.slice(0, 8),
        `${name} prefix edit ${step}`,
      )
    }
    const replaced = `${text.slice(0, 10)}PREFIX${text.slice(40)}`
    expectSameCount(
      encoding,
      counter,
      replaced,
      () => counter.update(replaced),
      `${name} update shares suffix`,
    )
  })

  it('matches the default special-token policy, including errors', () => {
    const counter = createIncrementalCounter(encoding)
    const clean = 'hello world'
    expectSameCount(
      encoding,
      counter,
      clean,
      () => counter.update(clean),
      'clean',
    )

    const partial = 'hello <|endo'
    expectSameCount(
      encoding,
      counter,
      partial,
      () => counter.update(partial),
      'partial special is not a token',
    )

    const bad = `hello ${EndOfText} world`
    expect(errorMessage(() => encoding.countTokens(bad))).toBe(
      `Disallowed special token found: ${EndOfText}`,
    )
    expectSameCount(
      encoding,
      counter,
      bad,
      () => counter.update(bad),
      'disallowed',
    )

    const repaired = edit(
      encoding,
      counter,
      bad,
      bad.indexOf(EndOfText),
      EndOfText.length,
      'there',
      'repair special',
    )
    expect(repaired).toBe('hello there world')

    const joined = 'left <|endoRIGHT'
    expectSameCount(
      encoding,
      counter,
      joined,
      () => counter.update(joined),
      'join seed',
    )
    edit(
      encoding,
      counter,
      joined,
      'left <|endo'.length,
      0,
      'ftext|>',
      'insert completes a special',
    )

    const firstOfTwo = `${EndOfText} then ${ImEnd}`
    expectSameCount(
      encoding,
      counter,
      firstOfTwo,
      () => counter.update(firstOfTwo),
      'reports the leftmost special',
    )
  })

  it('matches countTokens across 200 seeded edits of a 4000 character base', () => {
    const counter = createIncrementalCounter(encoding)
    let text = prose(4_000, 3)
    expectSameCount(encoding, counter, text, () => counter.update(text), 'base')
    const rng = mulberry32(0x200 + text.length)
    for (let step = 0; step < 200; step++) {
      const start = randomInt(rng, 0, text.length)
      const deleteCount = randomInt(
        rng,
        0,
        Math.min(24, text.length - start + 1),
      )
      const insert = WORDS[step % WORDS.length]!.slice(0, randomInt(rng, 0, 8))
      text = edit(
        encoding,
        counter,
        text,
        start,
        deleteCount,
        step % 5 === 0 ? `${insert}\n` : insert,
        `${name} prose ${step}`,
      )
    }
  })

  it('matches countTokens across 500 hostile unicode edits', () => {
    const fragments = [
      'a',
      ' ',
      '\n',
      '0',
      'é',
      '你',
      '😀',
      '\uD83D',
      '\uDE00',
      '👨‍👩‍👧‍👦',
      'e\u0301',
      '\u0085',
      '\ufeff',
      '\r\n',
      '   ',
      "'s",
      '/',
      '.',
      '—',
      '\t',
      'word',
    ]
    const rng = mulberry32(name === 'o200k_base' ? 0x5eed : 0x5eee)
    let text = ''
    while (text.length < 4_000) {
      text += fragments[Math.floor(rng() * fragments.length)]!
      if (text.length % 17 === 0) {
        text += rng() < 0.5 ? '\n' : ' '
      }
    }
    text = text.slice(0, 4_000)
    const counter = createIncrementalCounter(encoding)
    expectSameCount(
      encoding,
      counter,
      text,
      () => counter.update(text),
      'hostile base',
    )

    for (let step = 0; step < 500; step++) {
      if (text.length > 6_000) {
        const start = randomInt(rng, 0, text.length)
        const deleteCount = randomInt(
          rng,
          1,
          Math.min(40, text.length - start + 1),
        )
        text = edit(
          encoding,
          counter,
          text,
          start,
          deleteCount,
          '',
          `${name} hostile delete ${step}`,
        )
        continue
      }
      if (text.length < 1_000) {
        const insert = fragments[Math.floor(rng() * fragments.length)]!
        text = edit(
          encoding,
          counter,
          text,
          text.length,
          0,
          insert,
          `${name} hostile grow ${step}`,
        )
        continue
      }

      const roll = rng()
      if (roll < 0.15) {
        const insert = fragments[Math.floor(rng() * fragments.length)]!
        text = edit(
          encoding,
          counter,
          text,
          0,
          0,
          insert,
          `${name} hostile head ${step}`,
        )
      } else if (roll < 0.3) {
        const insert = fragments[Math.floor(rng() * fragments.length)]!
        text = edit(
          encoding,
          counter,
          text,
          text.length,
          0,
          insert,
          `${name} hostile tail ${step}`,
        )
      } else if (roll < 0.45) {
        const start = randomInt(rng, 0, text.length)
        const deleteCount = randomInt(
          rng,
          1,
          Math.min(8, text.length - start + 1),
        )
        text = edit(
          encoding,
          counter,
          text,
          start,
          deleteCount,
          '',
          `${name} hostile drop ${step}`,
        )
      } else {
        const start = randomInt(rng, 0, text.length + 1)
        const deleteCount =
          start >= text.length
            ? 0
            : randomInt(rng, 0, Math.min(6, text.length - start + 1))
        let insert = fragments[Math.floor(rng() * fragments.length)]!
        if (rng() < 0.25 && insert.length > 1) {
          insert = insert[Math.floor(rng() * insert.length)]!
        }
        text = edit(
          encoding,
          counter,
          text,
          start,
          deleteCount,
          insert,
          `${name} hostile edit ${step}`,
        )
      }
    }

    counter.reset()
    expect(counter.count()).toBe(0)
    expect(counter.update('reset')).toBe(encoding.countTokens('reset'))
  }, 120_000)
})
