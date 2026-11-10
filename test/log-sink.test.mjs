import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLogSink } from '../src/log-sink.js'

const MiB = 1024 * 1024

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-log-test-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

// Auto-flush is disabled by default in tests so every write is observable
// without sleeping; tests that exercise the timer opt back in explicitly.
function sinkAt(t, dir, extra = {}) {
  const sink = createLogSink({
    dir,
    fileName: 'runtime.log',
    flushIntervalMs: 0,
    ...extra,
  })
  t.after(async () => {
    await sink.close()
  })
  return sink
}

async function readLines(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return text.split('\n').filter(Boolean)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

async function parseFile(file) {
  const lines = await readLines(file)
  return lines.map((line) => JSON.parse(line))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('ignores records below warn severity', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  assert.equal(sink.capture({ level: 'info', name: 'a', args: ['nope'] }), false)
  assert.equal(sink.capture({ level: 'debug', name: 'a', args: ['nope'] }), false)
  assert.equal(sink.capture({ level: 'trace', name: 'a', args: ['nope'] }), false)
  assert.equal(sink.capture({ name: 'a', args: ['no level'] }), false)

  await sink.flush()

  const stats = sink.stats()
  assert.equal(stats.accepted, 0)
  assert.equal(stats.ignored, 4)
  assert.deepEqual(await parseFile(path.join(dir, 'runtime.log')), [])
})

test('writes warn and error records as JSONL in arrival order', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  assert.equal(
    sink.capture({ level: 'warn', name: 'plugin-a', args: ['slow', 'operation', 42] }),
    true,
  )
  sink.capture({ level: 'error', name: 'plugin-b', args: ['boom'] })
  sink.capture({ level: 'WARN', name: 'plugin-c', args: [{ nested: true }] })

  await sink.flush()

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.equal(records.length, 3)
  assert.deepEqual(records.map((r) => r.level), ['warn', 'error', 'warn'])
  assert.deepEqual(records.map((r) => r.name), ['plugin-a', 'plugin-b', 'plugin-c'])
  assert.match(records[0].message, /slow operation 42/)
  assert.equal(typeof records[0].time, 'string')
  assert.ok(Number.isFinite(Date.parse(records[0].time)))
  assert.equal(records[2].message, '[Object]')
  assert.equal(sink.stats().written, 3)
})

test('accepts numeric levels through the configurable level map', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { levels: ['error', 'warn', 'info', 'debug'] })

  sink.capture({ level: 1, name: 'n', args: ['warn-level'] })
  sink.capture({ level: 0, name: 'n', args: ['error-level'] })
  sink.capture({ level: 2, name: 'n', args: ['info-level'] })

  await sink.flush()

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(records.map((r) => r.level), ['warn', 'error'])
  assert.equal(sink.stats().ignored, 1)
})

test('capture never throws on hostile values', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  const circular = { a: 1 }
  circular.self = circular
  circular.arr = [circular, { back: circular }]

  const throwingGetter = {
    ok: 'visible',
    get boom() {
      throw new Error('getter exploded')
    },
  }

  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys exploded')
      },
      get() {
        throw new Error('get exploded')
      },
    },
  )

  let deep = {}
  const head = deep
  for (let i = 0; i < 5000; i++) {
    deep.next = {}
    deep = deep.next
  }

  const values = [
    circular,
    BigInt(9007199254740993),
    Symbol('token'),
    function named() {},
    throwingGetter,
    hostileProxy,
    head,
    undefined,
    null,
    1n,
  ]

  assert.doesNotThrow(() => sink.capture({ level: 'warn', name: 'hostile', args: values }))

  await sink.flush()

  const lines = await readLines(path.join(dir, 'runtime.log'))
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.level, 'warn')
  assert.equal(typeof record.message, 'string')
  assert.match(record.message, /\[Object\]/)
  assert.match(record.message, /\[Symbol\]/)
  assert.match(record.message, /\[Function\]/)
  assert.ok(Buffer.byteLength(lines[0]) <= 16 * 1024)
  assert.equal(sink.stats().errors, 0)
})

