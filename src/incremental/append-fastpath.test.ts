import { describe, expect, test } from 'vite-plus/test'
import cl100k from '../encoding/cl100k_base.js'
import o200k from '../encoding/o200k_base.js'
import type { GptEncoding } from '../GptEncoding.js'
import { EndOfPrompt, EndOfText } from '../specialTokens.js'
import { createIncrementalCounter } from './append-fastpath.js'

const encodings = [
  ['o200k_base', o200k],
  ['cl100k_base', cl100k],
] as const

function thrownMessage(run: () => void): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

function prose(length: number): string {
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
  let text = ''
  let count = 0
  while (text.length < length) {
    if (count > 0) {
      text += count % 17 === 0 ? '\n' : ' '
    }
    text += words[count % words.length]!
    count++
  }
  return text.slice(0, length)
}

function expectCount(
  encoding: GptEncoding,
  text: string,
  actual: number,
): void {
  expect(actual, JSON.stringify(text)).toBe(encoding.countTokens(text))
}

for (const [name, encoding] of encodings) {
  describe(name, () => {
    test('empty string', () => {
      const counter = createIncrementalCounter(encoding)
      expect(counter.count()).toBe(0)
      expectCount(encoding, '', counter.update(''))
      counter.update('hello')
      counter.reset()
      expect(counter.count()).toBe(0)
      expectCount(encoding, '', counter.update(''))
    })

    test('ascii append, delete, and middle substitution', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'the quick brown fox'
      expectCount(encoding, text, counter.update(text))

      text += ' jumps'
      expectCount(
        encoding,
        text,
        counter.applyEdit(text.length - ' jumps'.length, 0, ' jumps'),
      )

      const fox = text.indexOf('fox')
      text = text.slice(0, fox) + 'dog' + text.slice(fox + 3)
      expectCount(encoding, text, counter.applyEdit(fox, 3, 'dog'))

      text = text.slice(0, -6)
      expectCount(encoding, text, counter.applyEdit(text.length, 6, ''))
      expect(counter.count()).toBe(encoding.countTokens(text))
    })

    test('edit at index 0 and at the end', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'abcdef'
      expectCount(encoding, text, counter.update(text))

      text = `Z${text}`
      expectCount(encoding, text, counter.applyEdit(0, 0, 'Z'))

      text = text.slice(1)
      expectCount(encoding, text, counter.applyEdit(0, 1, ''))

      text = `${text}YZ`
      expectCount(encoding, text, counter.applyEdit(text.length - 2, 0, 'YZ'))

      text = text.slice(0, -2)
      expectCount(encoding, text, counter.applyEdit(text.length, 2, ''))
    })

    test('emoji and CJK surrogate pairs', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'hi 👋 there 你好'
      expectCount(encoding, text, counter.update(text))

      const emoji = text.indexOf('👋')
      text = text.slice(0, emoji) + text.slice(emoji + 2)
      expectCount(encoding, text, counter.applyEdit(emoji, 2, ''))

      const cjk = text.indexOf('你好')
      text = text.slice(0, cjk) + '世界' + text.slice(cjk + 2)
      expectCount(encoding, text, counter.applyEdit(cjk, 2, '世界'))

      text += '🌟'
      expectCount(encoding, text, counter.applyEdit(text.length - 2, 0, '🌟'))

      // Split a surrogate pair. The oracle counts the unpaired unit as-is.
      const star = text.indexOf('🌟')
      text = text.slice(0, star) + text.slice(star + 1)
      expectCount(encoding, text, counter.applyEdit(star, 1, ''))
    })

    test('whitespace lookahead and trailing end anchor', () => {
      const counter = createIncrementalCounter(encoding)
      let text = 'hello   '
      expectCount(encoding, text, counter.update(text))

      text += 'x'
      expectCount(encoding, text, counter.applyEdit(text.length - 1, 0, 'x'))

      text = text.slice(0, -1)
      expectCount(encoding, text, counter.applyEdit(text.length, 1, ''))

      text = 'hello  x'
      expectCount(encoding, text, counter.update(text))
      text = 'hello  '
      expectCount(encoding, text, counter.update(text))

      text = 'word\n   '
      expectCount(encoding, text, counter.update(text))
      text = 'word\n   x'
      expectCount(encoding, text, counter.applyEdit('word\n   '.length, 0, 'x'))
      text = 'word\n   '
      expectCount(encoding, text, counter.applyEdit(text.length, 1, ''))

      text = 'a  b'
      expectCount(encoding, text, counter.update(text))
      text = 'a  '
      expectCount(encoding, text, counter.applyEdit(3, 1, ''))

      text = 'end\n'
      expectCount(encoding, text, counter.update(text))
      text = 'end\n '
      expectCount(encoding, text, counter.applyEdit(text.length - 1, 0, ' '))
      text = 'end\n'
      expectCount(encoding, text, counter.applyEdit(text.length, 1, ''))

      text = 'gap\u0085  x'
      expectCount(encoding, text, counter.update(text))
      text = 'gap\u0085  '
      expectCount(encoding, text, counter.update(text))

      text = 'bom\uFEFF'
      expectCount(encoding, text, counter.update(text))
      text = 'bom\uFEFFx'
      expectCount(encoding, text, counter.applyEdit(text.length - 1, 0, 'x'))
    })

    test('suffix append can extend the previous piece', () => {
      const counter = createIncrementalCounter(encoding)
      expectCount(encoding, 'hello', counter.update('hello'))
      expectCount(encoding, 'helloworld', counter.update('helloworld'))
      expectCount(encoding, 'HELLO', counter.update('HELLO'))
      expectCount(encoding, 'HELLOa', counter.update('HELLOa'))
      expectCount(encoding, "don'", counter.update("don'"))
      expectCount(encoding, "don's", counter.applyEdit(4, 0, 's'))
      expectCount(encoding, "we'll", counter.update("we'll"))
      expectCount(encoding, "we'l", counter.update("we'l"))
      expectCount(encoding, "we'll", counter.applyEdit(4, 0, 'l'))
      expectCount(encoding, '123', counter.update('123'))
      expectCount(encoding, '1234', counter.applyEdit(3, 0, '4'))
      expectCount(encoding, '123', counter.applyEdit(3, 1, ''))
    })

    test('long stable prefix with a small suffix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const base = prose(3500)
      expectCount(encoding, base, counter.update(base))
      const hits = counter.fastPathHits
      const next = `${base.slice(0, -5)}omega`
      expectCount(
        encoding,
        next,
        counter.applyEdit(base.length - 5, 5, 'omega'),
      )
      expect(counter.fastPathHits).toBe(hits + 1)
      expectCount(encoding, `${next} tail`, counter.update(`${next} tail`))
    })

    test('long stable suffix with a small prefix edit', () => {
      const counter = createIncrementalCounter(encoding)
      const base = prose(3500)
      expectCount(encoding, base, counter.update(base))
      const next = `QQ${base.slice(8)}`
      expectCount(encoding, next, counter.applyEdit(0, 8, 'QQ'))
      const mid = Math.floor(next.length / 2)
      const replaced = next.slice(0, mid) + 'replaced' + next.slice(mid + 8)
      expectCount(encoding, replaced, counter.applyEdit(mid, 8, 'replaced'))
    })

    test('default special-token policy matches countTokens, including errors', () => {
      const counter = createIncrementalCounter(encoding)
      const clean = 'hello world'
      expectCount(encoding, clean, counter.update(clean))

      const embedded = `hello ${EndOfText} world`
      expect(thrownMessage(() => counter.update(embedded))).toBe(
        thrownMessage(() => encoding.countTokens(embedded)),
      )
      expect(counter.count()).toBe(encoding.countTokens(clean))

      const insertedAt = clean.indexOf(' ')
      expect(
        thrownMessage(() => counter.applyEdit(insertedAt, 0, EndOfText)),
      ).toBe(
        thrownMessage(() =>
          encoding.countTokens(
            clean.slice(0, insertedAt) + EndOfText + clean.slice(insertedAt),
          ),
        ),
      )
      expect(counter.count()).toBe(encoding.countTokens(clean))

      const partial = `prefix ${EndOfText.slice(0, -3)}`
      expectCount(encoding, partial, counter.update(partial))
      const completed = partial + EndOfText.slice(-3)
      expect(
        thrownMessage(() =>
          counter.applyEdit(partial.length, 0, EndOfText.slice(-3)),
        ),
      ).toBe(thrownMessage(() => encoding.countTokens(completed)))
      expect(counter.count()).toBe(encoding.countTokens(partial))

      const prompt = `before ${EndOfPrompt} after`
      expect(thrownMessage(() => counter.update(prompt))).toBe(
        thrownMessage(() => encoding.countTokens(prompt)),
      )

      // Deleting the special token joins the surrounding segments again.
      const without = prompt.replace(EndOfPrompt, '')
      expectCount(encoding, without, counter.update(without))
      const rejoined = `before ${'x'.repeat(EndOfPrompt.length)} after`
      expectCount(encoding, rejoined, counter.update(rejoined))
    })

    test('200 seeded random edits on a 4000 character base', () => {
      const counter = createIncrementalCounter(encoding)
      let text = prose(4000)
      expectCount(encoding, text, counter.update(text))

      let seed = 0xc4b82d + text.length
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      const alphabet = "abcXYZ \n\t.,'!123你👋\u00A0\u0085\uFEFF"

      for (let edit = 0; edit < 200; edit++) {
        const start = Math.floor(random() * (text.length + 1))
        const roll = random()
        if (roll < 0.34) {
          const extra = alphabet[Math.floor(random() * alphabet.length)]!
          text = text.slice(0, start) + extra + text.slice(start)
          expectCount(encoding, text, counter.applyEdit(start, 0, extra))
        } else if (roll < 0.67) {
          if (text.length === 0) {
            continue
          }
          const at = Math.min(start, text.length - 1)
          text = text.slice(0, at) + text.slice(at + 1)
          expectCount(encoding, text, counter.applyEdit(at, 1, ''))
        } else {
          const width = Math.min(8, text.length - start)
          let insert = ''
          const length = 1 + Math.floor(random() * 6)
          for (let unit = 0; unit < length; unit++) {
            insert += alphabet[Math.floor(random() * alphabet.length)]!
          }
          text = text.slice(0, start) + insert + text.slice(start + width)
          expectCount(encoding, text, counter.applyEdit(start, width, insert))
        }
      }
    })
  })
}
