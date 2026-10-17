import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.env.UTF16_FUZZ_BENCH !== '1') {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      'node-resolve-ts/register',
      fileURLToPath(import.meta.url),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, UTF16_FUZZ_BENCH: '1' },
      cwd: fileURLToPath(new URL('..', import.meta.url)),
    },
  )
  process.exit(result.status ?? 1)
}

const { default: encoding } = await import('../src/encoding/o200k_base.ts')
const { createIncrementalCounter } =
  await import('../src/incremental/utf16-fuzz.ts')

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

const EIGHT = [
  'absolute',
  'boundary',
  'counting',
  'encoding',
  'fraction',
  'gradient',
  'hardware',
  'interval',
  'junction',
  'keyboard',
]

function prose(target, offset = 0) {
  let out = ''
  let wordCount = 0
  let index = offset
  while (out.length < target) {
    if (wordCount > 0 && wordCount % 17 === 0) {
      out += '\n'
    } else if (out.length > 0 && !out.endsWith('\n')) {
      out += ' '
    }
    out += WORDS[index % WORDS.length]
    index += 1
    wordCount += 1
  }
  return out.slice(0, target)
}

function sentence(index) {
  const raw = `${WORDS[index % WORDS.length]} ${WORDS[(index + 5) % WORDS.length]} end`
  return `${raw}....................`.slice(0, 20)
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function measure(run) {
  const started = performance.now()
  run()
  return performance.now() - started
}

function verify(steps, exactFlag) {
  const counter = createIncrementalCounter(encoding)
  let text = steps[0].text
  counter.update(text)
  let exact = exactFlag
  for (let index = 1; index < steps.length; index++) {
    const step = steps[index]
    const got = counter.applyEdit(step.start, step.deleteCount, step.insert)
    text =
      text.slice(0, step.start) +
      step.insert +
      text.slice(step.start + step.deleteCount)
    if (got !== encoding.countTokens(text) || counter.count() !== got) {
      exact = false
    }
  }
  return exact
}

function workload(buildSteps) {
  const steps = buildSteps()
  encoding.countTokens(steps.at(-1).text)
  const warm = createIncrementalCounter(encoding)
  warm.update(steps[0].text)
  warm.applyEdit(steps[1].start, steps[1].deleteCount, steps[1].insert)

  const baselineMs = measure(() => {
    for (const step of steps.slice(1)) {
      encoding.countTokens(step.text)
    }
  })

  const counter = createIncrementalCounter(encoding)
  counter.update(steps[0].text)
  const incrementalMs = measure(() => {
    for (const step of steps.slice(1)) {
      counter.applyEdit(step.start, step.deleteCount, step.insert)
    }
  })

  return {
    baselineMs: round(baselineMs),
    incrementalMs: round(incrementalMs),
    speedup: round(baselineMs / incrementalMs),
    exact: verify(steps, true),
  }
}

function appendSteps() {
  let text = prose(12_000)
  const steps = [{ text, start: 0, deleteCount: 0, insert: '' }]
  for (let index = 0; index < 50; index++) {
    const insert = sentence(index)
    const start = text.length
    text += insert
    steps.push({ text, start, deleteCount: 0, insert })
  }
  return steps
}

function replaceSteps(length, at) {
  let text = prose(length)
  const steps = [{ text, start: 0, deleteCount: 0, insert: '' }]
  for (let index = 0; index < 50; index++) {
    const insert = EIGHT[index % EIGHT.length]
    const start = at(text)
    text = text.slice(0, start) + insert + text.slice(start + 8)
    steps.push({ text, start, deleteCount: 8, insert })
  }
  return steps
}

function chatTailSteps() {
  const prefix = prose(10_000)
  let text = prefix
  const steps = [{ text, start: 0, deleteCount: 0, insert: '' }]
  let previous = ''
  for (let index = 0; index < 50; index++) {
    const insert = prose(200, index + 1)
    const start = prefix.length
    text = prefix + insert
    steps.push({
      text,
      start,
      deleteCount: previous.length,
      insert,
    })
    previous = insert
  }
  return steps
}

const append = workload(appendSteps)
const middleEdit = workload(() =>
  replaceSteps(12_000, (text) => Math.floor(text.length / 2)),
)
const prefixEdit = workload(() => replaceSteps(12_000, () => 10))
const chatTail = workload(chatTailSteps)

const exact =
  append.exact && middleEdit.exact && prefixEdit.exact && chatTail.exact

function publish(result) {
  return {
    baselineMs: result.baselineMs,
    incrementalMs: result.incrementalMs,
    speedup: result.speedup,
  }
}

console.log(
  JSON.stringify({
    slug: 'utf16-fuzz',
    exact,
    cases: 200,
    workloads: {
      append: publish(append),
      middleEdit: publish(middleEdit),
      prefixEdit: publish(prefixEdit),
      chatTail: publish(chatTail),
    },
  }),
)