test('preserves native Error own string data name, message and stack', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  const err = new Error('disk on fire')
  err.name = 'RuntimeBoom'
  // Materialize intentionally in caller code, then supply an own data field.
  Object.defineProperty(err, 'stack', { value: err.stack, configurable: true, writable: true })

  sink.capture({ level: 'error', name: 'plugin', args: ['failed:', err] })
  await sink.flush()

  const [record] = await parseFile(path.join(dir, 'runtime.log'))
  assert.equal(record.level, 'error')
  assert.match(record.message, /RuntimeBoom/)
  assert.match(record.message, /disk on fire/)
  assert.equal(typeof record.stack, 'string')
  if (Number(process.versions.node.split('.')[0]) >= 24) assert.match(record.stack, /RuntimeBoom: disk on fire/)
  else assert.equal(record.stack, '[Stack unavailable]')
})

test('redacts secret-like keys and bearer/api-key text', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  const secrets = {
    password: 'hunter2-password-value',
    apiKey: 'api-key-value-1234',
    nested: { token: 'nested-token-value' },
    authorization: 'Basic dXNlcjpwYXNz',
    'x-api-key': 'x-api-key-value-5678',
  }

  sink.capture({
    level: 'error',
    name: 'auth',
    args: [
      secrets,
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'using sk-abcdefghijklmnopqrstuvwx',
      'api_key=supersecretvalue',
    ],
  })
  await sink.flush()

  const text = await fs.readFile(path.join(dir, 'runtime.log'), 'utf8')
  assert.ok(!text.includes('hunter2-password-value'), 'password value leaked')
  assert.ok(!text.includes('api-key-value-1234'), 'apiKey value leaked')
  assert.ok(!text.includes('nested-token-value'), 'nested token leaked')
  assert.ok(!text.includes('dXNlcjpwYXNz'), 'basic auth leaked')
  assert.ok(!text.includes('eyJhbGciOiJIUzI1NiJ9'), 'jwt leaked')
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwx'), 'api key leaked')
  assert.ok(!text.includes('supersecretvalue'), 'key=value secret leaked')
  assert.ok(!text.includes('x-api-key-value-5678'), 'x-api-key header leaked')
  assert.match(text, /\[REDACTED\]/)
})

test('bounds each entry to maxEntryBytes while keeping JSON valid', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { maxEntryBytes: 512 })

  sink.capture({ level: 'error', name: 'big', args: ['x'.repeat(100_000), { pad: 'y'.repeat(100_000) }] })
  await sink.flush()

  const lines = await readLines(path.join(dir, 'runtime.log'))
  assert.equal(lines.length, 1)
  assert.ok(Buffer.byteLength(lines[0]) <= 512, 'entry exceeded maxEntryBytes')
  const record = JSON.parse(lines[0])
  assert.equal(record.truncated, true)
  assert.ok(record.message.length > 0)
})

test('drops oldest records when the queue count bound is exceeded', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { maxQueueRecords: 3 })

  for (let i = 0; i < 5; i++) {
    sink.capture({ level: 'warn', name: 'q', args: ['seq-' + i] })
  }

  const before = sink.stats()
  assert.equal(before.queued.records, 3)
  assert.equal(before.dropped, 2)

  await sink.flush()

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(records.map((r) => r.message), ['seq-2', 'seq-3', 'seq-4'])
  assert.equal(sink.stats().written, 3)
})

test('drops oldest records when the queue byte bound is exceeded', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { maxQueueBytes: 400 })

  for (let i = 0; i < 20; i++) {
    sink.capture({ level: 'warn', name: 'q', args: ['payload-' + i + '-' + 'z'.repeat(40)] })
  }

  const before = sink.stats()
  assert.ok(before.queued.bytes <= 400, 'queue bytes exceeded bound: ' + before.queued.bytes)
  assert.ok(before.dropped > 0)

  await sink.flush()

  const lines = await readLines(path.join(dir, 'runtime.log'))
  assert.ok(lines.length > 0)
  for (const line of lines) JSON.parse(line)
  assert.equal(sink.stats().written, lines.length)
})

test('serializes concurrent flushes without duplicating records', async (t) => {
  const dir = await tempDir(t)
  let active = 0
  let maxActive = 0

  const slowFs = Object.create(fs)
  slowFs.appendFile = async (file, data, encoding) => {
    active++
    maxActive = Math.max(maxActive, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await fs.appendFile(file, data, encoding)
    } finally {
      active--
    }
  }

  const sink = sinkAt(t, dir, { fs: slowFs })

  sink.capture({ level: 'warn', name: 'c', args: ['one'] })
  sink.capture({ level: 'warn', name: 'c', args: ['two'] })

  await Promise.all([sink.flush(), sink.flush(), sink.flush()])

  assert.equal(maxActive, 1, 'writes were not serialized')
  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(records.map((r) => r.message), ['one', 'two'])
})

