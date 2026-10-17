/**
 * Benchmark for the Fenwick-tree incremental token counter.
 *
 * Prints a single JSON object to stdout:
 * {"slug":"fenwick","exact":true,"cases":N,"workloads":{...}}
 *
 * Run with:
 *   node --import node-resolve-ts/register scripts/bench-incremental-fenwick.mjs
 */
import o200kBase from '../src/encoding/o200k_base.ts'
import { createIncrementalCounter } from '../src/incremental/fenwick.ts'

import { performance } from 'node:perf_hooks'
import { stdout } from 'node:process'

const encoding = o200kBase
const OPS = 50

const WORDS =
  'the quick brown fox jumps over a lazy dog and runs through green fields of golden wheat while counting tokens for every model in sight beyond the horizon'.split(
    ' ',
  )

function buildProse(length, wordOffset = 0) {
  let out = ''
  let i = 0
  while (out.length < length) {
    const word = WORDS[(wordOffset + i) % WORDS.length]
    out += i > 0 && i % 17 === 0 ? `\n${word}` : ` ${word}`
    i++
  }
  return out.slice(0, length)
}

function sentenceAt(index) {
  // ~20-char sentence, different for each index
  let out = ''
  let i = 0
  while (out.length < 20) {
    out += ` ${WORDS[(index * 7 + i) % WORDS.length]}`
    i++
  }
  return out.slice(1, 21)
}

const REPLACEMENTS = Array.from({ length: OPS }, (_, i) =>
  `word${(i * 13) % 997}`.padEnd(8, 'x').slice(0, 8),
)

function timed(fn) {
  const start = performance.now()
  const value = fn()
  const end = performance.now()
  return { value, ms: end - start }
}

let cases = 0
let exact = true

function check(got, expected) {
  cases++
  if (got !== expected) {
    exact = false
  }
}

function runWorkload(name, { baseLength }, ops) {
  // ops: array of { start, deleteCount, insert } relative to the evolving text
  const base = buildProse(baseLength)

  // Pre-build the full texts the baseline will count, and verify incremental
  // results against countTokens on the same texts.
  const fullTexts = []
  {
    let text = base
    for (const op of ops) {
      text =
        text.slice(0, op.start) +
        op.insert +
        text.slice(op.start + op.deleteCount)
      fullTexts.push(text)
    }
  }

  const runBaseline = () => fullTexts.map((text) => encoding.countTokens(text))

  const runIncremental = () => {
    const counter = createIncrementalCounter(encoding)
    const results = [counter.update(base)]
    for (const op of ops) {
      results.push(counter.applyEdit(op.start, op.deleteCount, op.insert))
    }
    return results
  }

  // Warmup (untimed): run both sides fully so JIT tiers and the shared BPE
  // merge cache are equally hot before measuring.
  runBaseline()
  runIncremental()

  const { value: baselineResults, ms: baselineMs } = timed(runBaseline)
  const { value: incrementalResults, ms: incrementalMs } = timed(runIncremental)

  // exactness: setup + one result per op
  check(incrementalResults[0], encoding.countTokens(base))
  for (let i = 0; i < ops.length; i++) {
    check(incrementalResults[i + 1], baselineResults[i])
  }

  const speedup = incrementalMs > 0 ? baselineMs / incrementalMs : 0
  return {
    baselineMs: Number(baselineMs.toFixed(3)),
    incrementalMs: Number(incrementalMs.toFixed(3)),
    speedup: Number(speedup.toFixed(2)),
  }
}

function appendOps(baseLength) {
  const ops = []
  let length = baseLength
  for (let i = 0; i < OPS; i++) {
    ops.push({ start: length, deleteCount: 0, insert: sentenceAt(i) })
    length += 20
  }
  return ops
}

function middleEditOps(baseLength) {
  const ops = []
  for (let i = 0; i < OPS; i++) {
    ops.push({
      start: Math.floor(baseLength / 2) - 4,
      deleteCount: 8,
      insert: REPLACEMENTS[i],
    })
  }
  return ops
}

function prefixEditOps() {
  const ops = []
  for (let i = 0; i < OPS; i++) {
    ops.push({ start: 10, deleteCount: 8, insert: REPLACEMENTS[i] })
  }
  return ops
}

function chatTailOps(prefixLength, tailLength) {
  const ops = []
  for (let i = 0; i < OPS; i++) {
    const tail = buildProse(tailLength, i * 11 + 5)
    ops.push({ start: prefixLength, deleteCount: tailLength, insert: tail })
  }
  return ops
}

const workloads = {
  append: runWorkload('append', { baseLength: 12_000 }, appendOps(12_000)),
  middleEdit: runWorkload(
    'middleEdit',
    { baseLength: 12_000 },
    middleEditOps(12_000),
  ),
  prefixEdit: runWorkload(
    'prefixEdit',
    { baseLength: 12_000 },
    prefixEditOps(),
  ),
  chatTail: runWorkload(
    'chatTail',
    { baseLength: 10_000 },
    chatTailOps(10_000, 200),
  ),
}

stdout.write(
  `${JSON.stringify({ slug: 'fenwick', exact, cases, workloads })}\n`,
)
