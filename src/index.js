import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';
import { createLogSink } from './log-sink.js';
import { pruneRuns } from './retention.js';

export const name = 'dsh-runtime-log';
export const MAX_TOTAL_FILES = 16;
export const DEFAULTS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024, maxFiles: 4,
  maxQueueRecords: 2000, maxQueueBytes: 1024 * 1024,
  maxEntryBytes: 16 * 1024, flushIntervalMs: 200, drainTimeoutMs: 1000,
  pinOnFirstError: true,
});
// Shared across plugin copies so one process owns one sink per directory.
// This is a deduplication registry, not a security boundary: Symbol.for is
// reachable by any same-process code, which could equally delete log files
// directly. Every consumer already fails safe against a tampered registry
// (shape-checked in registry(), conservative retention on unexpected shapes).
const REGISTRY_KEY = Symbol.for('dsh.runtime-log.registry');
const DEDUP_LIMIT = 4096;
const MAX_CLOSED_RUN_BASES = 4096;
// Defensive cap against unbounded growth across repeated drain timeouts.
// Eviction is safe in the conservative direction: a timed-out run removed
// from `closing` is never added to closedRunBases, so isRunActive falls back
// to its "active" answer and the run stays protected from pruning.
const MAX_CLOSING_STATES = 4096;
const FALLBACK_INTERVAL_MS = 30_000;
let lastFallbackAt = 0;