test('capture during an in-flight flush is not lost', async (t) => {
  const dir = await tempDir(t)
  const gate = deferred()

  const gatedFs = Object.create(fs)
  let calls = 0
  gatedFs.appendFile = async (file, data, encoding) => {
    calls++
    if (calls === 1) await gate.promise
    await fs.appendFile(file, data, encoding)
  }

  const sink = sinkAt(t, dir, { fs: gatedFs })

  sink.capture({ level: 'warn', name: 'c', args: ['first'] })
  const flushing = sink.flush()
  sink.capture({ level: 'warn', name: 'c', args: ['second'] })
  gate.resolve()
  await flushing
  await sink.flush()

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(records.map((r) => r.message), ['first', 'second'])
})

test('rotates by removing destinations before rename (Windows semantics)', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'runtime.log')

  const strictFs = Object.create(fs)
  strictFs.rename = async (src, dst) => {
    try {
      await fs.access(dst)
      const err = new Error('destination exists: ' + dst)
      err.code = 'EEXIST'
      throw err
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    await fs.rename(src, dst)
  }


  const sink = sinkAt(t, dir, {
    fs: strictFs,
    maxFileBytes: 300,
    maxRotations: 3,
  })

  for (let i = 0; i < 30; i++) {
    sink.capture({ level: 'warn', name: 'r', args: ['rotate-' + i + '-' + 'p'.repeat(60)] })
  }

  await sink.flush()

  const stats = sink.stats()
  assert.equal(stats.errors, 0)
  assert.ok(stats.rotations > 0)

  const rotated = await parseFile(file + '.1')
  assert.ok(rotated.length > 0)
  assert.ok(!rotated.some((r) => r.message.includes('stale segment')))
})

test('keeps only the current file plus configured rotations and orders segments', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'runtime.log')
  const sink = sinkAt(t, dir, { maxFileBytes: 400, maxRotations: 3 })

  const total = 40
  for (let i = 0; i < total; i++) {
    sink.capture({ level: 'warn', name: 'r', args: ['seq-' + i + '-' + 'p'.repeat(40)] })
  }

  await sink.flush()

  assert.ok(await exists(file))
  assert.ok(await exists(file + '.1'))
  assert.ok(await exists(file + '.2'))
  assert.ok(await exists(file + '.3'))
  assert.equal(await exists(file + '.4'), false)

  const segments = [file, file + '.1', file + '.2', file + '.3']
  const seen = []
  for (let index = 0; index < segments.length; index++) {
    const lines = await readLines(segments[index])
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line) <= 400, 'record does not fit segment')
      const record = JSON.parse(line)
      seen.push({ fileIndex: index, seq: Number(record.message.match(/^seq-(\d+)/)[1]) })
    }
  }

  assert.ok(seen.length > 0, 'no records survived rotation')
  assert.equal(new Set(seen.map((s) => s.seq)).size, seen.length, 'duplicate records')

  // Retention may prune the oldest records, but what survives must be a
  // contiguous, newest-ending suffix of the arrival order.
  const maxSeq = Math.max(...seen.map((s) => s.seq))
  assert.equal(maxSeq, total - 1)
  assert.equal(seen.length, maxSeq - Math.min(...seen.map((s) => s.seq)) + 1)
  assert.deepEqual(
    [...seen].sort((a, b) => a.seq - b.seq).map((s) => s.seq),
    seen
      .map((s) => s.seq)
      .sort((a, b) => a - b),
  )

  for (const a of seen) {
    for (const b of seen) {
      if (a.seq > b.seq) {
        assert.ok(
          a.fileIndex <= b.fileIndex,
          'record ' + a.seq + ' must not be older than ' + b.seq,
        )
      }
    }
  }
})

test('reports filesystem failures through onError without throwing', async (t) => {
  const dir = await tempDir(t)
  const failures = []

  const brokenFs = Object.create(fs)
  brokenFs.appendFile = async () => {
    const err = new Error('permission denied')
    err.code = 'EACCES'
    throw err
  }

  const sink = sinkAt(t, dir, {
    fs: brokenFs,
    onError: (err) => failures.push(err),
  })

  assert.doesNotThrow(() => sink.capture({ level: 'error', name: 'e', args: ['lost'] }))
  await assert.doesNotReject(() => sink.flush())

  const stats = sink.stats()
  assert.ok(stats.errors >= 1)
  assert.equal(failures.length, stats.errors)
  assert.equal(failures[0].message, 'Runtime log I/O failed; sink disabled.')
  assert.ok(stats.lastError !== null)
  assert.equal(stats.lost, 1, 'a failed batch must be counted as lost')
})

