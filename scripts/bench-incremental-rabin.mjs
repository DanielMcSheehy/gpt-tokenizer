// Benchmark for the Rabin-Karp incremental token counter (src/incremental/rabin.ts).
//
// Prints a single JSON object to stdout:
// {"slug":"rabin","exact":true,"cases":N,"fallbackRate":0,"workloads":{...}}
//
// Usage:
//   node scripts/bench-incremental-rabin.mjs
//
// Resolution order for the import target: the built ESM output (esm/, after
// `yarn build`) if present, otherwise the TypeScript sources via the
// node-resolve-ts loader used by the repo's codegen scripts.

import process from 'node:process'
import { performance } from 'node:perf_hooks'

async function loadEncoding() {
  try {
    return (await import('../esm/encoding/o200k_base.js')).default
  } catch {
    await import('node-resolve-ts/register')
    return (await import('../src/encoding/o200k_base.ts')).default
  }
}

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
  'near',
  'the',
  'riverbank',
  'while',
  'tokens',
  'are',
  'counted',
  'incrementally',
  'with',
  'rabin',
  'karp',
  'hashing',
  'and',
  'cached',
  'pieces',
  'of',
  'text',
  'split',
  'by',
  'the',
  'encoder',
  'regex',
]

/** Prose of exactly `length` chars from a fixed word list cycled to length,
 *  inserting a newline (instead of a space) every 17 words. */
function buildProse(length, wordOffset = 0) {
  let out = ''
  let index = wordOffset
  let wordCount = 0
  while (out.length < length) {
    if (wordCount > 0 && wordCount % 17 === 0) {
      out += '\n'
    } else {
      if (out.length > 0 && !out.endsWith('\n')) {
        out += ' '
      }
      out += WORDS[index++ % WORDS.length]
    }
    wordCount++
  }
  return out.slice(0, length)
}

const EIGHT_CHAR_WORDS = [
  'elephant',
  'sunshine',
  'mountain',
  'keyboard',
  'pipeline',
  'protocol',
  'sequence',
  'terminal',
]

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Runs one workload: 50 incremental ops vs countTokens on the full string.
 *  Returns {baselineMs, incrementalMs, speedup, fallbackRate, exact, cases}. */
function runWorkload(name, encoding, setupText, ops) {
  const { createIncrementalCounter } = incrementalModule
  const fullTexts = []
  let current = setupText
  for (const op of ops) {
    current =
      current.slice(0, op.start) +
      op.insert +
      current.slice(op.start + op.deleteCount)
    fullTexts.push(current)
  }

  // Warm-up (untimed): exercise both code paths on the first few states.
  {
    const warmCounter = createIncrementalCounter(encoding)
    warmCounter.update(setupText)
    for (let i = 0; i < Math.min(5, ops.length); i++) {
      warmCounter.applyEdit(ops[i].start, ops[i].deleteCount, ops[i].insert)
      encoding.countTokens(fullTexts[i])
    }
  }

  const baselineCounts = []
  encoding.clearMergeCache()
  let t0 = performance.now()
  for (let i = 0; i < ops.length; i++) {
    baselineCounts.push(encoding.countTokens(fullTexts[i]))
  }
  const baselineMs = performance.now() - t0

  const counter = createIncrementalCounter(encoding)
  counter.update(setupText)
  const fallbacksBefore = counter.fallbackCount
  const incrementalCounts = []
  encoding.clearMergeCache()
  t0 = performance.now()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    incrementalCounts.push(
      counter.applyEdit(op.start, op.deleteCount, op.insert),
    )
  }
  const incrementalMs = performance.now() - t0

  let exact = true
  for (let i = 0; i < ops.length; i++) {
    if (baselineCounts[i] !== incrementalCounts[i]) {
      exact = false
    }
  }
  const fallbackRate = (counter.fallbackCount - fallbacksBefore) / ops.length
  if (!exact) {
    process.stderr.write(
      `workload ${name}: mismatch detected (incremental is not exact)\n`,
    )
  }
  return {
    baselineMs: round(baselineMs),
    incrementalMs: round(incrementalMs),
    speedup: round(baselineMs / incrementalMs),
    fallbackRate: round(fallbackRate),
    exact,
    cases: ops.length,
  }
}

