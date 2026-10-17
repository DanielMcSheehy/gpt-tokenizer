// Benchmark for the sync-scan incremental token counter (src/incremental/sync-scan.ts).
// Run with: node --import node-resolve-ts/register scripts/bench-incremental-sync-scan.mjs
import process from 'node:process'
import o200k from '../src/encoding/o200k_base.js'
import { createIncrementalCounter } from '../src/incremental/sync-scan.js'

const OPS = 50

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

// Prose built from the fixed word list cycled until `length` is reached,
// with a newline inserted every 17 words.
const buildProse = (length, wordOffset = 0) => {
  let out = ''
  for (let i = 0; out.length < length; i++) {
    out += WORDS[(wordOffset + i) % WORDS.length]
    out += (i + 1) % 17 === 0 ? '\n' : ' '
  }
  return out.slice(0, length)
}

const buildExactLength = (length, wordOffset) => {
  let out = ''
  let i = 0
  while (out.length < length) {
    out += out ? ' ' : ''
    out += WORDS[(wordOffset + i) % WORDS.length]
    i++
  }
  return out.slice(0, length)
}

const timed = (fn) => {
  const start = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - start) / 1e6
}

// Best-of-N timing, the usual noise-robust estimator for short runs.
const bestOf = (repeats, fn) => {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < repeats; i++) {
    const elapsed = timed(fn)
    if (elapsed < best) {
      best = elapsed
    }
  }
  return best
}

const runWorkload = (name, setup) => {
  // Each op is one edit; `texts[i]` is the full string after op i, edits[i]
  // is the [start, deleteCount, insert] applied to texts[i - 1].
  const { initialText, edits, texts } = setup

  const incrementalResults = []
  const incrementalMs = bestOf(5, () => {
    incrementalResults.length = 0
    const counter = createIncrementalCounter(o200k)
    counter.update(initialText)
    for (const [start, deleteCount, insert] of edits) {
      incrementalResults.push(counter.applyEdit(start, deleteCount, insert))
    }
  })

  const baselineResults = []
  const baselineMs = bestOf(5, () => {
    baselineResults.length = 0
    for (const text of texts) {
      baselineResults.push(o200k.countTokens(text))
    }
  })

  let exact = true
  for (let i = 0; i < OPS; i++) {
    if (incrementalResults[i] !== baselineResults[i]) {
      exact = false
    }
  }

  return {
    name,
    exact,
    baselineMs,
    incrementalMs,
  }
}

const workloads = {}

// append: 12000-char base, then 50 times append a 20-char sentence
{
  const base = buildProse(12000)
  const sentences = Array.from({ length: OPS }, (_, i) =>
    buildExactLength(20, i * 3),
  )
  const edits = []
  const texts = []
  let text = base
  for (const sentence of sentences) {
    edits.push([text.length, 0, sentence])
    text += sentence
    texts.push(text)
  }
  const result = runWorkload('append', { initialText: base, edits, texts })
  workloads.append = result
}

// middleEdit: 12000-char base, 50 times replace 8 chars at the midpoint
{
  const base = buildProse(12000)
  const midpoint = Math.floor(base.length / 2)
  const words = Array.from(
    { length: OPS },
    (_, i) => WORDS[(i * 5) % WORDS.length],
  )
  const edits = []
  const texts = []
  let text = base
  for (const word of words) {
    edits.push([midpoint, 8, word])
    text = text.slice(0, midpoint) + word + text.slice(midpoint + 8)
    texts.push(text)
  }
  const result = runWorkload('middleEdit', {
    initialText: base,
    edits,
    texts,
  })
  workloads.middleEdit = result
}

// prefixEdit: 12000-char base, 50 times replace 8 chars at index 10
{
  const base = buildProse(12000)
  const words = Array.from(
    { length: OPS },
    (_, i) => WORDS[(i * 7) % WORDS.length],
  )
  const edits = []
  const texts = []
  let text = base
  for (const word of words) {
    edits.push([10, 8, word])
    text = text.slice(0, 10) + word + text.slice(18)
    texts.push(text)
  }
  const result = runWorkload('prefixEdit', {
    initialText: base,
    edits,
    texts,
  })
  workloads.prefixEdit = result
}

// chatTail: 10000-char stable prefix plus a changing 200-char tail, 50 tails
{
  const prefix = buildProse(10000)
  const tails = Array.from({ length: OPS + 1 }, (_, i) =>
    buildProse(200, i * 11),
  )
  const edits = []
  const texts = []
  for (let i = 1; i <= OPS; i++) {
    edits.push([prefix.length, tails[i - 1].length, tails[i]])
    texts.push(prefix + tails[i])
  }
  const result = runWorkload('chatTail', {
    initialText: prefix + tails[0],
    edits,
    texts,
  })
  workloads.chatTail = result
}

const cases = Object.keys(workloads).length * OPS
const exact = Object.values(workloads).every((w) => w.exact)

const output = {
  slug: 'sync-scan',
  exact,
  cases,
  workloads: Object.fromEntries(
    Object.entries(workloads).map(([name, w]) => [
      name,
      {
        baselineMs: w.baselineMs,
        incrementalMs: w.incrementalMs,
        speedup: w.incrementalMs > 0 ? w.baselineMs / w.incrementalMs : 0,
      },
    ]),
  ),
}

process.stdout.write(`${JSON.stringify(output)}\n`)