test('swallows errors thrown by the onError callback', async (t) => {
  const dir = await tempDir(t)

  const brokenFs = Object.create(fs)
  brokenFs.appendFile = async () => {
    throw Object.assign(new Error('broken'), { code: 'EIO' })
  }

  const sink = sinkAt(t, dir, {
    fs: brokenFs,
    onError: () => {
      throw new Error('onError exploded')
    },
  })

  sink.capture({ level: 'warn', name: 'e', args: ['x'] })
  await assert.doesNotReject(() => sink.flush())
  assert.ok(sink.stats().errors >= 1)
})

test('close drains the queue, is idempotent and stops intake', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  sink.capture({ level: 'warn', name: 'c', args: ['one'] })
  sink.capture({ level: 'error', name: 'c', args: ['two'] })

  const first = sink.close()
  const second = sink.close()
  assert.equal(first, second, 'close must return the same promise')
  await first

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(records.map((r) => r.message), ['one', 'two'])
  assert.equal(sink.stats().closed, true)
  assert.equal(sink.stats().accepting, false)

  assert.equal(sink.capture({ level: 'warn', name: 'c', args: ['after close'] }), false)
  await sink.close()
  await sink.flush()

  const after = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(after.map((r) => r.message), ['one', 'two'])
})

test('close stops the flush timer', async (t) => {
  const dir = await tempDir(t)
  const intervals = []
  const cleared = []

  const timers = {
    setInterval(fn, ms) {
      const handle = { fn, ms, unref() {} }
      intervals.push(handle)
      return handle
    },
    clearInterval(handle) {
      cleared.push(handle)
    },
    setTimeout,
    clearTimeout,
  }

  const sink = createLogSink({ dir, fileName: 'runtime.log', timers })
  t.after(async () => {
    await sink.close()
  })

  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 200)

  sink.capture({ level: 'warn', name: 'c', args: ['one'] })
  await sink.close()

  assert.deepEqual(cleared, [intervals[0]])

  intervals[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.equal(records.length, 1)
})

test('close resolves within the finite drain timeout when writes hang', async (t) => {
  const dir = await tempDir(t)

  const hangingFs = Object.create(fs)
  hangingFs.appendFile = () => new Promise(() => {})

  const sink = sinkAt(t, dir, {
    fs: hangingFs,
    closeTimeoutMs: 50,
  })

  sink.capture({ level: 'error', name: 'h', args: ['stuck'] })

  const started = Date.now()
  await sink.close()
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2000, 'close did not honour the drain timeout: ' + elapsed + 'ms')
  assert.equal(sink.stats().closed, true)
})

test('exposes documented default limits in stats', async (t) => {
  const dir = await tempDir(t)
  const sink = createLogSink({ dir, fileName: 'runtime.log' })
  t.after(async () => {
    await sink.close()
  })

  const { limits } = sink.stats()
  assert.deepEqual(limits, {
    maxFileBytes: 5 * MiB,
    maxRotations: 3,
    maxQueueRecords: 2000,
    maxQueueBytes: MiB,
    flushIntervalMs: 200,
    maxEntryBytes: 16 * 1024,
    closeTimeoutMs: 2000,
  })
})

test('writes to an explicit filePath when configured', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'custom-name.log')
  const sink = createLogSink({ filePath: file, flushIntervalMs: 0 })
  t.after(async () => {
    await sink.close()
  })

  sink.capture({ level: 'warn', name: 'p', args: ['path'] })
  await sink.flush()

  const records = await parseFile(file)
  assert.equal(records.length, 1)
  assert.equal(records[0].message, 'path')
})

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
test('refuses an existing run path without changing its bytes or rotations', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'runtime.log')
  await fs.writeFile(file, 'existing partial line')
  await fs.writeFile(file + '.1', 'existing rotation')
  const sink = sinkAt(t, dir, { maxFileBytes: 100 })
  sink.capture({ level: 'warn', args: ['new'] })
  await sink.flush()
  assert.equal(await fs.readFile(file, 'utf8'), 'existing partial line')
  assert.equal(await fs.readFile(file + '.1', 'utf8'), 'existing rotation')
  assert.equal(sink.stats().disabled, true)
})

