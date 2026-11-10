import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  apply,
  name,
  MAX_TOTAL_FILES,
  resolveDirectory,
} from '../src/index.js';

const RUN_FILE = /^host-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl(?:\.\d+)?$/i;
const REGISTRY = Symbol.for('dsh.runtime-log.registry');

async function tempDirectory(t, prefix = 'dsh-runtime-log-test-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function createLogger() {
  const exporters = new Map();
  const calls = { warn: 0, error: 0 };
  let nextId = 0;
  const logger = {
    exporters,
    warn() {
      calls.warn += 1;
    },
    error() {
      calls.error += 1;
    },
    exporter(exporter) {
      const id = ++nextId;
      exporters.set(id, exporter);
      return () => exporters.delete(id);
    },
  };
  return { logger, calls };
}

function createContext(logger, root = {}) {
  const disposers = [];
  const ctx = {
    logger,
    root,
    effect(callback) {
      const dispose = callback();
      disposers.push(dispose);
      return dispose;
    },
  };
  return {
    ctx,
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        if (typeof dispose === 'function') await dispose();
      }
    },
  };
}

// Compiled Cordis builds a fresh message object per exporter registration,
// so each exporter receives a structural copy with the same sequence number.
function emit(logger, record) {
  for (const exporter of [...logger.exporters.values()]) exporter.export({ ...record });
}

async function logFileNames(directory) {
  const names = await readdir(directory);
  return names.filter((entry) => RUN_FILE.test(entry)).sort();
}

