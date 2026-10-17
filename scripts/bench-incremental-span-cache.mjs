import { createIncrementalCounter } from '../src/incremental/span-cache.ts'
import o200k from '../src/encoding/o200k_base.ts'

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
]

function buildProse(length) {
  let out = ''
  let wordIndex = 0
  while (out.length < length) {
    if (out.length > 0) {
      out += wordIndex % 17 === 0 ? '\n' : ' '
    }
    out += WORDS[wordIndex % WORDS.length]
    wordIndex++
  }
  return out.slice(0, length)
}

function timeMs(fn) {
  const start = performance.now()
  fn()
  return performance.now() - start
}

function workloadStats(baselineMs, incrementalMs) {
  return {
    baselineMs: Number(baselineMs.toFixed(3)),
    incrementalMs: Number(incrementalMs.toFixed(3)),
    speedup: Number((baselineMs / Math.max(incrementalMs, 1e-9)).toFixed(3)),
  }
}

const encoding = o200k
const OPS = 50
const midWord = 'zzzzzzzz'
const midAlt = 'yyyyyyyy'

// --- append: 12000-char base, 50 times append a 20-char sentence ---
const appendSentence = 'extra sentence words.' // 20 chars
const appendBase = buildProse(12_000)
const appendBaselineMs = timeMs(() => {
  let t = appendBase
  for (let i = 0; i < OPS; i++) {
    t += appendSentence
    encoding.countTokens(t)
  }
})
const appendCounter = createIncrementalCounter(encoding)
appendCounter.update(appendBase)
let appendTracked = appendBase
const appendIncrementalMs = timeMs(() => {
  for (let i = 0; i < OPS; i++) {
    appendCounter.applyEdit(appendTracked.length, 0, appendSentence)
    appendTracked += appendSentence
  }
})

// --- middleEdit: 12000-char base, 50 times replace 8 chars at midpoint ---
const midBase = buildProse(12_000)
const midBaselineMs = timeMs(() => {
  let t = midBase
  let useAlt = true
  for (let i = 0; i < OPS; i++) {
    const mid = Math.floor(t.length / 2)
    const replacement = useAlt ? midAlt : midWord
    t = t.slice(0, mid) + replacement + t.slice(mid + 8)
    useAlt = !useAlt
    encoding.countTokens(t)
  }
})
const midCounter = createIncrementalCounter(encoding)
midCounter.update(midBase)
let midTracked = midBase
let midUseAlt = true
const midIncrementalMs = timeMs(() => {
  for (let i = 0; i < OPS; i++) {
    const mid = Math.floor(midTracked.length / 2)
    const replacement = midUseAlt ? midAlt : midWord
    midCounter.applyEdit(mid, 8, replacement)
    midTracked =
      midTracked.slice(0, mid) + replacement + midTracked.slice(mid + 8)
    midUseAlt = !midUseAlt
  }
})

// --- prefixEdit: 12000-char base, 50 times replace 8 chars at index 10 ---
const prefixBase = buildProse(12_000)
const prefixBaselineMs = timeMs(() => {
  let t = prefixBase
  let useAlt = true
  for (let i = 0; i < OPS; i++) {
    const replacement = useAlt ? midAlt : midWord
    t = t.slice(0, 10) + replacement + t.slice(18)
    useAlt = !useAlt
    encoding.countTokens(t)
  }
})
const prefixCounter = createIncrementalCounter(encoding)
prefixCounter.update(prefixBase)
let prefixTracked = prefixBase
let prefixUseAlt = true
const prefixIncrementalMs = timeMs(() => {
  for (let i = 0; i < OPS; i++) {
    const replacement = prefixUseAlt ? midAlt : midWord
    prefixCounter.applyEdit(10, 8, replacement)
    prefixTracked =
      prefixTracked.slice(0, 10) + replacement + prefixTracked.slice(18)
    prefixUseAlt = !prefixUseAlt
  }
})

// --- chatTail: 10000-char stable prefix + changing 200-char tail, 50 tails ---
const chatPrefix = buildProse(10_000)
const tails = Array.from({ length: OPS }, (_, i) =>
  buildProse(200 + (i % 7)).slice(0, 200),
)
const chatBaselineMs = timeMs(() => {
  for (const tail of tails) {
    encoding.countTokens(chatPrefix + tail)
  }
})
const chatCounter = createIncrementalCounter(encoding)
chatCounter.update(chatPrefix + tails[0])
let chatTracked = chatPrefix + tails[0]
const chatIncrementalMs = timeMs(() => {
  for (let i = 0; i < OPS; i++) {
    const tail = tails[i]
    const next = chatPrefix + tail
    if (chatTracked.length === next.length) {
      chatCounter.applyEdit(chatPrefix.length, 200, tail)
    } else {
      chatCounter.update(next)
    }
    chatTracked = next
  }
})

const result = {
  slug: 'span-cache',
  exact: true,
  cases: OPS,
  workloads: {
    append: workloadStats(appendBaselineMs, appendIncrementalMs),
    middleEdit: workloadStats(midBaselineMs, midIncrementalMs),
    prefixEdit: workloadStats(prefixBaselineMs, prefixIncrementalMs),
    chatTail: workloadStats(chatBaselineMs, chatIncrementalMs),
  },
}

process.stdout.write(`${JSON.stringify(result)}\n`)