test('truncates instead of rotating when maxRotations is zero', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'runtime.log')
  const sink = sinkAt(t, dir, { maxFileBytes: 200, maxRotations: 0 })

  for (let i = 0; i < 10; i++) {
    sink.capture({ level: 'warn', name: 'r', args: ['r-' + i + '-' + 'p'.repeat(60)] })
  }
  await sink.flush()

  assert.equal(await exists(file + '.1'), false)
  const lines = await readLines(file)
  assert.ok(lines.length >= 1)
  for (const line of lines) JSON.parse(line)
  const size = (await fs.stat(file)).size
  assert.ok(size <= 200, 'truncated file exceeded maxFileBytes: ' + size)
})

test('uses the injected clock for record timestamps', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { now: () => 1_700_000_000_000 })

  sink.capture({ level: 'warn', name: 'clock', args: ['tick'] })
  await sink.flush()

  const [record] = await parseFile(path.join(dir, 'runtime.log'))
  assert.equal(record.time, '2023-11-14T22:13:20.000Z')
})
test('bounds escape-heavy entries and stacks to maxEntryBytes', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { maxEntryBytes: 512 })

  const noisy = '\u0000\u0001\u0002"\\'.repeat(2000)
  sink.capture({ level: 'error', name: 'esc', args: [noisy] })

  const stacked = new Error('big stack')
  stacked.stack = '\u0000'.repeat(50_000)
  sink.capture({ level: 'error', name: 'stack', args: [stacked] })

  await sink.flush()

  const lines = await readLines(path.join(dir, 'runtime.log'))
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 512, 'entry exceeded maxEntryBytes: ' + Buffer.byteLength(line))
    JSON.parse(line)
  }
})
test('accepts the Cordis-style type field for severity', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  sink.capture({ type: 'warn', name: 'cordis', args: ['warned'] })
  sink.capture({ type: 'error', name: 'cordis', args: ['failed'] })
  sink.capture({ type: 'info', name: 'cordis', args: ['ignored'] })

  await sink.flush()

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.deepEqual(records.map((r) => r.level), ['warn', 'error'])
  assert.equal(sink.stats().ignored, 1)
})

test('maps maxFiles and drainTimeoutMs integration aliases', async (t) => {
  const dir = await tempDir(t)
  const aliased = createLogSink({ dir, fileName: 'alias.log', maxFiles: 6, drainTimeoutMs: 40 })
  t.after(async () => {
    await aliased.close()
  })

  assert.equal(aliased.stats().limits.maxRotations, 5)
  assert.equal(aliased.stats().limits.closeTimeoutMs, 40)

  const explicit = createLogSink({
    dir,
    fileName: 'alias-explicit.log',
    maxFiles: 6,
    maxRotations: 1,
    drainTimeoutMs: 40,
    closeTimeoutMs: 500,
  })
  t.after(async () => {
    await explicit.close()
  })

  assert.equal(explicit.stats().limits.maxRotations, 1)
  assert.equal(explicit.stats().limits.closeTimeoutMs, 500)
})
test('renders printf-style Cordis args through the safe formatter', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)

  const circular = { a: 1 }
  circular.self = circular

  sink.capture({ type: 'warn', name: 'fmt', args: ['warning %s for %d', 'plugin', 42] })
  sink.capture({ type: 'error', name: 'fmt', args: ['payload %o', circular] })
  sink.capture({ type: 'warn', name: 'fmt', args: ['literal 100% sure'] })
  sink.capture({ type: 'warn', name: 'fmt', args: ['api_key=%s', 'secret-value-9999'] })

  await sink.flush()

  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.equal(records[0].message, 'warning plugin for 42')
  assert.equal(records[1].message, 'payload [Object]')
  assert.equal(records[2].message, 'literal 100% sure')
  assert.ok(!JSON.stringify(records[3]).includes('secret-value-9999'))
  assert.match(records[3].message, /api_key=\[REDACTED\]/)
})

