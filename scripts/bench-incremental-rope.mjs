// Benchmark for the rope-based incremental token counter.
// Prints exactly one JSON object to stdout:
// {"slug":"rope","exact":true,"cases":N,"workloads":{...}}
//
// Requires the package to be built (`yarn build`) so that ../esm exists.

import { performance } from 'node:perf_hooks'
import process from 'node:process'
import o200kBase from '../esm/encoding/o200k_base.js'
import { createIncrementalCounter } from '../esm/incremental/rope.js'

const OPS = 50

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
]

function prose(length, wordOffset = 0) {
  let out = ''
  let i = wordOffset
  while (out.length < length) {
    out += WORDS[i % WORDS.length]
    out += (i - wordOffset + 1) % 17 === 0 ? '\n' : ' '
    i++
  }
  return out.slice(0, length)
}

function measure(fn) {
  const start = performance.now()
  const result = fn()
  return [performance.now() - start, result]
}

function rounded(ms) {
  return Math.round(ms * 1000) / 1000
}

function workload(name, run) {
  const { baselineMs, incrementalMs, exact } = run()
  const safeIncremental = Math.max(incrementalMs, 1e-6)
  return [
    name,
    {
      baselineMs: rounded(baselineMs),
      incrementalMs: rounded(incrementalMs),
      speedup: Math.round((baselineMs / safeIncremental) * 1000) / 1000,
    },
    exact,
  ]
}

function appendWorkload() {
  const base = prose(12000)
  const sentence = prose(20)
  const counter = createIncrementalCounter(o200kBase)
  counter.update(base)
  let text = base
  let baselineMs = 0
  let incrementalMs = 0
  let exact = true
  for (let i = 0; i < OPS; i++) {
    text += sentence
    const [bt, expected] = measure(() => o200kBase.countTokens(text))
    baselineMs += bt
    const [it, got] = measure(() =>
      counter.applyEdit(text.length - sentence.length, 0, sentence),
    )
    incrementalMs += it
    exact = exact && got === expected
  }
  return { baselineMs, incrementalMs, exact }
}

function middleEditWorkload() {
  const base = prose(12000)
  const counter = createIncrementalCounter(o200kBase)
  counter.update(base)
  let text = base
  let baselineMs = 0
  let incrementalMs = 0
  let exact = true
  for (let i = 0; i < OPS; i++) {
    const mid = Math.floor(text.length / 2)
    const word = WORDS[(i * 7) % WORDS.length]
    const [bt, expected] = measure(() => {
      const next = text.slice(0, mid) + word + text.slice(mid + 8)
      const count = o200kBase.countTokens(next)
      text = next
      return count
    })
    baselineMs += bt
    const [it, got] = measure(() => counter.applyEdit(mid, 8, word))
    incrementalMs += it
    exact = exact && got === expected
  }
  return { baselineMs, incrementalMs, exact }
}

function prefixEditWorkload() {
  const base = prose(12000)
  const counter = createIncrementalCounter(o200kBase)
  counter.update(base)
  let text = base
  let baselineMs = 0
  let incrementalMs = 0
  let exact = true
  for (let i = 0; i < OPS; i++) {
    const word = WORDS[(i * 5 + 3) % WORDS.length]
    const [bt, expected] = measure(() => {
      const next = text.slice(0, 10) + word + text.slice(18)
      const count = o200kBase.countTokens(next)
      text = next
      return count
    })
    baselineMs += bt
    const [it, got] = measure(() => counter.applyEdit(10, 8, word))
    incrementalMs += it
    exact = exact && got === expected
  }
  return { baselineMs, incrementalMs, exact }
}

function chatTailWorkload() {
  const prefix = prose(10000)
  let tail = prose(200)
  const counter = createIncrementalCounter(o200kBase)
  counter.update(prefix + tail)
  let baselineMs = 0
  let incrementalMs = 0
  let exact = true
  for (let i = 0; i < OPS; i++) {
    const nextTail = prose(200, (i * 3) % WORDS.length)
    const [bt, expected] = measure(() =>
      o200kBase.countTokens(prefix + nextTail),
    )
    baselineMs += bt
    const [it, got] = measure(() =>
      counter.applyEdit(prefix.length, tail.length, nextTail),
    )
    incrementalMs += it
    tail = nextTail
    exact = exact && got === expected
  }
  return { baselineMs, incrementalMs, exact }
}

const results = [
  workload('append', appendWorkload),
  workload('middleEdit', middleEditWorkload),
  workload('prefixEdit', prefixEditWorkload),
  workload('chatTail', chatTailWorkload),
]

const exact = results.every(([, , isExact]) => isExact)
const output = {
  slug: 'rope',
  exact,
  cases: OPS * results.length,
  workloads: Object.fromEntries(results.map(([name, value]) => [name, value])),
}
process.stdout.write(`${JSON.stringify(output)}\n`)
