import encoding from '../src/encoding/o200k_base.js'
import { createIncrementalCounter } from '../src/incremental/piece-hash.js'

const OPS = 50
// Reported times are the median of this many 50-op passes, after one warmup.
const MEASURED_RUNS = 9

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
  'token',
  'count',
  'prompt',
  'cache',
  'piece',
  'merge',
]

function buildProse(targetLength, startWord = 0) {
  let text = ''
  let wordCount = 0
  let index = startWord
  while (text.length < targetLength) {
    if (wordCount > 0) {
      text += wordCount % 17 === 0 ? '\n' : ' '
    }
    text += WORDS[index % WORDS.length]
    wordCount += 1
    index += 1
  }
  return text.slice(0, targetLength)
}

function applyEdit(text, start, deleteCount, insert) {
  return text.slice(0, start) + insert + text.slice(start + deleteCount)
}

function sentence(index) {
  const n = String(index).padStart(2, '0')
  return `\nEnd line ${n} now!!!!`
}

function replacement(index) {
  return `Z${String(index).padStart(6, '0')}Q`
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function collectGarbage() {
  global.gc?.()
}

function prepare(initial, editAt) {
  const edits = []
  const texts = []
  let text = initial
  for (let index = 0; index < OPS; index += 1) {
    const edit = editAt(text, index)
    edits.push(edit)
    text = applyEdit(text, edit.start, edit.deleteCount, edit.insert)
    texts.push(text)
  }
  return { edits, texts }
}

let cases = 0
let mismatches = 0

function verify(counts, texts) {
  for (let index = 0; index < OPS; index += 1) {
    cases += 1
    if (counts[index] !== encoding.countTokens(texts[index])) mismatches += 1
  }
}

function timeBaseline(texts) {
  collectGarbage()
  const start = process.hrtime.bigint()
  for (let index = 0; index < OPS; index += 1) {
    encoding.countTokens(texts[index])
  }
  return Number(process.hrtime.bigint() - start) / 1e6
}

function timeIncremental(initial, edits) {
  const counter = createIncrementalCounter(encoding)
  counter.update(initial)
  const counts = new Array(OPS)
  collectGarbage()
  const start = process.hrtime.bigint()
  for (let index = 0; index < OPS; index += 1) {
    const edit = edits[index]
    counts[index] = counter.applyEdit(edit.start, edit.deleteCount, edit.insert)
  }
  return {
    ms: Number(process.hrtime.bigint() - start) / 1e6,
    counts,
  }
}

function timeWorkload(initial, editAt) {
  const { edits, texts } = prepare(initial, editAt)
  timeBaseline(texts)
  verify(timeIncremental(initial, edits).counts, texts)

  const baselineSamples = []
  const incrementalSamples = []
  for (let run = 0; run < MEASURED_RUNS; run += 1) {
    baselineSamples.push(timeBaseline(texts))
    const sample = timeIncremental(initial, edits)
    incrementalSamples.push(sample.ms)
    verify(sample.counts, texts)
  }

  const baselineMs = median(baselineSamples)
  const incrementalMs = median(incrementalSamples)
  return {
    baselineMs: round(baselineMs),
    incrementalMs: round(incrementalMs),
    speedup: round(baselineMs / incrementalMs),
  }
}

if (sentence(0).length !== 20 || sentence(49).length !== 20) {
  throw new Error(`sentence length ${sentence(0).length}`)
}
if (replacement(0).length !== 8) {
  throw new Error(`replacement length ${replacement(0).length}`)
}

const sample = buildProse(400)
const warmupCounter = createIncrementalCounter(encoding)
for (let index = 0; index < 5; index += 1) {
  const text = `${sample}${index}`
  encoding.countTokens(text)
  warmupCounter.update(text)
}

const appendBase = buildProse(12_000)
const append = timeWorkload(appendBase, (text, index) => ({
  start: text.length,
  deleteCount: 0,
  insert: sentence(index),
}))

const middleBase = buildProse(12_000)
const midpoint = Math.floor(middleBase.length / 2)
const middleEdit = timeWorkload(middleBase, (_text, index) => ({
  start: midpoint,
  deleteCount: 8,
  insert: replacement(index),
}))

const prefixBase = buildProse(12_000)
const prefixEdit = timeWorkload(prefixBase, (_text, index) => ({
  start: 10,
  deleteCount: 8,
  insert: replacement(index + 50),
}))

const chatPrefix = buildProse(10_000)
const tails = Array.from({ length: OPS }, (_, index) =>
  buildProse(200, 100 + index * 3),
)
const chatTail = timeWorkload(chatPrefix, (text, index) => ({
  start: chatPrefix.length,
  deleteCount: text.length - chatPrefix.length,
  insert: tails[index],
}))

console.log(
  JSON.stringify({
    slug: 'piece-hash',
    exact: mismatches === 0,
    cases,
    workloads: { append, middleEdit, prefixEdit, chatTail },
  }),
)