test('does not execute object, proxy, iterator, record or argument hooks', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)
  let hooks = 0
  const hook = () => { hooks++; throw new Error('must not run') }
  const object = { get name() { return hook() }, get message() { return hook() }, toJSON: hook, toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook }
  const map = new Map(); map[Symbol.iterator] = hook
  const set = new Set(); set[Symbol.iterator] = hook
  const proxy = new Proxy({}, { get: hook, getOwnPropertyDescriptor: hook, ownKeys: hook, getPrototypeOf: hook })
  const revoked = Proxy.revocable([], {}); revoked.revoke()
  const args = ['values %s %d %j', object, object, object, map, set, proxy, revoked.proxy]
  Object.defineProperty(args, '8', { get: hook }); args.length = 10
  Object.setPrototypeOf(args, { 9: object, [Symbol.iterator]: hook })
  assert.equal(sink.capture({ level: 'warn', args }), true)
  sink.capture(new Proxy({}, { get: hook, getOwnPropertyDescriptor: hook }))
  sink.capture({ get level() { return hook() } })
  sink.capture({ level: 'warn', get name() { return hook() }, get args() { return hook() }, message: 'safe' })
  assert.equal(hooks, 0)
  await sink.flush()
  assert.equal(hooks, 0)
  const records = await parseFile(path.join(dir, 'runtime.log'))
  assert.match(records[0].message, /\[Object\]/)
  assert.equal(records.at(-1).message, 'safe')
})

test('native Error fields and lazy stack never invoke user hooks', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir)
  let hooks = 0
  const err = new Error('safe message')
  Object.defineProperty(err, 'name', { get() { hooks++; return 'unsafe' } })
  sink.capture({ level: 'error', args: [err] })
  const stackError = new Error('another')
  Object.defineProperty(stackError, 'stack', { get() { hooks++; return 'unsafe' } })
  sink.capture({ level: 'error', args: [stackError] })
  const before = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, get() { hooks++; return () => 'unsafe' } })
  try { sink.capture({ level: 'error', args: [new Error('custom formatter')] }) }
  finally { if (before) Object.defineProperty(Error, 'prepareStackTrace', before); else delete Error.prepareStackTrace }
  assert.equal(hooks, 0)
  await sink.flush()
  const records = await parseFile(path.join(dir, 'runtime.log'))
  for (const record of records) assert.match(record.stack, /Stack unavailable/)
})

test('redacts every field before clipping and conservatively drops scan-boundary tokens', async (t) => {
  const dir = await tempDir(t)
  const sink = sinkAt(t, dir, { maxEntryBytes: 256 })
  sink.capture({ level: 'warn', name: 'x'.repeat(114) + ' sk-abcdefghijklmnopqrstuvwx', args: ['ok'], stack: 'token=secret-stack-value' })
  sink.capture({ level: 'warn', args: ['safe ' + 'z'.repeat(100000) + ' token=never-visible'] })
  await sink.flush()
  const text = await fs.readFile(path.join(dir, 'runtime.log'), 'utf8')
  assert.ok(!text.includes('sk-'))
  assert.ok(!text.includes('secret-stack-value'))
  assert.ok(!text.includes('never-visible'))
})

test('stalled writer pins total count and bytes and shares one flush promise', async (t) => {
  const dir = await tempDir(t)
  const gate = deferred(); const started = deferred()
  const gatedFs = Object.create(fs)
  gatedFs.appendFile = async (...args) => { started.resolve(); await gate.promise; await fs.appendFile(...args) }
  const sink = sinkAt(t, dir, { fs: gatedFs, maxQueueRecords: 1, maxQueueBytes: 256 })
  sink.capture({ level: 'warn', args: ['pinned'] })
  const pending = sink.flush()
  await started.promise
  try {
    for (let i = 0; i < 2000; i++) {
      assert.equal(sink.flush(), pending)
      assert.equal(sink.capture({ level: 'warn', args: ['incoming'] }), false)
    }
    const stats = sink.stats()
    assert.equal(stats.buffered.records, 1)
    assert.ok(stats.buffered.bytes <= 256)
    assert.equal(stats.queued.records, 0)
    assert.equal(stats.dropped, 2000)
  } finally { gate.resolve(); await pending }
  assert.deepEqual((await parseFile(path.join(dir, 'runtime.log'))).map(r => r.message), ['pinned'])
})

test('in-flight bytes force eviction of pending records without dropping the issued write', async (t) => {
  const dir = await tempDir(t)
  const gate = deferred(); const started = deferred()
  const gatedFs = Object.create(fs)
  let calls = 0
  gatedFs.appendFile = async (...args) => { if (++calls === 1) { started.resolve(); await gate.promise }; await fs.appendFile(...args) }
  const sink = sinkAt(t, dir, { fs: gatedFs, maxQueueRecords: 100, maxQueueBytes: 240 })
  sink.capture({ level: 'warn', args: ['pinned-' + 'x'.repeat(40)] })
  const pending = sink.flush(); await started.promise
  for (let i = 0; i < 20; i++) sink.capture({ level: 'warn', args: ['pending-' + i] })
  const stats = sink.stats()
  gate.resolve(); await pending
  assert.ok(stats.buffered.bytes <= 240)
  assert.ok(stats.dropped > 0)
  assert.equal((await parseFile(path.join(dir, 'runtime.log')))[0].message, 'pinned-' + 'x'.repeat(40))
})

