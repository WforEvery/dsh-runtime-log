/**
 * Bounded, best-effort JSONL sink; not crash-safe storage.
 * capture is synchronous; flush shares one never-rejecting writer promise;
 * close stops intake and drains to one deadline. An issued OS call cannot be
 * cancelled. After timeout only late settlement and handle cleanup are allowed.
 *
 * Only primitive arguments and native Error own string data fields are logged.
 * Unsupported objects are [Object]; no object traversal, coercion or getters.
 * Lazy/accessor or unsafe Error stacks become [Stack unavailable]. In V8 older
 * than Node 24 even inspecting a lazy stack descriptor may execute code;
 * native Error stacks on those versions conservatively use the marker.
 * Recognized secrets are redacted before clipping, with bounded text scanning.
 * This is best-effort filtering, not complete scrubbing of arbitrary secrets.
 *
 * filePath is a unique run namespace, exclusively created and never resumed.
 * A write/rotation failure disables this sink: a partial append may leave a
 * torn final line, but no later JSONL will be appended to it. Retention of other
 * runs belongs to the caller. fs/timers/now remain injectable for fault tests.
 */
import defaultFs from 'node:fs/promises'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'

const DEFAULTS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxRotations: 3,
  maxQueueRecords: 2000,
  maxQueueBytes: 1024 * 1024,
  flushIntervalMs: 200,
  maxEntryBytes: 16 * 1024,
  closeTimeoutMs: 2000,
})
const DEFAULT_LEVELS = ['error', 'warn', 'info', 'debug']
const MAX_ARGS = 20
const MAX_SCAN = 64 * 1024
const STACK_UNAVAILABLE = '[Stack unavailable]'
const NativeError = Error
// V8 switched lazy stack storage to ordinary accessors in Node 24. Earlier
// versions can run the formatter merely by requesting its descriptor.
const stackDescriptorIsInert = Number(process.versions.node.split('.')[0]) >= 24
const TEXT_RULES = [
  [/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[REDACTED]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]+/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]+/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]+/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]+/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_.-]+/g, '[REDACTED]'],
  [/(\b(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token|authorization|auth|cookie|credentials?)\b["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]'],
]

function positiveInt(value, fallback, minimum) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : fallback
}
function createLimits(opts) {
  const rotations = positiveInt(opts.maxFiles, 4, 1) - 1
  return {
    maxFileBytes: positiveInt(opts.maxFileBytes, DEFAULTS.maxFileBytes, 1),
    maxRotations: positiveInt(opts.maxRotations, rotations, 0),
    maxQueueRecords: positiveInt(opts.maxQueueRecords, DEFAULTS.maxQueueRecords, 1),
    maxQueueBytes: positiveInt(opts.maxQueueBytes, DEFAULTS.maxQueueBytes, 1),
    flushIntervalMs: positiveInt(opts.flushIntervalMs, DEFAULTS.flushIntervalMs, 0),
    maxEntryBytes: positiveInt(opts.maxEntryBytes, DEFAULTS.maxEntryBytes, 128),
    closeTimeoutMs: positiveInt(opts.closeTimeoutMs, positiveInt(opts.drainTimeoutMs, DEFAULTS.closeTimeoutMs, 1), 1),
  }
}
function ownData(value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || types.isProxy(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function clip(text, count) {
  if (text.length <= count) return text
  let end = Math.max(0, count - 1)
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return text.slice(0, end) + '…'
}
function scan(input, ctx) {
  if (typeof input !== 'string') return ''
  const size = Math.min(input.length, ctx.remaining)
  ctx.remaining -= size
  let text = input.slice(0, size)
  if (size < input.length) {
    ctx.truncated = true
    // Discard the entire unfinished token, not a possibly sensitive prefix.
    text = text.replace(/\S*$/, '') + '…'
  }
  return text
}
function redact(input, ctx) {
  let text = scan(input, ctx)
  for (const [pattern, replacement] of TEXT_RULES) text = text.replace(pattern, replacement)
  return text
}
function safeErrorStack(error) {
  // On older V8 there is no inert way to tell a materialized data property
  // from a lazy one: descriptor lookup itself may invoke arbitrary hooks or
  // allocate an unbounded stack. Fail closed rather than materializing it.
  if (!stackDescriptorIsInert) return STACK_UNAVAILABLE
  const value = ownData(error, 'stack')
  return typeof value === 'string' ? value : STACK_UNAVAILABLE
}
function primitive(value, ctx) {
  switch (typeof value) {
    case 'string': return redact(value, ctx)
    case 'number': return Object.is(value, -0) ? '-0' : String(value)
    case 'boolean': return value ? 'true' : 'false'
    // Huge bigint conversion is unbounded; keep it inert too.
    case 'bigint': return '[BigInt]'
    case 'undefined': return 'undefined'
    case 'symbol': return '[Symbol]'
    case 'function': return '[Function]'
    default: break
  }
  if (value === null) return 'null'
  if (types.isProxy(value) || !types.isNativeError(value)) return '[Object]'
  const name = ownData(value, 'name')
  const message = ownData(value, 'message')
  if (ctx.stack === null) ctx.stack = redact(safeErrorStack(value), ctx)
  return redact(typeof name === 'string' ? name : 'Error', ctx)
    + (typeof message === 'string' && message ? ': ' + redact(message, ctx) : '')
}
function extractArgs(record) {
  const args = ownData(record, 'args')
  if (types.isProxy(args)) return ['[Object]']
  if (!Array.isArray(args)) {
    const value = args === undefined ? ownData(record, 'message') : args
    return value === undefined || value === null ? [] : [value]
  }
  const length = ownData(args, 'length')
  const count = Math.min(typeof length === 'number' ? length : 0, MAX_ARGS)
  const result = []
  for (let i = 0; i < count; i++) {
    const d = Object.getOwnPropertyDescriptor(args, String(i))
    result.push(d && Object.hasOwn(d, 'value') ? d.value : '[Unavailable]')
  }
  if (length > MAX_ARGS) result.push('…')
  return result
}
function formatArgs(args, ctx) {
  if (args.length === 0) return ''
  // Interpolate the bounded raw template before redacting its assembled text;
  // otherwise api_key=%s could consume the directive and expose a spare arg.
  const rendered = args.map((value, index) => index === 0 && typeof value === 'string' ? scan(value, ctx) : primitive(value, ctx))
  if (typeof args[0] !== 'string') return rendered.join(' ')
  let used = 1
  const text = rendered[0].replace(/%([sdifjoOc%])/g, (match, code) => {
    if (code === '%') return '%'
    if (used >= rendered.length) return match
    const raw = args[used]
    const safe = rendered[used++]
    if (code === 'c') return ''
    if (code === 'd' || code === 'i' || code === 'f') {
      if (raw !== null && !['number', 'boolean', 'string', 'undefined'].includes(typeof raw)) return safe
      // Coercion is allowed only on already bounded, redacted primitive text.
      const number = Number(typeof raw === 'string' ? safe : raw)
      return String(code === 'i' && Number.isFinite(number) ? Math.trunc(number) : number)
    }
    return safe
  })
  return [text, ...rendered.slice(used)].join(' ').trim()
}
function normalizeLevel(record, levels) {
  let raw
  for (const key of ['level', 'levelName', 'severity', 'type']) {
    raw = ownData(record, key)
    if (raw !== null && raw !== undefined) break
  }
  let level = typeof raw === 'string' && raw.length <= 16 ? raw.toLowerCase()
    : typeof raw === 'number' && Number.isInteger(raw) ? levels[raw] : null
  if (level === 'warning') level = 'warn'
  return level === 'warn' || level === 'error' ? level : null
}
function isoNow(now) {
  try {
    const value = now()
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  } catch { /* trusted injected clock may fail */ }
  return new Date().toISOString()
}
function buildEntry(record, level, limits, now) {
  const ctx = { remaining: Math.min(MAX_SCAN, limits.maxEntryBytes * 4), truncated: false, stack: null }
  // All fields are redacted before any final field/encoded byte clipping.
  const name = redact(ownData(record, 'name'), ctx)
  const message = formatArgs(extractArgs(record), ctx)
  const stack = ctx.stack ?? (types.isNativeError(record) ? STACK_UNAVAILABLE : redact(ownData(record, 'stack'), ctx))
  const finalCtx = { remaining: MAX_SCAN, truncated: false }
  const entry = { time: isoNow(now), level, name: clip(redact(name, finalCtx), 120), message: redact(message, finalCtx) }
  if (stack) entry.stack = redact(stack, finalCtx)
  if (ctx.truncated || finalCtx.truncated) entry.truncated = true
  const cap = Math.min(limits.maxEntryBytes, limits.maxFileBytes, limits.maxQueueBytes)
  for (;;) {
    const data = Buffer.from(JSON.stringify(entry) + '\n', 'utf8')
    if (data.length <= cap) return data
    entry.truncated = true
    // JSON escaping is included in each measurement; never split a JSON line.
    if (entry.stack && entry.stack.length > 1) entry.stack = clip(entry.stack, Math.floor(entry.stack.length / 2))
    else if (entry.stack) delete entry.stack
    else if (entry.message.length > 1) entry.message = clip(entry.message, Math.floor(entry.message.length / 2))
    else if (entry.message) entry.message = ''
    else if (entry.name.length > 1) entry.name = clip(entry.name, Math.floor(entry.name.length / 2))
    else if (entry.name) entry.name = ''
    else return null // fixed JSON envelope cannot fit this deliberately tiny cap
  }
}

export function createLogSink(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const limits = createLimits(opts)
  const fsp = opts.fs ?? defaultFs
  const timers = { setInterval, clearInterval, setTimeout, clearTimeout, ...opts.timers }
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const levels = Array.isArray(opts.levels) ? opts.levels : DEFAULT_LEVELS
  const onError = typeof opts.onError === 'function' ? opts.onError : null
  const filePath = typeof opts.filePath === 'string' ? nodePath.resolve(opts.filePath)
    : nodePath.join(typeof opts.dir === 'string' ? nodePath.resolve(opts.dir) : nodePath.join(nodeOs.tmpdir(), 'dsh-runtime-log'),
      typeof opts.fileName === 'string' ? nodePath.basename(opts.fileName) : 'runtime-' + process.pid + '-' + randomUUID() + '.jsonl')
  const state = { accepted: 0, ignored: 0, dropped: 0, written: 0, errors: 0, rotations: 0, bytesWritten: 0, lost: 0, lastError: null }
  let queue = []
  let queuedBytes = 0
  let inFlight = null
  let handle = null
  let initialized = false
  let currentSize = 0
  let accepting = true
  let closed = false
  let disabled = false
  let timedOut = false
  let writerPromise = null
  let closePromise = null
  let timer = null
  const done = Promise.resolve()
  const stopped = () => disabled || timedOut || closed

  function clearTimer() {
    if (timer !== null) {
      try { timers.clearInterval(timer) } catch { /* no logger recursion */ }
      timer = null
    }
  }
  function discardPending() {
    state.lost += queue.length
    queue = []
    queuedBytes = 0
  }
  function noteError() {
    state.errors++
    state.lastError = 'Runtime log I/O failed; sink disabled.'
    // No raw filesystem text, paths, credentials or arbitrary error hooks.
    if (onError && state.errors === 1) {
      try { onError(new NativeError(state.lastError)) } catch { /* callback containment */ }
    }
  }
  function disable() {
    disabled = true
    accepting = false
    clearTimer()
    discardPending()
    noteError()
  }
  async function releaseHandle() {
    const current = handle
    handle = null
    if (current) {
      try { await current.close() } catch { if (!disabled && !timedOut) disable() }
    }
  }
  async function initialize() {
    if (initialized || stopped()) return
    await fsp.mkdir(nodePath.dirname(filePath), { recursive: true })
    if (stopped()) return
    // O_EXCL refuses existing files, symlinks and concurrent owners atomically.
    handle = await fsp.open(filePath, 'wx', 0o600)
    initialized = true
  }
  async function remove(target) {
    if (stopped()) return
    try { await fsp.unlink(target) } catch (error) { if (ownData(error, 'code') !== 'ENOENT') throw error }
  }
  async function rotate() {
    await releaseHandle()
    if (stopped()) return
    if (limits.maxRotations === 0) {
      await remove(filePath)
    } else {
      await remove(filePath + '.' + limits.maxRotations)
      for (let i = limits.maxRotations - 1; i >= 1 && !stopped(); i--) {
        try {
          if (!stopped()) await fsp.rename(filePath + '.' + i, filePath + '.' + (i + 1))
        } catch (error) { if (ownData(error, 'code') !== 'ENOENT') throw error }
      }
      if (!stopped()) await fsp.rename(filePath, filePath + '.1')
    }
    if (stopped()) return
    handle = await fsp.open(filePath, 'wx', 0o600)
    currentSize = 0
    state.rotations++
  }
  async function drain() {
    try {
      if (stopped()) return
      if (!queue.length) return
      await initialize()
      while (queue.length && !stopped()) {
        // Keep the pending record evictable throughout initialization/rotation.
        if (currentSize + queue[0].length > limits.maxFileBytes) {
          await rotate()
          continue
        }
        inFlight = queue.shift()
        queuedBytes -= inFlight.length
        const bytes = inFlight.length
        try {
          await fsp.appendFile(handle, inFlight)
          currentSize += bytes
          state.written++
          state.bytesWritten += bytes
        } catch (error) {
          state.lost++
          throw error
        } finally { inFlight = null }
      }
    } catch { disable() }
    finally {
      if (stopped() || !accepting) await releaseHandle()
    }
  }
  function flush() {
    if (writerPromise) return writerPromise
    if (stopped() || (queue.length === 0 && (accepting || !handle))) return done
    // Schedule the work only after publishing the sole shared promise.
    writerPromise = Promise.resolve().then(async () => {
      try {
        // Include arrivals in the microtask window between drain settlement
        // and this shared promise's completion, without chaining flush calls.
        do { await drain() } while (queue.length && !stopped())
      } catch { disable() }
      finally { writerPromise = null }
    })
    return writerPromise
  }
  function capture(record) {
    try {
      if (!accepting || stopped() || !record || typeof record !== 'object' || types.isProxy(record)) {
        state.ignored++
        return false
      }
      const level = normalizeLevel(record, levels)
      if (level === null) { state.ignored++; return false }
      const data = buildEntry(record, level, limits, now)
      if (data === null) { state.dropped++; return false }
      const flightBytes = inFlight?.length ?? 0
      const flightCount = inFlight ? 1 : 0
      while (queue.length && (queue.length + flightCount + 1 > limits.maxQueueRecords || queuedBytes + flightBytes + data.length > limits.maxQueueBytes)) {
        queuedBytes -= queue.shift().length
        state.dropped++
      }
      if (queue.length + flightCount + 1 > limits.maxQueueRecords || queuedBytes + flightBytes + data.length > limits.maxQueueBytes) {
        state.dropped++
        return false
      }
      queue.push(data)
      queuedBytes += data.length
      state.accepted++
      return true
    } catch {
      // Ordinary formatting failures are contained without retaining raw args.
      state.dropped++
      return false
    }
  }
  function close() {
    if (closePromise) return closePromise
    accepting = false
    clearTimer()
    // close can begin after drain's finally ran but before its shared promise
    // settles; always perform one final owned-handle cleanup in that case.
    const draining = flush().then(releaseHandle)
    closePromise = new Promise(resolve => {
      let settled = false
      let deadline
      const finish = timeout => {
        if (settled) return
        settled = true
        if (timeout) {
          timedOut = true
          discardPending()
        }
        closed = true
        if (deadline !== undefined) {
          try { timers.clearTimeout(deadline) } catch { /* bounded close */ }
        }
        resolve()
      }
      // The explicit close deadline stays referenced: awaiting close must work
      // even when an injected write never settles and no other handles exist.
      try { deadline = timers.setTimeout(() => finish(true), limits.closeTimeoutMs) }
      catch { finish(true) }
      draining.then(() => finish(false), () => finish(false))
    })
    return closePromise
  }
  function stats() {
    const flight = { records: inFlight ? 1 : 0, bytes: inFlight?.length ?? 0 }
    return {
      ...state,
      queued: { records: queue.length, bytes: queuedBytes },
      inFlight: flight,
      buffered: { records: queue.length + flight.records, bytes: queuedBytes + flight.bytes },
      limits: { ...limits },
      accepting: accepting && !stopped(), closed, disabled, timedOut,
    }
  }
  if (limits.flushIntervalMs > 0) {
    try {
      timer = timers.setInterval(() => { void flush() }, limits.flushIntervalMs)
      timer?.unref?.()
    } catch { disable() }
  }
  return { capture, flush, close, stats }
}
