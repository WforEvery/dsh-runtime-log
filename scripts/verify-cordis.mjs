import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as plugin from '../src/index.js';
import * as fixtureHost from './fixture-host.mjs';

const modulePath = process.argv[2] || process.env.DSH_CORDIS_MODULE;
if (!modulePath) throw new Error('Pass the installed or extracted Cordis lib/index.js path as the first argument.');
const resolvedModulePath = path.resolve(modulePath);
const cordisPackagePath = path.resolve(path.dirname(resolvedModulePath), '..', 'package.json');
const cordisPackage = JSON.parse(await readFile(cordisPackagePath, 'utf8'));
if (cordisPackage.version !== '4.1.0') throw new Error('Expected Cordis 4.1.0, got ' + String(cordisPackage.version));
const { Context } = await import(pathToFileURL(resolvedModulePath).href);
const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-log-cordis-'));
const roots = [];
let resolveExit;
const exitRequest = new Promise(resolve => { resolveExit = resolve; });
const rootContext = new Context();
roots.push(rootContext);
rootContext.provide('appReady', { onReady(callback) { const timer = setImmediate(callback); return () => clearImmediate(timer); } });
rootContext.provide('appExit', code => resolveExit(code));
async function recordsIn(dir, predicate = () => true) {
  const deadline = Date.now() + 5000;
  let snapshot = { names: [], records: [] };
  while (Date.now() <= deadline) {
    try {
      const names = (await readdir(dir)).filter(name => /^host-.*\.jsonl(?:\.\d+)?$/.test(name));
      const records = [];
      for (const name of names) {
        const text = await readFile(path.join(dir, name), 'utf8');
        for (const line of text.split(/\r?\n/).filter(Boolean)) records.push(JSON.parse(line));
      }
      snapshot = { names, records };
      if (predicate(snapshot)) return snapshot;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for local log records in the scratch directory');
}
try {
  const root = rootContext;
  const config = { directory: path.join(directory, 'shared'), flushIntervalMs: 60000 };
  const first = await root.plugin(plugin, config);
  const second = await root.plugin(plugin, config);
  const log = root.logger('runtime-log-smoke');
  log.info('INFO_MUST_BE_ABSENT');
  log.warn('SMOKE_BEFORE_DISPOSE %s', 'ok');
  log.error(new Error('SMOKE_ERROR'));
  await first.dispose();
  log.warn('SMOKE_AFTER_FIRST_DISPOSE');
  await second.dispose();
  log.warn('SMOKE_AFTER_ALL_DISPOSED');
  const shared = await recordsIn(config.directory, ({ records }) => records.some(row => row.message?.includes('[plugin-event:stop]')) && records.some(row => row.message?.includes('SMOKE_ERROR')));
  assert.equal(shared.names.length, 1, 'same-root duplicate fibers should use one run');
  const text = JSON.stringify(shared.records);
  assert.ok(!text.includes('INFO_MUST_BE_ABSENT'));
  for (const token of ['SMOKE_BEFORE_DISPOSE ok','SMOKE_AFTER_FIRST_DISPOSE','SMOKE_ERROR']) {
    assert.equal(shared.records.filter(row => row.message?.includes(token)).length, 1, token + ' missing or duplicated');
  }
  for (let index = 0; index < 20; index++) {
    const fiber = await root.plugin(plugin, { directory: path.join(directory, 'cycles'), flushIntervalMs: 60000 });
    log.warn('CYCLE_' + index);
    await fiber.dispose();
    log.warn('AFTER_DISPOSE_' + index);
  }
  const cycles = await recordsIn(path.join(directory, 'cycles'), ({ records }) => records.some(row => row.message === 'CYCLE_19') && records.some(row => row.message?.includes('[plugin-event:stop]')));
  assert.ok(cycles.names.length <= 16, 'same-process reload retention exceeded the file cap');
  assert.ok(cycles.records.some(row => row.message === 'CYCLE_19'), 'latest run is not retained');
  assert.ok(!cycles.records.some(row => /^AFTER_DISPOSE_/.test(row.message || '')), 'record was captured after its owner disposed');
  const seenCycles = cycles.records.filter(row => /^CYCLE_/.test(row.message || '')).map(row => row.message);
  assert.equal(new Set(seenCycles).size, seenCycles.length, 'duplicate records appeared across reloads');
  const independent = new Context(); roots.push(independent);
  const another = new Context(); roots.push(another);
  const separateDir = path.join(directory, 'roots');
  const a = await independent.plugin(plugin, { directory: separateDir, flushIntervalMs: 60000 });
  const b = await another.plugin(plugin, { directory: separateDir, flushIntervalMs: 60000 });
  independent.logger('independent-a').warn('ROOT_A');
  another.logger('independent-b').warn('ROOT_B');
  await a.dispose(); await b.dispose();
  const separate = await recordsIn(separateDir, ({ records }) => records.some(row => row.message === 'ROOT_A') && records.some(row => row.message === 'ROOT_B') && records.some(row => row.message?.includes('[plugin-event:stop]')));
  assert.equal(separate.records.filter(row => row.message === 'ROOT_A').length, 1);
  assert.equal(separate.records.filter(row => row.message === 'ROOT_B').length, 1);
  const fixture = await root.plugin(fixtureHost);
  const exitCode = await exitRequest;
  assert.equal(exitCode, 0);
  await fixture.dispose();
  console.log(JSON.stringify({fixtureHost: 'pass', cordisVersion: cordisPackage.version, duplicateFibers: 'pass', survivingOwner: 'pass', infoFiltered: 'pass', reloadCycles: 20, postDisposeNotCaptured: true, runRetentionMax16: cycles.names.length <= 16, independentContexts: 'pass', scratchFilesRead: shared.names.length + cycles.names.length + separate.names.length }));
} finally {
  for (const root of roots) await root.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
}