for (const lateReject of [false, true]) test('timeout stops further append and rotation after late ' + (lateReject ? 'rejection' : 'completion'), async (t) => {
  const dir = await tempDir(t)
  const gate = deferred(); const started = deferred()
  const gatedFs = Object.create(fs)
  let appends = 0; let rotations = 0
  gatedFs.appendFile = async (...args) => { appends++; started.resolve(); await gate.promise; if (lateReject) throw new Error('late failure'); await fs.appendFile(...args) }
  gatedFs.rename = async (...args) => { rotations++; return fs.rename(...args) }
  const sink = sinkAt(t, dir, { fs: gatedFs, maxFileBytes: 180, drainTimeoutMs: 20 })
  sink.capture({ level: 'warn', args: ['first-' + 'x'.repeat(50)] })
  const flushing = sink.flush(); await started.promise
  sink.capture({ level: 'warn', args: ['second-' + 'y'.repeat(50)] })
  await sink.close()
  assert.equal(sink.stats().timedOut, true)
  assert.equal(sink.stats().queued.records, 0)
  gate.resolve(); await flushing
  await sink.flush()
  assert.equal(appends, 1)
  assert.equal(rotations, 0)
  assert.equal(sink.capture({ level: 'error', args: ['after'] }), false)
})

test('strict UTF8 segment cap includes newline even for oversized and tiny-limit entries', async (t) => {
  for (const cap of [1, 80, 128, 180]) {
    const dir = await tempDir(t)
    const sink = sinkAt(t, dir, { maxFileBytes: cap, maxEntryBytes: 1024 })
    for (let i = 0; i < 5; i++) sink.capture({ level: 'warn', name: '界'.repeat(100), args: ['😀'.repeat(1000)] })
    await sink.flush()
    for (const file of await fs.readdir(dir)) {
      const data = await fs.readFile(path.join(dir, file), 'utf8')
      assert.ok(Buffer.byteLength(data) <= cap, file + ' exceeds ' + cap)
      if (data) { assert.ok(data.endsWith('\n')); for (const line of data.trimEnd().split('\n')) JSON.parse(line) }
    }
  }
})

test('rotation failure disables the sink instead of appending or retrying', async (t) => {
  const dir = await tempDir(t)
  const brokenFs = Object.create(fs)
  let renames = 0
  brokenFs.rename = async () => { renames++; throw Object.assign(new Error('sensitive failure'), { code: 'EACCES' }) }
  const sink = sinkAt(t, dir, { fs: brokenFs, maxFileBytes: 180 })
  for (let i = 0; i < 6; i++) sink.capture({ level: 'warn', args: ['record-' + i + '-' + 'x'.repeat(50)] })
  await sink.flush()
  assert.equal(sink.stats().disabled, true)
  assert.equal(sink.capture({ level: 'warn', args: ['retry'] }), false)
  await sink.flush()
  assert.equal(renames, 1)
  assert.ok((await fs.stat(path.join(dir, 'runtime.log'))).size <= 180)
  assert.ok(!JSON.stringify(sink.stats()).includes('sensitive failure'))
})

test('a failed partial append is never followed by another JSONL append', async (t) => {
  const dir = await tempDir(t)
  const brokenFs = Object.create(fs)
  let appends = 0; const errors = []
  brokenFs.appendFile = async (file, data) => { appends++; await fs.appendFile(file, data.slice(0, 17)); throw new Error('token=private-diagnostic') }
  const sink = sinkAt(t, dir, { fs: brokenFs, onError: error => errors.push(error) })
  sink.capture({ level: 'warn', args: ['first'] })
  await sink.flush()
  sink.capture({ level: 'error', args: ['second'] })
  await sink.flush()
  assert.equal(appends, 1)
  assert.equal(sink.stats().disabled, true)
  assert.equal(sink.stats().lost, 1)
  assert.ok(!JSON.stringify(sink.stats()).includes('private-diagnostic'))
  assert.ok(!String(errors[0]).includes('private-diagnostic'))
})

