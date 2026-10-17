import { performance } from 'node:perf_hooks'
import process from 'node:process'
import o200k from '../src/encoding/o200k_base.ts'
import { createIncrementalCounter } from '../src/incremental/append-fastpath.ts'

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

const OPS = 50

function prose(length) {
  let text = ''
  let count = 0
  while (text.length < length) {
    if (count > 0) {
      text += count % 17 === 0 ? '\n' : ' '
    }
    text += WORDS[count % WORDS.length]
    count++
  }
  return text.slice(0, length)
}

function sentence(index) {
  return ` ${WORDS[index % WORDS.length]} added.`.padEnd(20, 'x').slice(0, 20)
}

function word8(index, pad) {
  return WORDS[index % WORDS.length].padEnd(8, pad).slice(0, 8)
}

function tail(index) {
  return `tail${index}-${prose(200)}`.slice(0, 200)
}

function round(ms) {
  return Math.round(ms * 1000) / 1000
}

function states(setup, edits) {
  const texts = []
  let current = setup
  for (const edit of edits) {
    current = edit(current)
    texts.push(current)
  }
  return texts
}

function timeBaseline(texts) {
  const started = performance.now()
  for (const text of texts) {
    o200k.countTokens(text)
  }
  return performance.now() - started
}

function timeIncremental(setup, texts) {
  const counter = createIncrementalCounter(o200k)
  counter.update(setup)
  const hitsBefore = counter.fastPathHits
  const counts = []
  const started = performance.now()
  for (const text of texts) {
    counts.push(counter.update(text))
  }
  return {
    ms: performance.now() - started,
    counts,
    fastPathHits: counter.fastPathHits - hitsBefore,
  }
}

const appendBase = prose(12000)
const appendTexts = states(
  appendBase,
  Array.from({ length: OPS }, (_, index) => {
    const extra = sentence(index)
    return (text) => text + extra
  }),
)

const middleBase = prose(12000)
const middleAt = Math.floor(middleBase.length / 2)
const middleTexts = states(
  middleBase,
  Array.from({ length: OPS }, (_, index) => {
    const word = word8(index, 'x')
    return (text) => text.slice(0, middleAt) + word + text.slice(middleAt + 8)
  }),
)

const prefixBase = prose(12000)
const prefixTexts = states(
  prefixBase,
  Array.from({ length: OPS }, (_, index) => {
    const word = word8(index + 3, 'q')
    return (text) => text.slice(0, 10) + word + text.slice(18)
  }),
)

const chatPrefix = prose(10000)
const chatSetup = chatPrefix + tail(0)
const chatTexts = states(
  chatSetup,
  Array.from({ length: OPS }, (_, index) => {
    const next = chatPrefix + tail(index + 1)
    return () => next
  }),
)

// Warm the JIT and the merge cache, then time one steady-state pass of 50 ops.
for (const [setup, texts] of [
  [appendBase, appendTexts],
  [middleBase, middleTexts],
  [prefixBase, prefixTexts],
  [chatSetup, chatTexts],
]) {
  timeBaseline(texts)
  timeIncremental(setup, texts)
}

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[(sorted.length - 1) >> 1]
}

let exact = true
let cases = 0
const workloads = {}

function run(name, setup, texts) {
  const probe = timeIncremental(setup, texts)
  cases += texts.length
  for (let index = 0; index < texts.length; index++) {
    if (probe.counts[index] !== o200k.countTokens(texts[index])) {
      exact = false
    }
  }

  const baselineSamples = []
  const incrementalSamples = []
  let fastPathHits = probe.fastPathHits
  for (let pass = 0; pass < 5; pass++) {
    baselineSamples.push(timeBaseline(texts))
    const incremental = timeIncremental(setup, texts)
    incrementalSamples.push(incremental.ms)
    fastPathHits = incremental.fastPathHits
  }
  const baselineMs = median(baselineSamples)
  const incrementalMs = median(incrementalSamples)
  workloads[name] = {
    baselineMs: round(baselineMs),
    incrementalMs: round(incrementalMs),
    speedup: round(baselineMs / incrementalMs),
    fastPathHits,
  }
}

run('append', appendBase, appendTexts)
run('middleEdit', middleBase, middleTexts)
run('prefixEdit', prefixBase, prefixTexts)
run('chatTail', chatSetup, chatTexts)

process.stdout.write(
  `${JSON.stringify({
    slug: 'append-fastpath',
    exact,
    cases,
    workloads,
  })}\n`,
)