async function readRecords(file) {
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function readAll(directory) {
  await waitFor(async () => {
    const names = await logFileNames(directory).catch(() => []);
    for (const entry of names) {
      const records = await readRecords(path.join(directory, entry)).catch(() => []);
      if (events(records).some((record) => record.event === 'stop')) return true;
    }
    return false;
  });
  const names = await logFileNames(directory);
  const records = [];
  for (const entry of names) records.push(...await readRecords(path.join(directory, entry)));
  return { names, records };
}

function events(records) {
  return records.flatMap((record) => {
    const match = typeof record.message === 'string' && record.message.match(/\[plugin-event:(start|stop)\]/);
    return match ? [{ ...record, event: match[1] }] : [];
  });
}

function logs(records) {
  return records.filter((record) => !/\[plugin-event:(?:start|stop)\]/.test(record.message || ''));
}

function registrySinks() {
  const registry = globalThis[REGISTRY];
  return registry && registry.sinks instanceof Map ? registry.sinks.size : 0;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('exports a named plugin entrypoint without unresolvable injection', () => {
  assert.equal(name, 'dsh-runtime-log');
  assert.equal(typeof apply, 'function');
  assert.equal(MAX_TOTAL_FILES, 16);
});

test('routes lifecycle markers through the bounded WARN sink', async (t) => {
  const directory = await tempDirectory(t);
  const { logger } = createLogger();
  const root = createContext(logger);
  apply(root.ctx, { directory, flushIntervalMs: 60_000 });
  emit(logger, { sn: 1, ts: 1, name: 'sample', type: 'warn', args: ['ordinary'] });
  await root.dispose();
  assert.equal((await logFileNames(directory)).length, 1, 'bounded close completes sink drain before disposal resolves');

  const { records } = await readAll(directory);
  assert.ok(records.every((record) => Object.keys(record).every((key) => ['time', 'level', 'name', 'message', 'stack', 'truncated'].includes(key))));
  const lifecycle = records.filter((record) => record.name === name && /\[plugin-event:(start|stop)\]/.test(record.message));
  assert.deepEqual(lifecycle.map((record) => record.level), ['warn', 'warn']);
  assert.match(lifecycle[0].message, /\[plugin-event:start\]/);
  assert.match(lifecycle[1].message, /\[plugin-event:stop\]/);
  assert.match(lifecycle[1].message, /buffered=\d+/);
  assert.match(lifecycle[1].message, /inFlight=0/);
});

test('captures WARN and ERROR, filters INFO/DEBUG, writes lifecycle receipts locally', async (t) => {
  const directory = await tempDirectory(t);
  const { logger, calls } = createLogger();
  const root = createContext(logger);

  apply(root.ctx, { directory, flushIntervalMs: 60_000 });
  assert.equal(logger.exporters.size, 1);
  // Start markers are queued asynchronously through the sink.

  emit(logger, { sn: 1, ts: 1, name: 'sample', type: 'info', args: ['INFO_MUST_BE_ABSENT'] });
  emit(logger, { sn: 2, ts: 2, name: 'sample', type: 'debug', args: ['DEBUG_MUST_BE_ABSENT'] });
  emit(logger, { sn: 3, ts: 3, name: 'sample', type: 'warn', args: ['warning %s', 'visible'] });
  emit(logger, { sn: 4, ts: 4, name: 'sample', type: 'error', args: [new Error('failure')] });
  await root.dispose();

  assert.equal(logger.exporters.size, 0);
  assert.equal(calls.warn, 0, 'receipts must not go through the host logger warn');
  assert.equal(calls.error, 0, 'receipts must not go through the host logger error');

  const { names, records } = await readAll(directory);
  assert.equal(names.length, 1);
  const receipts = events(records);
  assert.deepEqual(receipts.map((record) => record.event), ['start', 'stop']);
  assert.match(receipts[1].message, /written=0/);
  assert.match(receipts[1].message, /buffered=3/);
  assert.match(receipts[1].message, /dropped=0/);

  const lines = logs(records);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((entry) => entry.level), ['warn', 'error']);
  assert.match(lines[0].message, /warning visible/);
  assert.match(lines[1].message, /failure/);
  assert.equal(JSON.stringify(records).includes('INFO_MUST_BE_ABSENT'), false);
  assert.equal(JSON.stringify(records).includes('DEBUG_MUST_BE_ABSENT'), false);
  assert.equal(registrySinks(), 0);
});

test('duplicate fibers share one sink and deduplicate the same record; the survivor keeps writing', async (t) => {
  const directory = await tempDirectory(t);
  const { logger } = createLogger();
  const rootIdentity = {};
  const first = createContext(logger, rootIdentity);
  const second = createContext(logger, rootIdentity);
  apply(first.ctx, { directory, flushIntervalMs: 60_000 });
  apply(second.ctx, { directory, flushIntervalMs: 60_000 });
  assert.equal(logger.exporters.size, 2);

  const record = { sn: 7001, ts: 1, name: 'shared', type: 'warn', args: ['once'] };
  emit(logger, record);
  await first.dispose();
  assert.equal(logger.exporters.size, 1, 'the surviving fiber keeps its exporter');
  emit(logger, { ...record, sn: 7002, args: ['still active'] });
  await second.dispose();
  assert.equal(logger.exporters.size, 0);

  const { names, records } = await readAll(directory);
  assert.equal(names.length, 1, 'duplicate fibers must share one run file');
  assert.deepEqual(logs(records).map((entry) => entry.message), ['once', 'still active']);
  assert.deepEqual(events(records).map((entry) => entry.event), ['start', 'stop']);
});

test('independent logger roots with the same sequence number keep both records', async (t) => {
  const directory = await tempDirectory(t);
  const left = createLogger();
  const right = createLogger();
  const leftRoot = createContext(left.logger);
  const rightRoot = createContext(right.logger);
  apply(leftRoot.ctx, { directory, flushIntervalMs: 60_000 });
  apply(rightRoot.ctx, { directory, flushIntervalMs: 60_000 });

  emit(left.logger, { sn: 1, ts: 1, name: 'left', type: 'warn', args: ['ROOT_A'] });
  emit(right.logger, { sn: 1, ts: 2, name: 'right', type: 'warn', args: ['ROOT_B'] });
  await leftRoot.dispose();
  emit(right.logger, { sn: 2, ts: 3, name: 'right', type: 'warn', args: ['ROOT_B_AFTER'] });
  await rightRoot.dispose();

  const { names, records } = await readAll(directory);
  assert.equal(names.length, 1, 'one canonical directory owns one sink');
  const messages = logs(records).map((entry) => entry.message);
  assert.deepEqual(messages, ['ROOT_A', 'ROOT_B', 'ROOT_B_AFTER']);
  assert.deepEqual(events(records).map((entry) => entry.event), ['start', 'stop']);
});

test('repeated load and unload ten times leaves no exporter or registry leak', async (t) => {
  const directory = await tempDirectory(t);
  const { logger } = createLogger();
  for (let index = 0; index < 10; index += 1) {
    const root = createContext(logger);
    apply(root.ctx, { directory, flushIntervalMs: 60_000 });
    assert.equal(logger.exporters.size, 1, 'cycle ' + index + ': one exporter');
    emit(logger, { sn: index + 1, ts: index, name: 'cycle', type: 'warn', args: ['CYCLE_' + index] });
    await root.dispose();
    assert.equal(logger.exporters.size, 0, 'cycle ' + index + ': exporter removed');
    assert.equal(registrySinks(), 0, 'cycle ' + index + ': registry released');
  }

  const { names, records } = await readAll(directory);
  assert.equal(names.length, 10, 'each activation owns a fresh run namespace');
  const messages = logs(records).map((entry) => entry.message);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(messages.filter((message) => message === 'CYCLE_' + index).length, 1);
  }
});