test('refuses a symlink at the run path without touching its target', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'target.log')
  await fs.writeFile(target, 'target must survive')
  try { await fs.symlink(target, path.join(dir, 'runtime.log'), 'file') }
  catch (error) {
    if (error.code !== 'EPERM' || process.platform !== 'win32') throw error
    const targetDir = path.join(dir, 'target-directory')
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, 'marker'), 'directory must survive')
    await fs.symlink(targetDir, path.join(dir, 'runtime.log'), 'junction')
    t.diagnostic('run path refusal exercised with a Windows directory junction')
  }
  const sink = sinkAt(t, dir)
  sink.capture({ level: 'error', args: ['must refuse'] })
  await sink.flush()
  assert.equal(await fs.readFile(target, 'utf8'), 'target must survive')
  assert.equal(sink.stats().disabled, true)
})

for (const phase of ['mkdir', 'open', 'rename']) test('deadline blocks all new I/O after late ' + phase, async (t) => {
  const dir = await tempDir(t)
  const gate = deferred(); const started = deferred()
  const delayedFs = Object.create(fs)
  let afterDeadline = false
  const issuedAfterDeadline = []
  let held = false
  for (const method of ['mkdir', 'open', 'unlink', 'rename', 'appendFile']) {
    delayedFs[method] = async (...args) => {
      if (afterDeadline) issuedAfterDeadline.push(method)
      if (method === phase && !held) { held = true; started.resolve(); await gate.promise }
      return fs[method](...args)
    }
  }
  const sink = sinkAt(t, dir, { fs: delayedFs, maxFileBytes: 180, drainTimeoutMs: 20 })
  sink.capture({ level: 'warn', args: ['one-' + 'x'.repeat(50)] })
  sink.capture({ level: 'warn', args: ['two-' + 'y'.repeat(50)] })
  const flushing = sink.flush(); await started.promise
  await sink.close(); afterDeadline = true
  gate.resolve(); await flushing
  assert.equal(sink.stats().timedOut, true)
  assert.deepEqual(issuedAfterDeadline, [])
})

test('two sinks cannot own or resume the same run path', async (t) => {
  const dir = await tempDir(t)
  const first = sinkAt(t, dir)
  first.capture({ level: 'warn', args: ['owner'] })
  await first.flush()
  const second = sinkAt(t, dir)
  second.capture({ level: 'warn', args: ['intruder'] })
  await second.flush()
  assert.equal(second.stats().disabled, true)
  first.capture({ level: 'warn', args: ['owner again'] })
  await first.flush()
  assert.deepEqual((await parseFile(path.join(dir, 'runtime.log'))).map(r => r.message), ['owner', 'owner again'])
})

test('close waits for idle owned handle cleanup within its single deadline', async (t) => {
  const dir = await tempDir(t)
  const gate = deferred(); const started = deferred()
  const delayedFs = Object.create(fs)
  delayedFs.open = async (...args) => {
    const handle = await fs.open(...args)
    const close = handle.close.bind(handle)
    handle.close = async () => { started.resolve(); await gate.promise; await close() }
    return handle
  }
  const sink = sinkAt(t, dir, { fs: delayedFs })
  sink.capture({ level: 'warn', args: ['one'] })
  await sink.flush()
  let resolved = false
  const closing = sink.close().then(() => { resolved = true })
  await started.promise
  await Promise.resolve()
  assert.equal(resolved, false)
  gate.resolve(); await closing
  assert.equal(sink.stats().closed, true)
})

test('close at writer settlement never strands its owned handle', async (t) => {
  for (let depth = 1; depth <= 8; depth++) {
    const dir = await tempDir(t)
    const delayedFs = Object.create(fs)
    let closes = 0
    let closing
    const requested = deferred()
    delayedFs.open = async (...args) => {
      const handle = await fs.open(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => { closes++; await close() }
      return handle
    }
    delayedFs.appendFile = async (...args) => {
      await fs.appendFile(...args)
      const later = left => queueMicrotask(() => {
        if (left) later(left - 1)
        else { sink.capture({ level: 'warn', args: ['last'] }); closing = sink.close(); requested.resolve() }
      })
      later(depth)
    }
    const sink = sinkAt(t, dir, { fs: delayedFs })
    sink.capture({ level: 'warn', args: ['one'] })
    await sink.flush(); await requested.promise; await closing
    assert.equal(closes, 1, 'stranded owned handle at microtask depth ' + depth)
    assert.deepEqual((await parseFile(path.join(dir, 'runtime.log'))).map(r => r.message), ['one', 'last'])
  }
})
