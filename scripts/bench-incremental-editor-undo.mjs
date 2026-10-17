// Benchmark for the editor-undo incremental token counter.
//
// Prints exactly one JSON object to stdout:
//   {"slug":"editor-undo","exact":true,"cases":N,"workloads":{...}}
// Run it with:
//   node --import node-resolve-ts/register scripts/bench-incremental-editor-undo.mjs
//
// Uses o200k_base. Every workload applies 50 ops; the baseline is
// encoding.countTokens on the full resulting string for each op, and the
// incremental side drives createIncrementalCounter. Each side gets one
// untimed warmup pass first so both measure steady-state performance.
// `exact` is true only if every incremental count equals the baseline count.

import o200k from '../src/encoding/o200k_base.ts'
import { createIncrementalCounter } from '../src/incremental/editor-undo.ts'

const encoding = o200k

const WORDS = [
  'the',
  'quick',
  'brown',
  'fox',
  'jumps',
  'over',
  'lazy',
  'dogs',
  'while',
  'farmers',
  'watch',
  'sunset',
  'paint',
  'quiet',
  'hills',
  'green',
  'rivers',
  'flow',
  'under',
  'stone',
  'bridges',
  'old',
  'maps',
  'unfold',
]

/** Fixed word list cycled until `length` is reached, newline every 17 words. */
function buildProse(length, phase = 0) {
  let text = ''
  let i = phase
  while (text.length < length) {
    text += WORDS[i % WORDS.length]
    i++
    text += i % 17 === 0 ? '\n' : ' '
  }
  return text.slice(0, length)
}

function edited(text, start, deleteCount, insert) {
  return text.slice(0, start) + insert + text.slice(start + deleteCount)
}

function timed(run, warmup) {
  warmup()
  const start = performance.now()
  const result = run()
  return { ms: performance.now() - start, result }
}

const OPS = 50

// --- append: 12000-char base, then 50 times append a 20-char sentence -----
function workloadAppend() {
  const base = buildProse(12_000)
  const sentences = Array.from({ length: OPS }, (_, k) =>
    buildProse(20, 40 + k * 3),
  )
  const runBaseline = () => {
    const counts = []
    let text = base
    for (const sentence of sentences) {
      text += sentence
      counts.push(encoding.countTokens(text))
    }
    return counts
  }
  const runIncremental = () => {
    const counts = []
    const counter = createIncrementalCounter(encoding)
    counter.update(base)
    let length = base.length
    for (const sentence of sentences) {
      counts.push(counter.applyEdit(length, 0, sentence))
      length += sentence.length
    }
    return counts
  }
  return collect('append', runBaseline, runIncremental)
}

// --- middleEdit: 12000-char base, replace 8 chars at the midpoint ---------
function workloadMiddleEdit() {
  const base = buildProse(12_000)
  const words = Array.from(
    { length: OPS },
    (_, k) => WORDS[(k * 7) % WORDS.length],
  )
  const runBaseline = () => {
    const counts = []
    let text = base
    for (const word of words) {
      text = edited(text, 6000, 8, word)
      counts.push(encoding.countTokens(text))
    }
    return counts
  }
  const runIncremental = () => {
    const counts = []
    const counter = createIncrementalCounter(encoding)
    counter.update(base)
    for (const word of words) {
      counts.push(counter.applyEdit(6000, 8, word))
    }
    return counts
  }
  return collect('middleEdit', runBaseline, runIncremental)
}

// --- prefixEdit: 12000-char base, replace 8 chars at index 10 -------------
function workloadPrefixEdit() {
  const base = buildProse(12_000)
  const words = Array.from(
    { length: OPS },
    (_, k) => WORDS[(k * 5 + 3) % WORDS.length],
  )
  const runBaseline = () => {
    const counts = []
    let text = base
    for (const word of words) {
      text = edited(text, 10, 8, word)
      counts.push(encoding.countTokens(text))
    }
    return counts
  }
  const runIncremental = () => {
    const counts = []
    const counter = createIncrementalCounter(encoding)
    counter.update(base)
    for (const word of words) {
      counts.push(counter.applyEdit(10, 8, word))
    }
    return counts
  }
  return collect('prefixEdit', runBaseline, runIncremental)
}

// --- chatTail: 10000-char stable prefix plus a changing 200-char tail -----
// 10 of the 50 tails repeat a tail from 3-5 steps earlier, so the undo
// snapshot ring (16 entries) is actually exercised: those repeats return the
// stored count with no BPE work at all.
function workloadChatTail() {
  const prefix = buildProse(10_000)
  const tails = Array.from({ length: OPS }, (_, k) =>
    buildProse(200, 300 + k * 7),
  )
  const repeats = new Map([
    [7, 3],
    [12, 6],
    [17, 9],
    [22, 14],
    [27, 19],
    [32, 24],
    [37, 29],
    [42, 34],
    [47, 39],
    [49, 44],
  ])
  for (const [to, from] of repeats) {
    tails[to] = tails[from]
  }
  const runBaseline = () => {
    const counts = []
    for (const tail of tails) {
      counts.push(encoding.countTokens(prefix + tail))
    }
    return counts
  }
  const runIncremental = () => {
    const counts = []
    const counter = createIncrementalCounter(encoding)
    for (const tail of tails) {
      counts.push(counter.update(prefix + tail))
    }
    return counts
  }
  return collect('chatTail', runBaseline, runIncremental)
}

const output = {
  slug: 'editor-undo',
  exact: true,
  cases: 0,
  workloads: {},
}

function collect(name, runBaseline, runIncremental) {
  const { ms: baselineMs, result: baselineCounts } = timed(
    runBaseline,
    runBaseline,
  )
  const { ms: incrementalMs, result: incrementalCounts } = timed(
    runIncremental,
    runIncremental,
  )
  for (let k = 0; k < baselineCounts.length; k++) {
    output.cases++
    if (baselineCounts[k] !== incrementalCounts[k]) {
      output.exact = false
    }
  }
  const safeIncrementalMs = Math.max(incrementalMs, 0.001)
  output.workloads[name] = {
    baselineMs: Math.round(baselineMs * 1000) / 1000,
    incrementalMs: Math.round(incrementalMs * 1000) / 1000,
    speedup: Math.round((baselineMs / safeIncrementalMs) * 100) / 100,
  }
}

workloadAppend()
workloadMiddleEdit()
workloadPrefixEdit()
workloadChatTail()

console.log(JSON.stringify(output))
