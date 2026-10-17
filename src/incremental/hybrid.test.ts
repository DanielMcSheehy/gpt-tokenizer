import { describe, expect, test } from 'vite-plus/test'
import cl100kEncoding from '../encoding/cl100k_base.js'
import o200kEncoding from '../encoding/o200k_base.js'
import type { GptEncoding } from '../GptEncoding.js'
import {
  type IncrementalTokenCounter,
  createIncrementalCounter,
} from './hybrid.js'

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

function buildProse(length: number, wordOffset = 0): string {
  let out = ''
  let wordIndex = 0
  while (out.length < length) {
    if (wordIndex > 0) {
      out += wordIndex % 17 === 0 ? '\n' : ' '
    }
    out += WORDS[(wordOffset + wordIndex) % WORDS.length]!
    wordIndex++
  }
  return out.slice(0, length)
}

function errorOf(fn: () => unknown): Error | undefined {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  return undefined
}

/** Applies an edit to `mirror` and asserts the counter agrees with countTokens. */
function verifyEdit(
  counter: IncrementalTokenCounter,
  encoding: GptEncoding,
  mirror: string,
  start: number,
  deleteCount: number,
  insert: string,
): string {
  const next =
    mirror.slice(0, start) + insert + mirror.slice(start + deleteCount)
  const expected = encoding.countTokens(next)
  expect(counter.applyEdit(start, deleteCount, insert)).toBe(expected)
  expect(counter.count()).toBe(expected)
  return next
}