function reportFailure() {
  const now = Date.now();
  if (now - lastFallbackAt < FALLBACK_INTERVAL_MS) return;
  lastFallbackAt = now;
  try { process.stderr.write('[dsh-runtime-log] local log write failed; check the configured log directory.\n'); } catch {}
}
// On Windows the 0o600 creation mode has no effect and file access follows the
// directory ACL, so a log directory under %PUBLIC% exposes logs to every
// local account. Warn once per interval when the configured directory is there.
const PUBLIC_WARN_INTERVAL_MS = 30_000;
let lastPublicWarnAt = 0;
function warnIfPubliclyReadable() {
  const now = Date.now();
  if (now - lastPublicWarnAt < PUBLIC_WARN_INTERVAL_MS) return;
  lastPublicWarnAt = now;
  try { process.stderr.write('[dsh-runtime-log] log directory is under a public location; local logs may be readable by other accounts. Configure a private directory.\n'); } catch {}
}
function isUnderPublicRoot(directory, env) {
  try {
    const publicRoot = env?.PUBLIC;
    if (typeof publicRoot !== 'string' || !publicRoot.trim()) return false;
    const root = path.resolve(expandHome(publicRoot, os.homedir())).toLowerCase();
    const dir = path.resolve(directory).toLowerCase();
    return dir === root || dir.startsWith(root + '\\') || dir.startsWith(root + '/');
  } catch { return false; }
}
function expandHome(value, home) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  return value.startsWith('~/') || value.startsWith('~\\') ? path.join(home, value.slice(2)) : value;
}
function resolveHome(env, home) {
  let configured;
  try { configured = env?.DSH_HOME; } catch {}
  const selected = typeof configured === 'string' && configured.trim() ? configured : path.join(home, '.dsh');
  return path.resolve(expandHome(selected, home));
}
export function resolveDirectory(configured, env = process.env, home = os.homedir()) {
  if (typeof configured === 'string' && configured.trim()) {
    const expanded = expandHome(configured, home);
    if (path.isAbsolute(expanded)) return path.resolve(expanded);
  }
  return path.join(resolveHome(env, home), 'runtime-log');
}
function dataField(object, key) {
  try {
    if (!object || typeof object !== 'object' || types.isProxy(object)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function bounded(value, fallback, min, max) {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) && !types.isProxy(raw) ? raw : null;
  const field = key => dataField(source, key);
  const queueBytes = bounded(field('maxQueueBytes'), DEFAULTS.maxQueueBytes, 4096, 16 * 1024 * 1024);
  let directory;
  try { directory = resolveDirectory(field('directory')); } catch { directory = path.join(os.tmpdir(), 'dsh-runtime-log'); }
  return {
    directory,
    maxFileBytes: bounded(field('maxFileBytes'), DEFAULTS.maxFileBytes, 64 * 1024, 100 * 1024 * 1024),
    maxFiles: bounded(field('maxFiles'), DEFAULTS.maxFiles, 2, 32),
    maxQueueRecords: bounded(field('maxQueueRecords'), DEFAULTS.maxQueueRecords, 1, 50_000),
    maxQueueBytes: queueBytes,
    maxEntryBytes: bounded(field('maxEntryBytes'), Math.min(DEFAULTS.maxEntryBytes, queueBytes), 256, Math.min(256 * 1024, queueBytes)),
    flushIntervalMs: bounded(field('flushIntervalMs'), DEFAULTS.flushIntervalMs, 25, 60_000),
    drainTimeoutMs: bounded(field('drainTimeoutMs'), DEFAULTS.drainTimeoutMs, 25, 10_000),
    pinOnFirstError: field('pinOnFirstError') !== false,
  };
}
function canonicalize(directory) {
  const resolved = path.resolve(directory);
  const realpath = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
  try { return path.resolve(realpath(resolved)); } catch {}
  let current = resolved;
  const suffix = [];
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
    try { return path.resolve(path.join(realpath(current), ...suffix)); } catch {}
  }
  return resolved;
}
function registry() {
  try {
    const found = globalThis[REGISTRY_KEY];
    if (found?.sinks instanceof Map) {
      if (!(found.closing instanceof Set)) found.closing = new Set();
      if (!(found.closedRunBases instanceof Set)) found.closedRunBases = new Set();
      return found;
    }
  } catch {}
  const value = { sinks: new Map(), closing: new Set(), closedRunBases: new Set() };
  try { Object.defineProperty(globalThis, REGISTRY_KEY, { value, configurable: true, writable: true }); } catch {}
  return value;
}
function makeExporter(state, rootState) {
  return { export(message) {
    try {
      if (!message || typeof message !== 'object' || types.isProxy(message)) return;
      const type = dataField(message, 'type');
      if (type !== 'warn' && type !== 'error') return;
      const sequence = dataField(message, 'sn');
      if (Number.isSafeInteger(sequence)) {
        if (rootState.seen.has(sequence)) return;
        rootState.seen.add(sequence);
        rootState.order.push(sequence);
        if (rootState.order.length > DEDUP_LIMIT) rootState.seen.delete(rootState.order.shift());
      }
      state.sink.capture(message);
    } catch { reportFailure(); }
  } };
}
function makeState(directory, config, reg) {
  if (isUnderPublicRoot(directory, process.env)) warnIfPubliclyReadable();
  const filePath = path.join(directory, 'host-' + process.pid + '-' + randomUUID() + '.jsonl');
  const sink = createLogSink({ filePath, ...config, onError: reportFailure });
  const state = { directory, filePath, sink, refs: 0, roots: new Map(), retention: null, drainTimeoutMs: config.drainTimeoutMs };
  // Run UUIDs are unique inside this process, so activity is matched by the run
  // basename instead of by directory string. Two case spellings of a Windows
  // directory that did not exist at apply time become different registry keys
  // while still naming one real directory; a string comparison would let a
  // live aliased run be treated as dead and deleted.
  // A tampered registry must not break acquire: entries without a string
  // filePath are ignored rather than dereferenced.
  const activeFilePaths = [
    ...Array.from(reg.sinks.values()),
    ...Array.from(reg.closing),
  ].map(item => (item && typeof item.filePath === 'string' ? item.filePath : null))
    .filter(Boolean);
  const isRunActive = (pid, base) => {
    if (pid !== process.pid) return false;
    const matches = (item) => item && typeof item.filePath === 'string' && path.basename(item.filePath) === base;
    for (const item of reg.sinks.values()) {
      if (matches(item)) return true;
    }
    for (const item of reg.closing) {
      if (matches(item)) return true;
    }
    if (reg.closedRunBases.has(base)) return false;
    // This same PID may belong to a worker isolate whose registry is not visible
    // here. Only runs this isolate has fully settled may be pruned.
    return true;
  };
  // Target the files that actually exist: reserve one slot only while the
  // current run has not written its first segment, never all future rotations.
  state.retention = Promise.resolve().then(() => pruneRuns({
    directory, currentFilePath: filePath, activeFilePaths,
    maxTotalFiles: MAX_TOTAL_FILES, reserveCurrentRun: true,
    currentProcessPid: process.pid, pruneCurrentProcessRuns: true, isRunActive,
  })).catch(() => null);
  return state;
}
function lifecycle(state, phase, stats) {
  const parts = ['[plugin-event:' + phase + ']'];
  if (stats) {
    parts.push('accepted=' + stats.accepted, 'written=' + stats.written, 'dropped=' + stats.dropped,
      'lost=' + stats.lost, 'errors=' + stats.errors, 'rotations=' + stats.rotations,
      'incidents=' + stats.incidents, 'pinned=' + stats.pinned, 'pinFailures=' + stats.pinFailures,
      'buffered=' + stats.buffered.records, 'inFlight=' + stats.inFlight.records,
      'disabled=' + stats.disabled, 'timedOut=' + stats.timedOut);
  }
  state.sink.capture({ type: 'warn', name, args: [parts.join(' ')] });
}
async function closeState(reg, state) {
  const closeDeadline = Date.now() + state.drainTimeoutMs;
  if (reg.sinks.get(state.directory) === state) reg.sinks.delete(state.directory);
  reg.closing.add(state);
  // Bounded defense: an evicted timed-out run falls back to isRunActive's
  // conservative answer (never positively closed, never pruned).
  if (reg.closing.size > MAX_CLOSING_STATES) reg.closing.delete(reg.closing.values().next().value);
  let snapshot;
  try { snapshot = state.sink.stats(); } catch {}
  lifecycle(state, 'stop', snapshot);
  let definitelySettled = false;
  try {
    await state.sink.close();
    const finalStats = state.sink.stats();
    definitelySettled = finalStats.timedOut !== true && finalStats.inFlight?.records === 0;
  } catch { reportFailure(); }
  // Retention may block on a slow or unavailable filesystem. Do not let that
  // background scan extend the Cordis disposer beyond the sink's close deadline.
  // Keep the run in `closing` until the scan settles, then record that this
  // isolate has positively established it as closed and eligible for pruning.
  if (definitelySettled) {
    const rememberClosedRun = () => {
      if (!reg.closing.delete(state)) return;
      const base = path.basename(state.filePath);
      reg.closedRunBases.delete(base);
      reg.closedRunBases.add(base);
      if (reg.closedRunBases.size > MAX_CLOSED_RUN_BASES) {
        reg.closedRunBases.delete(reg.closedRunBases.values().next().value);
      }
    };
    const retentionSettled = Promise.resolve(state.retention).then(rememberClosedRun, rememberClosedRun);
    const remainingMs = Math.max(0, closeDeadline - Date.now());
    if (remainingMs > 0) {
      let deadlineTimer;
      await Promise.race([retentionSettled, new Promise((resolve) => { deadlineTimer = setTimeout(resolve, remainingMs); })]);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    } else {
      void retentionSettled;
    }
  }
  // A timeout cannot cancel an issued OS call; keep its run protected until process exit.
}
function acquire(ctx, config) {
  const reg = registry();
  const directory = canonicalize(config.directory);
  let state = reg.sinks.get(directory);
  if (!state) {
    state = makeState(directory, config, reg);
    reg.sinks.set(directory, state);
    lifecycle(state, 'start');
  }
  state.refs++;
  let root = ctx;
  try { if (ctx.root && (typeof ctx.root === 'object' || typeof ctx.root === 'function')) root = ctx.root; } catch {}
  let rootState = state.roots.get(root);
  if (!rootState) {
    rootState = { refs: 0, seen: new Set(), order: [], exporter: null };
    state.roots.set(root, rootState);
    rootState.exporter = makeExporter(state, rootState);
  }
  rootState.refs++;
  let logger;
  let disposeExporter;
  try {
    logger = ctx.logger;
    disposeExporter = logger.exporter(rootState.exporter);
  } catch {
    rootState.refs--;
    if (rootState.refs === 0) state.roots.delete(root);
    state.refs--;
    if (state.refs === 0) void closeState(reg, state).catch(() => {});
    return () => {};
  }
  let releasePromise;
  return () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      try { disposeExporter?.(); } catch { reportFailure(); }
      rootState.refs--;
      if (rootState.refs <= 0 && state.roots.get(root) === rootState) state.roots.delete(root);
      state.refs--;
      if (state.refs <= 0) await closeState(reg, state);
    })();
    return releasePromise;
  };
}
export function apply(ctx, rawConfig) {
  let config;
  try { config = normalize(rawConfig); } catch { config = normalize(null); }
  try { ctx.effect(() => acquire(ctx, config), name); } catch { reportFailure(); }
}
