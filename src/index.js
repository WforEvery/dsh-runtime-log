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
  directory: '', maxFileBytes: 5 * 1024 * 1024, maxFiles: 4,
  maxQueueRecords: 2000, maxQueueBytes: 1024 * 1024,
  maxEntryBytes: 16 * 1024, flushIntervalMs: 200, drainTimeoutMs: 1000,
});
const REGISTRY_KEY = Symbol.for('dsh.runtime-log.registry');
const DEDUP_LIMIT = 4096;
const FALLBACK_INTERVAL_MS = 30_000;
let lastFallbackAt = 0;

function reportFailure() {
  const now = Date.now();
  if (now - lastFallbackAt < FALLBACK_INTERVAL_MS) return;
  lastFallbackAt = now;
  try { process.stderr.write('[dsh-runtime-log] local log write failed; check the configured log directory.\n'); } catch {}
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
      return found;
    }
  } catch {}
  const value = { sinks: new Map(), closing: new Set() };
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
  const filePath = path.join(directory, 'host-' + process.pid + '-' + randomUUID() + '.jsonl');
  const sink = createLogSink({ filePath, ...config, onError: reportFailure });
  const state = { directory, filePath, sink, refs: 0, roots: new Map(), retention: null };
  const activeFilePaths = [
    ...Array.from(reg.sinks.values()).filter(item => item.directory === directory).map(item => item.filePath),
    ...Array.from(reg.closing).filter(item => item.directory === directory).map(item => item.filePath),
  ];
  // Reserve the current run's maximum rotations; concurrent live runs are protected.
  const oldRunBudget = Math.max(0, MAX_TOTAL_FILES - config.maxFiles);
  state.retention = Promise.resolve().then(() => pruneRuns({
    directory, currentFilePath: filePath, activeFilePaths,
    maxTotalFiles: oldRunBudget, currentProcessPid: process.pid, pruneCurrentProcessRuns: true,
    isRunActive: (pid, base) => {
      if (pid !== process.pid) return false;
      for (const item of reg.sinks.values()) {
        if (item.directory === directory && path.basename(item.filePath) === base) return true;
      }
      for (const item of reg.closing) {
        if (item.directory === directory && path.basename(item.filePath) === base) return true;
      }
      return false;
    },
  })).catch(() => null);
  return state;
}
function lifecycle(state, phase, stats) {
  const parts = ['[plugin-event:' + phase + ']'];
  if (stats) {
    parts.push('accepted=' + stats.accepted, 'written=' + stats.written, 'dropped=' + stats.dropped,
      'lost=' + stats.lost, 'errors=' + stats.errors, 'rotations=' + stats.rotations,
      'buffered=' + stats.buffered.records, 'inFlight=' + stats.inFlight.records,
      'disabled=' + stats.disabled, 'timedOut=' + stats.timedOut);
  }
  state.sink.capture({ type: 'warn', name, args: [parts.join(' ')] });
}
async function closeState(reg, state) {
  if (reg.sinks.get(state.directory) === state) reg.sinks.delete(state.directory);
  reg.closing.add(state);
  let snapshot;
  try { snapshot = state.sink.stats(); } catch {}
  lifecycle(state, 'stop', snapshot);
  let definitelySettled = false;
  try {
    await state.sink.close();
    const finalStats = state.sink.stats();
    definitelySettled = finalStats.timedOut !== true && finalStats.inFlight?.records === 0;
  } catch { reportFailure(); }
  // A timeout cannot cancel an issued OS call; keep its run protected until process exit.
  if (definitelySettled) reg.closing.delete(state);
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
    rootState = { refs: 0, seen: new Set(), order: [], exporter: makeExporter(state, null) };
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
