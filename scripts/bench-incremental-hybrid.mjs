// Hybrid incremental token-counting benchmark. Prints exactly one JSON object:
// {"slug":"hybrid","exact":true,"cases":N,"workloads":{...},"pathCounts":{...}}
//
// Run with: node scripts/bench-incremental-hybrid.mjs
import { register } from 'node:module'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

// Load the TypeScript sources directly, the same loader the codegen scripts
// use, so the benchmark does not depend on a build step.
register('node-resolve-ts/register', pathToFileURL('./'))

const { default: encoding } = await import('../src/encoding/o200k_base.js')
const { createIncrementalCounter } =
  await import('../src/incremental/hybrid.js')

const OPS = 50
const ROUNDS = 5

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

// Fixed word list cycled until the target length, newline every 17 words.
function buildProse(targetLength, wordOffset = 0) {
  let out = ''
  let wordIndex = 0
  while (out.length < targetLength) {
    if (wordIndex > 0) {
      out += wordIndex % 17 === 0 ? '\n' : ' '
    }
    out += WORDS[(wordOffset + wordIndex) % WORDS.length]
    wordIndex++
  }
  return out.slice(0, targetLength)
}

const EIGHT_CHAR_WORDS = [
  'changing',
  'adjusted',
  'modified',
  'replaced',
  'shuffled',
  'rewiring',
  'variants',
  'swapping',
]

/**
 * Each workload produces: the initial text, `OPS` op-driving closures over a
 * fresh counter, and the `OPS` full texts those ops produce.
 */
function defineWorkload(kind) {
  if (kind === 'append') {
    const initial = buildProse(12000)
    const sentences = Array.from({ length: OPS }, (_, i) =>
      buildProse(20, 100 + 13 * i),
    )
    const states = []
    let current = initial
    for (let i = 0; i < OPS; i++) {
      current += sentences[i]
      states.push(current)
    }
    return {
      initial,
      states,
      drive: (counter, i) =>
        counter.applyEdit(initial.length + 20 * i, 0, sentences[i]),
    }
  }
  if (kind === 'middleEdit') {
    const initial = buildProse(12000)
    const midpoint = Math.floor(initial.length / 2)
    const states = []
    let current = initial
    for (let i = 0; i < OPS; i++) {
      const word = EIGHT_CHAR_WORDS[i % EIGHT_CHAR_WORDS.length]
      current = current.slice(0, midpoint) + word + current.slice(midpoint + 8)
      states.push(current)
    }
    return {
      initial,
      states,
      drive: (counter, i) =>
        counter.applyEdit(
          midpoint,
          8,
          EIGHT_CHAR_WORDS[i % EIGHT_CHAR_WORDS.length],
        ),
    }
  }
  if (kind === 'prefixEdit') {
    const initial = buildProse(12000)
    const states = []
    let current = initial
    for (let i = 0; i < OPS; i++) {
      const word = EIGHT_CHAR_WORDS[(i + 3) % EIGHT_CHAR_WORDS.length]
      current = current.slice(0, 10) + word + current.slice(18)
      states.push(current)
    }
    return {
      initial,
      states,
      drive: (counter, i) =>
        counter.applyEdit(
          10,
          8,
          EIGHT_CHAR_WORDS[(i + 3) % EIGHT_CHAR_WORDS.length],
        ),
    }
  }
  // chatTail: 10000-char stable prefix plus a changing 200-char tail.
  const prefix = buildProse(10000)
  const tails = Array.from({ length: OPS }, (_, i) =>
    buildProse(200, 7 + 31 * i),
  )
  return {
    initial: prefix,
    states: tails.map((tail) => prefix + tail),
    drive: (counter, i) =>
      counter.applyEdit(prefix.length, i === 0 ? 0 : 200, tails[i]),
  }
}

function runBaseline(workload) {
  const start = performance.now()
  let sum = 0
  sum += encoding.countTokens(workload.initial)
  for (const state of workload.states) {
    sum += encoding.countTokens(state)
  }
  const ms = performance.now() - start
  return { ms, sum }
}

function runIncremental(workload) {
  const start = performance.now()
  const counter = createIncrementalCounter(encoding)
  const results = [counter.update(workload.initial)]
  for (let i = 0; i < OPS; i++) {
    results.push(workload.drive(counter, i))
  }
  const ms = performance.now() - start
  return {
    ms,
    results,
    paths: counter.getPathCounts(),
    sum: results.reduce((a, b) => a + b, 0),
  }
}

const round3 = (value) => Math.round(value * 1000) / 1000

const workloads = {}
const pathCounts = { append: 0, dirty: 0, full: 0 }
let cases = 0
let mismatches = 0

for (const kind of ['append', 'middleEdit', 'prefixEdit', 'chatTail']) {
  const workload = defineWorkload(kind)

  // Warmup (JIT + merge cache), untimed and unchecked.
  runBaseline(workload)
  runIncremental(workload)

  let baselineMs = Number.POSITIVE_INFINITY
  let incrementalMs = Number.POSITIVE_INFINITY
  for (let round = 0; round < ROUNDS; round++) {
    baselineMs = Math.min(baselineMs, runBaseline(workload).ms)
    incrementalMs = Math.min(incrementalMs, runIncremental(workload).ms)
  }

  // Safety check: every op (and the initial update) must equal a full
  // countTokens on the same text. Runs untimed.
  const verification = runIncremental(workload)
  const expectations = [encoding.countTokens(workload.initial)]
  for (const state of workload.states) {
    expectations.push(encoding.countTokens(state))
  }
  for (let i = 0; i < verification.results.length; i++) {
    cases++
    if (verification.results[i] !== expectations[i]) {
      mismatches++
    }
  }

  pathCounts.append += verification.paths.append
  pathCounts.dirty += verification.paths.dirty
  pathCounts.full += verification.paths.full

  workloads[kind] = {
    baselineMs: round3(baselineMs),
    incrementalMs: round3(incrementalMs),
    speedup: round3(baselineMs / incrementalMs),
  }
}

process.stdout.write(
  `${JSON.stringify({
    slug: 'hybrid',
    exact: mismatches === 0,
    cases,
    workloads,
    pathCounts,
  })}\n`,
)