const encoding = await loadEncoding()
const incrementalModule = await (async () => {
  try {
    return await import('../esm/incremental/rabin.js')
  } catch {
    return await import('../src/incremental/rabin.ts')
  }
})()

const OPS = 50
const workloads = {}

// append: 12000-char base, then 50 times append a 20-char sentence
{
  const base = buildProse(12000)
  const ops = []
  let length = base.length
  for (let i = 0; i < OPS; i++) {
    ops.push({ start: length, deleteCount: 0, insert: buildProse(20, i * 3) })
    length += 20
  }
  workloads.append = runWorkload('append', encoding, base, ops)
}

// middleEdit: 12000-char base, 50 times replace 8 chars at the midpoint
{
  const base = buildProse(12000, 4)
  const mid = Math.floor(base.length / 2)
  const ops = []
  for (let i = 0; i < OPS; i++) {
    ops.push({
      start: mid,
      deleteCount: 8,
      insert: EIGHT_CHAR_WORDS[i % EIGHT_CHAR_WORDS.length],
    })
  }
  workloads.middleEdit = runWorkload('middleEdit', encoding, base, ops)
}

// prefixEdit: 12000-char base, 50 times replace 8 chars at index 10
{
  const base = buildProse(12000, 9)
  const ops = []
  for (let i = 0; i < OPS; i++) {
    ops.push({
      start: 10,
      deleteCount: 8,
      insert: EIGHT_CHAR_WORDS[(i + 3) % EIGHT_CHAR_WORDS.length],
    })
  }
  workloads.prefixEdit = runWorkload('prefixEdit', encoding, base, ops)
}

// chatTail: 10000-char stable prefix plus a changing 200-char tail, 50 tails
{
  const prefix = buildProse(10000, 7)
  const ops = []
  let prevTailLength = 0
  for (let i = 0; i < OPS; i++) {
    ops.push({
      start: prefix.length,
      deleteCount: prevTailLength,
      insert: buildProse(200, i * 5),
    })
    prevTailLength = 200
  }
  workloads.chatTail = runWorkload('chatTail', encoding, prefix, ops)
}

const totalCases =
  workloads.append.cases +
  workloads.middleEdit.cases +
  workloads.prefixEdit.cases +
  workloads.chatTail.cases
const exact =
  workloads.append.exact &&
  workloads.middleEdit.exact &&
  workloads.prefixEdit.exact &&
  workloads.chatTail.exact
const totalFallbacks =
  workloads.append.fallbackRate +
  workloads.middleEdit.fallbackRate +
  workloads.prefixEdit.fallbackRate +
  workloads.chatTail.fallbackRate

const summary = {
  slug: 'rabin',
  exact,
  cases: totalCases,
  fallbackRate: round(totalFallbacks / 4),
  workloads: {
    append: {
      baselineMs: workloads.append.baselineMs,
      incrementalMs: workloads.append.incrementalMs,
      speedup: workloads.append.speedup,
      fallbackRate: workloads.append.fallbackRate,
    },
    middleEdit: {
      baselineMs: workloads.middleEdit.baselineMs,
      incrementalMs: workloads.middleEdit.incrementalMs,
      speedup: workloads.middleEdit.speedup,
      fallbackRate: workloads.middleEdit.fallbackRate,
    },
    prefixEdit: {
      baselineMs: workloads.prefixEdit.baselineMs,
      incrementalMs: workloads.prefixEdit.incrementalMs,
      speedup: workloads.prefixEdit.speedup,
      fallbackRate: workloads.prefixEdit.fallbackRate,
    },
    chatTail: {
      baselineMs: workloads.chatTail.baselineMs,
      incrementalMs: workloads.chatTail.incrementalMs,
      speedup: workloads.chatTail.speedup,
      fallbackRate: workloads.chatTail.fallbackRate,
    },
  },
}

process.stdout.write(`${JSON.stringify(summary)}\n`)
