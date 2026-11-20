/**
 * Bounded, best-effort JSONL sink; not crash-safe storage.
 * capture is synchronous; flush shares one never-rejecting writer promise and
 * appends each batch with one fsp.appendFile call (rotation or pinning can
 * split the queue into several batches per drain); close stops intake and
 * drains to one deadline. An issued OS call cannot be cancelled. After timeout
 * only late settlement and handle cleanup are allowed, though a late failure
 * may still be reported through onError.
 *
 * Only primitive arguments and native Error own string data fields are logged.
 * Unsupported objects are [Object]; no object traversal, coercion or getters.
 * Lazy/accessor or unsafe Error stacks become [Stack unavailable]. In V8 older
 * than Node 24 even inspecting a lazy stack descriptor may execute code;
 * native Error stacks on those versions conservatively use the marker.
 * Recognized secrets are redacted before clipping, with bounded text scanning:
 * key=value and key:value forms, quoted or bare values directly after a
 * credential keyword (skipping common English prose via a stopword guard),
 * and URL userinfo (scheme://user:pass@host). This is best-effort filtering,
 * not complete scrubbing of arbitrary secrets.
 *
 * filePath is a unique run namespace, exclusively created and never resumed.
 * With pinOn ('error' default, 'warn' or 'off') the first qualifying record
 * seals the current segment (what was written since the last rotation) into a
 * sibling <run>-incident.jsonl via one rename; pinQuietMs optionally requires
 * a quiet gap before a record counts as an episode start. Later rotations only
 * churn the regular .jsonl chain, so the sealed segment survives. Segments
 * rotated out earlier are outside the pin. The incident file shares the run's
 * retention group.
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
  maxQueueRecords: 2000,
  maxQueueBytes: 1024 * 1024,
  flushIntervalMs: 200,
  maxEntryBytes: 16 * 1024,
  closeTimeoutMs: 2000,
  pinOn: 'error',
  pinQuietMs: 0,
})

const DEFAULT_LEVELS = ['error', 'warn', 'info', 'debug']
const MAX_ARGS = 20
const MAX_SCAN = 64 * 1024
const STACK_UNAVAILABLE = '[Stack unavailable]'
const NativeError = Error
// V8 switched lazy stack storage to ordinary accessors in Node 24. Earlier
// versions can run the formatter merely by requesting its descriptor.
const stackDescriptorIsInert = Number(process.versions.node.split('.')[0]) >= 24
// A quoted value may contain escaped quotes; an unclosed quote consumes the
// rest of its line so a partially written secret is never left behind.
const QUOTED_VALUE = String.raw`"(?:[^"\\\r\n]|\\.)*(?:"|\\(?=[\r\n]|$)|(?=[\r\n]|$))|'(?:[^'\\\r\n]|\\.)*(?:'|\\(?=[\r\n]|$)|(?=[\r\n]|$))`
// Cookie/Set-Cookie carries ';'-separated pairs; quoted values may contain
// semicolons or escaped quotes.
const COOKIE_TOKEN = String.raw`[^\s,;"'=]+`
const COOKIE_VALUE = String.raw`(?:${QUOTED_VALUE}|[^;\r\n]*)`
const COOKIE_PAIR = String.raw`${COOKIE_TOKEN}[^\S\r\n]*=[^\S\r\n]*${COOKIE_VALUE}|${QUOTED_VALUE}|[^\s,;"'=]+`
// Compound names such as DB_PASSWORD are suffixes of a longer identifier, so
// the leading boundary must allow '_' (and '-') while still refusing letters.
const CREDENTIAL_KEY = 'api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|credentials?|authorization|secret|password|passwd|pwd|token|auth|cookie'
// A bare value directly after a credential keyword is redacted unless it is
// one of these common English prose words, so diagnostic sentences such as
// "token was invalid" or "password is required" stay readable.
const BARE_VALUE_STOPWORDS = [
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'do', 'does', 'did', 'done',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'none', 'null', 'undefined', 'empty', 'missing',
  'invalid', 'incorrect', 'wrong', 'mismatch', 'expired',
  'required', 'failed', 'failure', 'denied', 'rejected', 'revoked',
  'disabled', 'enabled', 'error', 'errors', 'warning', 'warn',
  'for', 'from', 'with', 'without', 'to', 'into', 'onto', 'of', 'in', 'on', 'at', 'by',
  'the', 'a', 'an', 'and', 'or', 'if', 'when', 'while', 'then', 'than',
  'that', 'this', 'these', 'those', 'it', 'its',
  'use', 'used', 'using', 'please', 'provide', 'enter', 'set', 'get',
  'check', 'verify', 'expected', 'found', 'type', 'value', 'values',
  'field', 'fields', 'key', 'keys', 'name', 'names',
]
const TEXT_RULES = [
  // Authorization may use any scheme (token, Digest, ...); redact its line value.
  [new RegExp('((?<![A-Za-z0-9])(?:(?:proxy|x)[-_])?authorization)["\']?\\s*[=:]\\s*[^\\r\\n]*', 'gi'), '$1: [REDACTED]'],
  // All cookie pairs are secrets, not only the first one.
  [new RegExp('((?<![A-Za-z0-9])(?:(?:set|x)[-_])?cookie)["\']?\\s*[=:]\\s*(?:' + COOKIE_PAIR + ')(?:[^\\S\\r\\n]*;[^\\S\\r\\n]*(?:' + COOKIE_PAIR + '))*', 'gi'), '$1: [REDACTED]'],
  // The scheme explicitly marks the following token as an auth credential.
  // Preserve only the known Cordis-style prose messages, not short passwords.
  [/\b(?!(?:Basic\s+authentication\s+failed|Bearer\s+authentication\s+required)\b)(?:Bearer|Basic)\s+[^\s,;]+/gi, '[REDACTED]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]+/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]+/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]+/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_.-]+/g, '[REDACTED]'],
  [new RegExp('((?<![A-Za-z0-9])(?:' + CREDENTIAL_KEY + ')["\']?\\s*[=:]\\s*)(?:' + QUOTED_VALUE + '|[^\\s,;]+)', 'gi'), '$1[REDACTED]'],
  // URL userinfo (scheme://user:pass@host) is a credential in any position;
  // only the colon form matches, so plain host:port URLs are untouched.
  [new RegExp('((?:[a-z][a-z0-9+.-]*):\\/\\/)[^\\s\\/@:]*:[^\\s\\/@]*@', 'gi'), '$1[REDACTED]@'],
  // A value quoted directly after a credential keyword needs no = or : at all.
  [new RegExp('((?<![A-Za-z0-9])(?:' + CREDENTIAL_KEY + ')["\']?\\s+)(' + QUOTED_VALUE + ')', 'gi'), '$1[REDACTED]'],
  // A bare value directly after a credential keyword, guarded against prose:
  // the value must start with a word character and not be a stop word, so
  // "password hunter2" is redacted while "password is required" stays intact.
  [new RegExp('((?<![A-Za-z0-9])(?:' + CREDENTIAL_KEY + ')["\']?)(\\s+)(?!(?:' + BARE_VALUE_STOPWORDS.join('|') + ')(?![A-Za-z0-9]))[A-Za-z0-9_$][^\\s,;]*', 'gi'), '$1$2[REDACTED]'],
]

function positiveInt(value, fallback, minimum) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : fallback
}
// 'error' pins on the first ERROR, 'warn' also accepts WARN records, 'off'
// disables pinning. pinOnFirstError=false stays supported as a legacy alias
// for 'off'.
function resolvePinMode(opts) {
  if (opts.pinOn === 'error' || opts.pinOn === 'warn' || opts.pinOn === 'off') return opts.pinOn
  if (opts.pinOnFirstError === false) return 'off'
  return DEFAULTS.pinOn
}
function nowMs(now) {
  try {
    const value = now()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  } catch { /* trusted injected clock may fail */ }
  return Date.now()
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
    pinOn: resolvePinMode(opts),
    pinQuietMs: Math.min(positiveInt(opts.pinQuietMs, DEFAULTS.pinQuietMs, 0), 600_000),
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
  const nameText = redact(name, finalCtx)
  const nameClipped = nameText.length > 120
  const entry = { time: isoNow(now), level, name: nameClipped ? clip(nameText, 120) : nameText, message: redact(message, finalCtx) }
  if (stack) entry.stack = redact(stack, finalCtx)
  if (ctx.truncated || finalCtx.truncated || nameClipped) entry.truncated = true
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
  const state = { accepted: 0, ignored: 0, dropped: 0, written: 0, errors: 0, rotations: 0, incidents: 0, pinFailures: 0, bytesWritten: 0, lost: 0, lastError: null }
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
  let incidentPath = null
  // Latched once a pin sealed (or attempted to seal) existing content; an
  // empty boundary with nothing to protect is skipped and may retry later.
  // Failures are counted in state.pinFailures and never retried.
  let pinAttempted = false
  let lastAcceptedAt = null
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
  // A close timeout discards pending records; report it once, with the same
  // containment rules as every other failure (no raw paths or fs text).
  function noteTimeout() {
    state.lastError = 'Runtime log close timed out; pending records were discarded.'
    if (onError) {
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
  // <filePath minus .jsonl> + '-incident.jsonl', never slicing blindly so a
  // caller-supplied filePath without the extension stays intact.
  function incidentPathFor(target) {
    const base = target.endsWith('.jsonl') ? target.slice(0, -'.jsonl'.length) : target
    return base + '-incident.jsonl'
  }
  // Seals the current segment into <run>-incident.jsonl and starts a fresh
  // one, so the pre-crash context is never touched by rotation. Best-effort:
  // if the rename fails we keep appending to the old segment. The incident
  // path is recorded as soon as the rename succeeds, even if the reopen then
  // fails, so stats always match the directory.
  async function sealSegment() {
    const candidate = incidentPathFor(filePath)
    await releaseHandle()
    if (stopped()) return
    try {
      await fsp.rename(filePath, candidate)
    } catch {
      state.pinFailures++
      if (stopped()) return
      handle = await fsp.open(filePath, 'a', 0o600)
      return
    }
    incidentPath = candidate
    state.incidents++
    if (stopped()) return
    handle = await fsp.open(filePath, 'wx', 0o600)
    currentSize = 0
  }
  // Fallback for a first error that lands right after a rotation: the fresh
  // segment is empty, and the crash context is the just-rotated .1 segment.
  async function sealPreviousSegment() {
    const previous = filePath + '.1'
    const candidate = incidentPathFor(filePath)
    try {
      await fsp.rename(previous, candidate)
    } catch (error) {
      if (ownData(error, 'code') !== 'ENOENT') state.pinFailures++
      return false
    }
    incidentPath = candidate
    state.incidents++
    return true
  }
  // Scans the queue from its head for the next batch: every record that fits
  // into the current segment, stopping right before the first qualifying
  // record (ERROR, or any record in 'warn' mode, optionally after a quiet
  // gap) while a pin is still pending. The pin boundary is checked before the
  // size limit on purpose: a record that does not fit yet must still stop the
  // scan, otherwise it would sit at the queue head during the in-flight write
  // below and could be evicted by capture() before the seal ever happens.
  function buildBatch() {
    const batch = []
    let bytes = 0
    let pinBoundary = false
    for (const item of queue) {
      const qualifies = limits.pinOn === 'warn' ? true : item.error
      if (limits.pinOn !== 'off' && !pinAttempted && !item.pinSkipped && qualifies && item.quiet) {
        pinBoundary = true
        break
      }
      if (currentSize + bytes + item.data.length > limits.maxFileBytes) break
      batch.push(item)
      bytes += item.data.length
    }
    return { batch, bytes, pinBoundary }
  }
  // Appends one batch with a single fsp.appendFile call. inFlight keeps the
  // records counted against queue capacity while the append is outstanding.
  async function writeBatch(batch, bytes) {
    if (bytes === 0) return
    queue.splice(0, batch.length)
    queuedBytes -= bytes
    inFlight = {
      records: batch.length,
      bytes,
      data: bytes === batch[0].data.length
        ? batch[0].data
        : Buffer.concat(batch.map(item => item.data), bytes),
    }
    try {
      await fsp.appendFile(handle, inFlight.data)
      currentSize += bytes
      state.written += batch.length
      state.bytesWritten += bytes
    } catch (error) {
      state.lost += batch.length
      throw error
    } finally { inFlight = null }
  }
  async function drain() {
    try {
      if (stopped()) return
      if (!queue.length) return
      await initialize()
      while (queue.length && !stopped()) {
        // Keep the pending record evictable throughout initialization/rotation.
        if (currentSize + queue[0].data.length > limits.maxFileBytes) {
          await rotate()
          continue
        }
        const { batch, bytes, pinBoundary } = buildBatch()
        await writeBatch(batch, bytes)
        if (pinBoundary) {
          // The boundary record is now next in the queue. Everything before it
          // is on disk; seal that segment once so rotation cannot drop the
          // crash context later. If the segment was just rotated empty, the
          // context sits in .1 and that segment is sealed instead. When there
          // is nothing to protect yet, skip this record as a boundary so it is
          // written normally and a later qualifying record can still pin.
          if (currentSize > 0) {
            await sealSegment()
            pinAttempted = true
          } else if (await sealPreviousSegment()) {
            pinAttempted = true
          } else if (limits.pinOn === 'warn' && limits.pinQuietMs > 0 && queue[0]) {
            // Episode mode: this boundary had nothing to protect yet. Skip
            // that record as a boundary and let a later episode start retry.
            queue[0].pinSkipped = true
          } else {
            pinAttempted = true
          }
          continue
        }
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
      const flightBytes = inFlight?.bytes ?? 0
      const flightCount = inFlight?.records ?? 0
      while (queue.length && (queue.length + flightCount + 1 > limits.maxQueueRecords || queuedBytes + flightBytes + data.length > limits.maxQueueBytes)) {
        queuedBytes -= queue.shift().data.length
        state.dropped++
      }
      if (queue.length + flightCount + 1 > limits.maxQueueRecords || queuedBytes + flightBytes + data.length > limits.maxQueueBytes) {
        state.dropped++
        return false
      }
      const at = nowMs(now)
      // Whether this record starts an episode: the gap since the previous
      // accepted record is at least pinQuietMs (true for the first record).
      const quiet = lastAcceptedAt === null || at - lastAcceptedAt >= limits.pinQuietMs
      lastAcceptedAt = at
      queue.push({ data, error: level === 'error', quiet })
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
          noteTimeout()
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
    const flight = { records: inFlight?.records ?? 0, bytes: inFlight?.bytes ?? 0 }
    return {
      ...state,
      queued: { records: queue.length, bytes: queuedBytes },
      inFlight: flight,
      buffered: { records: queue.length + flight.records, bytes: queuedBytes + flight.bytes },
      limits: { ...limits },
      pinned: incidentPath !== null,
      incidentFile: incidentPath,
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