test('resolves DSH_HOME and ~ exactly like the host path helper', () => {
  const home = path.join(os.tmpdir(), 'dsh-home-fixture');
  const defaultDirectory = path.join(home, '.dsh', 'runtime-log');
  assert.equal(resolveDirectory('', {}, home), defaultDirectory);
  assert.equal(resolveDirectory('', { DSH_HOME: '   ' }, home), defaultDirectory);
  assert.equal(resolveDirectory('', { DSH_HOME: 42 }, home), defaultDirectory);
  assert.equal(resolveDirectory('', { DSH_HOME: '~/harness' }, home), path.join(home, 'harness', 'runtime-log'));
  assert.equal(resolveDirectory('', { DSH_HOME: '~/' }, home), path.join(home, 'runtime-log'));
  assert.equal(resolveDirectory('~/logs', {}, home), path.join(home, 'logs'));
  assert.equal(resolveDirectory('~', {}, home), path.resolve(home));
  assert.equal(resolveDirectory('relative/logs', {}, home), defaultDirectory);
  assert.equal(resolveDirectory(path.join(home, 'explicit'), {}, home), path.join(home, 'explicit'));
});

test('invalid or hostile config never propagates and falls back to defaults', async (t) => {
  const directory = await tempDirectory(t);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  try {
    const configs = [
      null,
      42,
      'text',
      [],
      { directory: 42 },
      { directory: 'relative/path' },
      { directory: '', maxQueueBytes: 1, maxQueueRecords: -4, maxFileBytes: 'x', maxFiles: '999' },
      { flushIntervalMs: Number.NaN, drainTimeoutMs: -1 },
    ];
    for (const config of configs) {
      const { logger, calls } = createLogger();
      const root = createContext(logger);
      assert.doesNotThrow(() => apply(root.ctx, config));
      assert.equal(logger.exporters.size, 1);
      await root.dispose();
      assert.equal(calls.warn, 0);
      assert.equal(calls.error, 0);
    }

    const hostile = {};
    Object.defineProperty(hostile, 'directory', {
      enumerable: true,
      get() {
        throw new Error('config getter must not escape');
      },
    });
    const { logger } = createLogger();
    const root = createContext(logger);
    assert.doesNotThrow(() => apply(root.ctx, hostile));
    await root.dispose();

    const { names } = await readAll(path.join(directory, 'runtime-log'));
    assert.ok(names.length >= configs.length, 'fallback directory received the receipts');
    assert.equal(registrySinks(), 0);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('stop marker snapshots queue stats before close', async (t) => {
  const directory = await tempDirectory(t);
  const { logger } = createLogger();
  const root = createContext(logger);
  apply(root.ctx, {
    directory,
    flushIntervalMs: 60_000,
    maxQueueRecords: 1,
    maxQueueBytes: 4096,
    maxEntryBytes: 512,
  });

  for (let index = 1; index <= 4; index += 1) {
    emit(logger, { sn: index, ts: index, name: 'pressure', type: 'warn', args: ['drop-' + index] });
  }
  await root.dispose();

  const { records } = await readAll(directory);
  const stop = events(records).find((record) => record.event === 'stop');
  assert.ok(stop, 'stop marker is present');
  assert.match(stop.message, /accepted=5/);
  assert.match(stop.message, /dropped=4/);
  assert.match(stop.message, /buffered=1/);
  assert.match(stop.message, /inFlight=0/);
  const lines = logs(records);
  assert.equal(lines.length, 0, 'the final lifecycle marker also obeys the one-record queue bound');
});

test('a failing exporter registration is contained and leaves no shared state', async (t) => {
  const directory = await tempDirectory(t);
  const logger = {
    exporters: new Map(),
    exporter() {
      throw new Error('registration failed');
    },
  };
  const root = createContext(logger);
  assert.doesNotThrow(() => apply(root.ctx, { directory }));
  assert.equal(logger.exporters.size, 0);

  const stopped = await waitFor(async () => {
    if (registrySinks() !== 0) return false;
    const { records } = await readAll(directory).catch(() => ({ records: [] }));
    return events(records).some((record) => record.event === 'stop');
  });
  assert.ok(stopped, 'failed activation still records a stop receipt');
  const { names, records } = await readAll(directory);
  assert.equal(names.length, 1);
  assert.deepEqual(events(records).map((record) => record.event), ['start', 'stop']);
});

test('a missing nested directory is created and shared by canonical path', async (t) => {
  const parent = await tempDirectory(t);
  const directory = path.join(parent, 'missing', 'deep', 'logs');
  const left = createLogger();
  const right = createLogger();
  const leftRoot = createContext(left.logger);
  const rightRoot = createContext(right.logger);
  apply(leftRoot.ctx, { directory, flushIntervalMs: 60_000 });
  apply(rightRoot.ctx, { directory: directory + path.sep + '.', flushIntervalMs: 60_000 });
  emit(left.logger, { sn: 1, ts: 1, name: 'left', type: 'warn', args: ['MISSING_A'] });
  emit(right.logger, { sn: 1, ts: 2, name: 'right', type: 'warn', args: ['MISSING_B'] });
  await leftRoot.dispose();
  await rightRoot.dispose();

  const { names, records } = await readAll(directory);
  assert.equal(names.length, 1);
  assert.deepEqual(logs(records).map((entry) => entry.message), ['MISSING_A', 'MISSING_B']);
});

test('formats hostile record values without throwing', async (t) => {
  const directory = await tempDirectory(t);
  const { logger } = createLogger();
  const root = createContext(logger);
  apply(root.ctx, { directory, flushIntervalMs: 60_000 });

  const cyclic = {};
  cyclic.self = cyclic;
  let getterRan = false;
  Object.defineProperty(cyclic, 'danger', {
    enumerable: true,
    get() {
      getterRan = true;
      throw new Error('getter ran');
    },
  });
  assert.doesNotThrow(() => emit(logger, {
    sn: 1,
    ts: 1,
    name: 'hostile',
    type: 'error',
    args: ['payload %o', cyclic],
  }));
  await root.dispose();

  const { records } = await readAll(directory);
  const lines = logs(records);
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, /\[Object\]|\[Unserializable\]|\[Throws\]/);
  assert.equal(getterRan, false, 'object getters must not be traversed');
  assert.equal(lines[0].message.includes('getter ran'), false);
  assert.equal(registrySinks(), 0);
});

test('lifecycle receipts stay inside the configured per-segment byte cap', async (t) => {
  const directory = await tempDirectory(t);
  const { logger } = createLogger();
  const root = createContext(logger);
  const maxFileBytes = 64 * 1024;
  apply(root.ctx, {
    directory,
    maxFileBytes,
    maxFiles: 3,
    maxEntryBytes: 2048,
    flushIntervalMs: 60_000,
    maxQueueRecords: 2000,
  });
  const payload = 'x'.repeat(600);
  for (let index = 0; index < 160; index += 1) {
    emit(logger, { sn: index + 1, ts: index, name: 'cap', type: 'warn', args: ['entry %d %s', index, payload] });
  }
  await root.dispose();

  const names = await waitFor(async () => (await logFileNames(directory)).length > 0)
    ? await logFileNames(directory) : [];
  assert.ok(names.length >= 1);
  for (const entry of names) {
    const info = await stat(path.join(directory, entry));
    assert.ok(info.size <= maxFileBytes, entry + ' exceeded the segment cap: ' + info.size);
  }
  const { records } = await readAll(directory);
  assert.ok(events(records).some((record) => record.event === 'stop'));
});

test('startup retention preserves the current run when the directory has old runs', async (t) => {
  const directory = await tempDirectory(t);
  const dead = [];
  for (let candidate = 900_001; candidate < 900_200 && dead.length < 17; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (error && error.code === 'ESRCH') dead.push(candidate);
    }
  }
  if (dead.length < 17) {
    t.skip('no 17 definitely dead PIDs available for a retention integration check');
    return;
  }

  const files = [];
  for (let index = 0; index < dead.length; index += 1) {
    const file = path.join(directory, 'host-' + dead[index] + '-' + randomUUID() + '.jsonl');
    await writeFile(file, JSON.stringify({ index }) + '\n');
    const when = new Date(Date.UTC(2020, 0, 1) + index * 60_000);
    await utimes(file, when, when);
    files.push(file);
  }

  const { logger } = createLogger();
  const root = createContext(logger);
  apply(root.ctx, { directory, flushIntervalMs: 60_000 });
  emit(logger, { sn: 1, ts: 1, name: 'retention', type: 'warn', args: ['RETENTION_SURVIVOR'] });
  await root.dispose();

  const { names, records } = await readAll(directory);
  assert.ok(logs(records).some((record) => record.message === 'RETENTION_SURVIVOR'));
  const stop = events(records).find((record) => record.event === 'stop');
  assert.ok(stop);
  assert.ok(names.length >= 1);
  assert.ok(names.some((entry) => entry.startsWith('host-' + process.pid + '-')), 'the current process run remains available');
});