function verifyUpdate(
  counter: IncrementalTokenCounter,
  encoding: GptEncoding,
  next: string,
): string {
  const expected = encoding.countTokens(next)
  expect(counter.update(next)).toBe(expected)
  expect(counter.count()).toBe(expected)
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

const RANDOM_INSERTS = [
  '',
  'x',
  ' ',
  '  ',
  '\n',
  '\n\n',
  ' \t \n',
  'the ',
  'hello',
  'world!',
  '42',
  '1234567890',
  '😀',
  '🚀🎉',
  '你好',
  '日本語',
  'ünïcödé',
  '...',
  '<|almost|>',
  "'ll",
]

function buildMixedBase(rand: () => number): string {
  const chunks = [
    buildProse(3000, Math.floor(rand() * WORDS.length)),
    'digits 0123456789 987654321 mixed 42 424242 12345678901234',
    '你好世界，这是用于增量测试的中文文本。.tokenizer 计数必须完全一致。',
    'emoji 😀🚀🎉👍🇺🇸 families 👨‍👩‍👧‍👦 and zwj runs',
    'tabs\tand  runs   of\n\n\nnewlines\r\nand \r carriage feeds   ',
    'punct !?.,;:-_/\\|\'"`~@#$%^&*()[]{}<> += and <|almost special|>',
    buildProse(600, Math.floor(rand() * WORDS.length)),
  ]
  return chunks.join('  ').slice(0, 4000 + Math.floor(rand() * 300))
}

const encodingCases = [
  ['o200k_base', o200kEncoding],
  ['cl100k_base', cl100kEncoding],
] as const

for (const [encodingName, encoding] of encodingCases) {
  describe(`hybrid incremental counter (${encodingName})`, () => {
    test('empty string', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.update('')).toBe(encoding.countTokens(''))
      expect(counter.count()).toBe(0)

      // Grow from empty, then empty again via edit and via update.
      let mirror = verifyUpdate(counter, encoding, 'hello world')
      mirror = verifyEdit(counter, encoding, mirror, 0, mirror.length, '')
      expect(mirror).toBe('')
      mirror = verifyUpdate(counter, encoding, 'again')
      mirror = verifyUpdate(counter, encoding, '')
      expect(mirror).toBe('')
      expect(counter.count()).toBe(0)
    })

    test('ascii append, delete, and middle substitution', () => {
      const counter = createIncrementalCounter(encoding)
      let mirror = 'Hello, world!'
      mirror = verifyUpdate(counter, encoding, mirror)
      // append
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        mirror.length,
        0,
        ' How are you today?',
      )
      // delete
      mirror = verifyEdit(counter, encoding, mirror, 0, 7, '')
      // middle substitution, same and different lengths
      mirror = verifyEdit(counter, encoding, mirror, 6, 5, 'there')
      mirror = verifyEdit(counter, encoding, mirror, 6, 5, 'somewhere')
      // trailing delete then re-append
      mirror = verifyEdit(counter, encoding, mirror, mirror.length - 6, 6, '')
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        mirror.length,
        0,
        ' again!',
      )
      // same-text update is a no-op returning the same count
      expect(counter.update(mirror)).toBe(encoding.countTokens(mirror))
    })

    test('edit at index 0 and at the end', () => {
      const counter = createIncrementalCounter(encoding)
      let mirror = 'the quick brown fox jumps over the lazy dog'
      mirror = verifyUpdate(counter, encoding, mirror)
      mirror = verifyEdit(counter, encoding, mirror, 0, 1, 'T')
      mirror = verifyEdit(counter, encoding, mirror, 0, 0, '>>> ')
      mirror = verifyEdit(counter, encoding, mirror, 0, 4, '')
      mirror = verifyEdit(counter, encoding, mirror, mirror.length, 0, '!')
      mirror = verifyEdit(counter, encoding, mirror, mirror.length - 1, 1, '?')
      mirror = verifyEdit(counter, encoding, mirror, mirror.length, 0, ' end')
      mirror = verifyEdit(counter, encoding, mirror, mirror.length - 4, 4, '')
    })

    test('emoji and CJK (surrogate pairs)', () => {
      const counter = createIncrementalCounter(encoding)
      const base =
        'rocket 🚀 launch 😀 face 你好世界 日本語テキスト mixed ascii words 👨‍👩‍👧‍👦 end'
      let mirror = verifyUpdate(counter, encoding, base)

      const rocketIndex = base.indexOf('🚀')
      const faceIndex = base.indexOf('😀')
      const cjkIndex = base.indexOf('你好世界')

      // insert emoji inside a CJK run
      mirror = verifyEdit(counter, encoding, mirror, cjkIndex + 2, 0, '😀')
      // append CJK after emoji
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        mirror.length,
        0,
        '更多中文',
      )
      // split a surrogate pair in the middle: leaves two lone surrogates
      mirror = verifyEdit(counter, encoding, mirror, faceIndex + 1, 1, 'x')
      // delete across a surrogate boundary
      mirror = verifyEdit(counter, encoding, mirror, rocketIndex, 3, '')
      // insert a lone high surrogate that pairs up with a lone low surrogate
      const loneLowIndex = mirror.indexOf('x')
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        loneLowIndex,
        0,
        '😀'.slice(0, 1),
      )
      // backspace from the end over emoji
      mirror = verifyEdit(counter, encoding, mirror, mirror.length - 2, 2, '')
    })

    test('whitespace insertion and deletion (lookahead and trailing $ branch)', () => {
      const counter = createIncrementalCounter(encoding)
      // trailing whitespace is matched by end-anchored branches
      // (`\p{White_Space}+(?!\P{White_Space})` / `\p{White_Space}+$`),
      // so appending after it must re-split the run.
      let mirror = 'alpha beta'
      mirror = verifyUpdate(counter, encoding, mirror)
      mirror = verifyEdit(counter, encoding, mirror, mirror.length, 0, '   ')
      mirror = verifyEdit(counter, encoding, mirror, mirror.length, 0, 'gamma')
      // deleting a non-whitespace char between whitespace runs merges them
      mirror = verifyEdit(counter, encoding, mirror, mirror.length - 6, 1, '')
      // deleting inside a whitespace run
      const runStart =
        mirror.indexOf('   ') >= 0 ? mirror.indexOf('   ') : mirror.length - 4
      mirror = verifyEdit(counter, encoding, mirror, runStart + 1, 1, '')
      // insert whitespace mid-word (lookahead re-splits both sides)
      mirror = verifyEdit(counter, encoding, mirror, 5, 0, ' \n\t ')
      // newline runs
      mirror = verifyEdit(counter, encoding, mirror, 0, 0, 'line one\n\n\n\n')
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        mirror.indexOf('\n\n') + 1,
        1,
        '\r\n',
      )
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        mirror.length,
        0,
        '\n  \t ',
      )
      // whitespace-only text
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        0,
        mirror.length,
        '   \n\t\t  ',
      )
      mirror = verifyEdit(counter, encoding, mirror, mirror.length, 0, 'x')
      mirror = verifyEdit(counter, encoding, mirror, 0, 0, 'y')
      // cl100k `$` branch: text ending in a whitespace run, truncated back
      mirror = verifyEdit(
        counter,
        encoding,
        mirror,
        mirror.length - 1,
        1,
        '   ',
      )
      mirror = verifyEdit(counter, encoding, mirror, mirror.length, 0, 'tail')
      mirror = verifyEdit(counter, encoding, mirror, mirror.length - 4, 4, '')
    })

    test('long stable prefix with a small suffix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const base = buildProse(4000, 3)
      let mirror = verifyUpdate(counter, encoding, base)
      for (let i = 0; i < 10; i++) {
        mirror = verifyEdit(
          counter,
          encoding,
          mirror,
          mirror.length - 5,
          3,
          `sfx${i}`,
        )
        mirror = verifyEdit(
          counter,
          encoding,
          mirror,
          mirror.length,
          0,
          ' tail.',
        )
      }
    })

    test('long stable suffix with a small prefix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const base = buildProse(4000, 11)
      let mirror = verifyUpdate(counter, encoding, base)
      for (let i = 0; i < 10; i++) {
        mirror = verifyEdit(counter, encoding, mirror, 10, 8, `pfx${i}!!`)
        mirror = verifyEdit(counter, encoding, mirror, 0, 0, 'x')
      }
    })

    test('default special-token policy matches countTokens, including errors', () => {
      const counter = createIncrementalCounter(encoding)
      let mirror = 'an ordinary prompt with no specials'
      mirror = verifyUpdate(counter, encoding, mirror)

      const special = '<|endoftext|>'
      const poisoned = `${mirror} ${special} more`

      const countTokensError = errorOf(() => encoding.countTokens(poisoned))
      expect(countTokensError).toBeInstanceOf(Error)
      expect(countTokensError?.message).toMatch(
        /Disallowed special token found/,
      )

      // update() throws with the identical message and keeps prior state
      const updateError = errorOf(() => counter.update(poisoned))
      expect(updateError?.message).toBe(countTokensError?.message)
      expect(counter.count()).toBe(encoding.countTokens(mirror))

      // applyEdit inserting a special mid-text
      const insertError = errorOf(() => counter.applyEdit(5, 0, `${special} `))
      expect(insertError?.message).toBe(countTokensError?.message)
      expect(counter.count()).toBe(encoding.countTokens(mirror))

      // an edit still works after the rejected ones
      mirror = verifyEdit(counter, encoding, mirror, 0, 2, 'An')

      // deleting text that closes a gap around a special token
      const splitSpecial = `prefix <|${'X'}endoftext|> suffix`
      mirror = verifyUpdate(counter, encoding, splitSpecial)
      const xIndex = mirror.indexOf('X')
      const joinError = errorOf(() =>
        encoding.countTokens(
          mirror.slice(0, xIndex) + mirror.slice(xIndex + 1),
        ),
      )
      expect(joinError?.message).toMatch(/Disallowed special token found/)
      const editError = errorOf(() => counter.applyEdit(xIndex, 1, ''))
      expect(editError?.message).toBe(joinError?.message)
      expect(counter.count()).toBe(encoding.countTokens(splitSpecial))

      // special-token-shaped text that is not an actual token stays countable
      mirror = verifyEdit(counter, encoding, splitSpecial, 8, 9, '')
      mirror = verifyUpdate(
        counter,
        encoding,
        `${mirror} plus <|almost a special`,
      )
    })

    test('reset clears the tracked text', () => {
      const counter = createIncrementalCounter(encoding)
      counter.update(buildProse(500, 5))
      counter.reset()
      expect(counter.count()).toBe(0)
      const fresh = 'fresh start'
      expect(counter.update(fresh)).toBe(encoding.countTokens(fresh))
    })

    test('200 seeded random edits on a ~4000 character base match countTokens', () => {
      const counter = createIncrementalCounter(encoding)
      const rand = mulberry32(20261016)
      let mirror = buildMixedBase(rand)
      mirror = verifyUpdate(counter, encoding, mirror)

      for (let i = 0; i < 200; i++) {
        if (rand() < 0.1) {
          // occasional whole-text replacement (exercises the full path)
          const next =
            rand() < 0.5
              ? buildMixedBase(rand)
              : buildProse(
                  1000 + Math.floor(rand() * 4000),
                  Math.floor(rand() * 26),
                )
          mirror = verifyUpdate(counter, encoding, next)
          continue
        }
        let start: number
        const pick = rand()
        if (pick < 0.5) {
          start = Math.floor(rand() * (mirror.length + 1))
        } else if (pick < 0.75) {
          start = Math.floor(rand() * 40)
        } else {
          start = Math.max(0, mirror.length - 40) + Math.floor(rand() * 41)
        }
        const deleteCap = rand() < 0.9 ? 40 : Math.ceil(mirror.length * 0.4)
        const deleteCount = Math.floor(
          rand() * (Math.min(mirror.length - start, deleteCap) + 1),
        )
        const insert =
          RANDOM_INSERTS[Math.floor(rand() * RANDOM_INSERTS.length)]!
        mirror = verifyEdit(
          counter,
          encoding,
          mirror,
          start,
          deleteCount,
          insert,
        )
      }

      const paths = counter.getPathCounts()
      expect(paths.append).toBeGreaterThan(0)
      expect(paths.dirty).toBeGreaterThan(0)
      expect(paths.full).toBeGreaterThan(0)
    })
  })
}
