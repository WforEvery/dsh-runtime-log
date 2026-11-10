import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pruneRuns } from '../src/retention.js'

const MINUTE = 60 * 1000

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-log-retention-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

function baseName(pid, id = randomUUID()) {
  return 'host-' + pid + '-' + id + '.jsonl'
}

async function seedRun(dir, pid, options = {}) {
  const { rotations = 0, mtime, id = randomUUID() } = options
  const base = baseName(pid, id)
  const files = []
  for (let index = 0; index <= rotations; index += 1) {
    const name = index === 0 ? base : base + '.' + index
    const file = path.join(dir, name)
    await fs.writeFile(file, JSON.stringify({ pid, index }) + '\n')
    if (mtime) await fs.utimes(file, mtime, mtime)
    files.push(file)
  }
  return { pid, id, base, files }
}

function at(minutes) {
  return new Date(Date.UTC(2024, 0, 1) + minutes * MINUTE)
}

async function exists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

test('recognizes only strict host-PID-UUID.jsonl names', async (t) => {
  const dir = await tempDir(t)
  const id = randomUUID()
  const recognized = await seedRun(dir, 1234, { id, rotations: 1 })
  const lastRotation = path.join(dir, baseName(1234, id) + '.31')
  await fs.writeFile(lastRotation, 'valid rotation\n')

  const nested = path.join(dir, 'nested')
  const nestedRunName = baseName(7777)
  await fs.mkdir(nested)
  await fs.writeFile(path.join(nested, nestedRunName), 'nested run\n')

  const runNamedDirectory = path.join(dir, baseName(8888))
  await fs.mkdir(runNamedDirectory)
  await fs.writeFile(path.join(runNamedDirectory, 'inside.txt'), 'directory content\n')

  const ignoredNames = [
    'notes.txt',
    '.jsonl',
    baseName(0, id),
    'host-01-' + id + '.jsonl',
    'host--' + id + '.jsonl',
    'host-1234-not-a-uuid.jsonl',
    'host-1234-' + id + '.jsonl.0',
    'host-1234-' + id + '.jsonl.32',
    'host-1234-' + id + '.jsonl.01',
    'host-1234-' + id + '.jsonl.tmp',
    'host-1234-' + id + '.jsonl.1.1',
    'prefix-host-1234-' + id + '.jsonl',
    'HOST-1234-' + id + '.jsonl',
    'host-1234-' + id + '.JSONL',
    'host-1234-00000000-0000-0000-0000-000000000000.jsonl',
    'host-1234-123e4567-e89b-02d3-a456-426614174000.jsonl',
    'host-1234-123e4567-e89b-42d3-7456-426614174000.jsonl',
  ]
  for (const name of ignoredNames) {
    await fs.writeFile(path.join(dir, name), 'unrelated\n')
  }

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(9999)),
    maxTotalFiles: 16,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 0, retainedFiles: 3, errors: [] })
  for (const file of recognized.files) assert.ok(await exists(file), file + ' should be retained')
  assert.ok(await exists(lastRotation), 'rotation .31 should be recognized')

  for (const name of ignoredNames) {
    assert.ok(await exists(path.join(dir, name)), name + ' must not be touched')
  }
  assert.ok(await exists(path.join(nested, nestedRunName)), 'nested directory must not be traversed')
  assert.ok(await exists(path.join(runNamedDirectory, 'inside.txt')), 'directory must not be deleted')
})

test('deletes whole oldest dead run groups first and preserves live, unknown and current runs', async (t) => {
  const dir = await tempDir(t)
  const current = await seedRun(dir, 44444, { rotations: 1, mtime: at(50) })
  const live = await seedRun(dir, 22222, { rotations: 1, mtime: at(10) })
  const unknown = await seedRun(dir, 33333, { mtime: at(20) })
  const dead = await seedRun(dir, 11111, { rotations: 2, mtime: at(0) })
  const youngerDead = await seedRun(dir, 55555, { mtime: at(40) })

  const statuses = new Map([
    [11111, 'dead'],
    [22222, 'live'],
    [33333, 'unknown'],
    [44444, 'dead'],
    [55555, 'dead'],
  ])
  const probed = []

  const result = await pruneRuns({
    directory: dir,
    // A rotated segment still identifies the current run group.
    currentFilePath: current.files[1],
    maxTotalFiles: 4,
    isAlive: (pid) => {
      probed.push(pid)
      return statuses.get(pid) ?? 'unknown'
    },
  })

  assert.deepEqual(result, { deletedFiles: 4, retainedFiles: 5, errors: [] })
  for (const file of dead.files) assert.equal(await exists(file), false, 'oldest dead run must be deleted')
  for (const file of youngerDead.files) assert.equal(await exists(file), false, 'younger dead run must be deleted')
  for (const file of live.files) assert.ok(await exists(file), 'live run must be preserved')
  for (const file of unknown.files) assert.ok(await exists(file), 'unknown run must be preserved')
  for (const file of current.files) assert.ok(await exists(file), 'current run must be preserved')
  assert.equal(probed.includes(44444), false, 'the current run must not be probed')
})

test('stops deleting as soon as the total file cap is reached', async (t) => {
  const dir = await tempDir(t)
  const oldest = await seedRun(dir, 61001, { rotations: 2, mtime: at(0) })
  const secondDead = await seedRun(dir, 61002, { rotations: 1, mtime: at(10) })
  const live = await seedRun(dir, 61003, { rotations: 2, mtime: at(20) })

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(61004)),
    maxTotalFiles: 6,
    isAlive: (pid) => (pid === 61003 ? 'live' : 'dead'),
  })

  // 8 recognized files: deleting the oldest group of 3 reaches 5 <= 6.
  assert.deepEqual(result, { deletedFiles: 3, retainedFiles: 5, errors: [] })
  for (const file of oldest.files) assert.equal(await exists(file), false)
  for (const file of secondDead.files) assert.ok(await exists(file), 'deletion must stop at the cap')
  for (const file of live.files) assert.ok(await exists(file))
})

test('uses a default cap of 16 total files', async (t) => {
  const dir = await tempDir(t)
  const runs = []
  for (let index = 0; index < 17; index += 1) {
    runs.push(await seedRun(dir, 50000 + index, { mtime: at(index) }))
  }

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(99999)),
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 1, retainedFiles: 16, errors: [] })
  for (const file of runs[0].files) assert.equal(await exists(file), false)
  for (const run of runs.slice(1)) {
    for (const file of run.files) assert.ok(await exists(file), 'newer runs must be retained')
  }
})

test('preserves the current run even when the cap is exceeded', async (t) => {
  const dir = await tempDir(t)
  const dead = await seedRun(dir, 62001, { rotations: 1, mtime: at(0) })
  const current = await seedRun(dir, 62002, { rotations: 2, mtime: at(10) })

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    maxTotalFiles: 1,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 2, retainedFiles: 3, errors: [] })
  for (const file of dead.files) assert.equal(await exists(file), false)
  for (const file of current.files) assert.ok(await exists(file), 'active run must survive a lower cap')
})

test('orders a run group by the mtime of its newest file', async (t) => {
  const dir = await tempDir(t)
  const olderBase = await seedRun(dir, 63001, { mtime: at(0) })
  const rotation = path.join(dir, olderBase.base + '.1')
  await fs.writeFile(rotation, 'newer rotation\n')
  await fs.utimes(rotation, at(30), at(30))
  const middle = await seedRun(dir, 63002, { mtime: at(10) })

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(63003)),
    maxTotalFiles: 2,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 1, retainedFiles: 2, errors: [] })
  for (const file of middle.files) assert.equal(await exists(file), false, 'group with the older newest-file mtime goes first')
  for (const file of olderBase.files) assert.ok(await exists(file))
  assert.ok(await exists(rotation))
})

test('treats a concurrent ENOENT during unlink as a benign removal', async (t) => {
  const dir = await tempDir(t)
  const run = await seedRun(dir, 64001, { rotations: 2 })

  const racingFs = Object.create(fs)
  racingFs.unlink = async (file) => {
    await fs.unlink(file)
    const error = new Error('already removed by another pruner: ' + file)
    error.code = 'ENOENT'
    throw error
  }

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(99998)),
    maxTotalFiles: 1,
    fs: racingFs,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 3, retainedFiles: 0, errors: [] })
  for (const file of run.files) assert.equal(await exists(file), false)
})

test('reports permission failures as sanitized codes without rejecting', async (t) => {
  const dir = await tempDir(t)
  const run = await seedRun(dir, 65001, { rotations: 1 })

  const brokenFs = Object.create(fs)
  brokenFs.unlink = async () => {
    const error = new Error('permission denied while deleting super-secret-token-value')
    error.code = 'EACCES'
    throw error
  }

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(99997)),
    maxTotalFiles: 1,
    fs: brokenFs,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 0, retainedFiles: 2, errors: ['EACCES'] })
  for (const file of run.files) assert.ok(await exists(file), 'failed deletions must leave files in place')
  assert.equal(JSON.stringify(result).includes('super-secret-token-value'), false, 'raw error text leaked')
})

test('does not reject when the directory cannot be read or does not exist', async (t) => {
  const dir = await tempDir(t)

  const unreadableFs = Object.create(fs)
  unreadableFs.readdir = async () => {
    const error = new Error('readdir denied with secret material')
    error.code = 'EACCES'
    throw error
  }

  const denied = await pruneRuns({ directory: dir, fs: unreadableFs })
  assert.deepEqual(denied, { deletedFiles: 0, retainedFiles: 0, errors: ['EACCES'] })
  assert.equal(JSON.stringify(denied).includes('secret material'), false)

  const missing = await pruneRuns({ directory: path.join(dir, 'does-not-exist') })
  assert.deepEqual(missing, { deletedFiles: 0, retainedFiles: 0, errors: [] })
})

test('ignores symlinks even when the link name looks like a run file', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'unrelated-target.txt')
  await fs.writeFile(target, 'keep me\n')
  const link = path.join(dir, baseName(66001))

  let mode = 'file-symlink'
  let injectedFs = fs
  try {
    await fs.symlink(target, link, 'file')
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'EINVAL', 'UNKNOWN'].includes(error.code)) throw error
    const junctionTarget = path.join(dir, 'junction-target')
    try {
      await fs.mkdir(junctionTarget)
      await fs.symlink(junctionTarget, link, 'junction')
      mode = 'directory-junction'
    } catch (junctionError) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'EINVAL', 'UNKNOWN'].includes(junctionError.code)) {
        throw junctionError
      }
      mode = 'simulated-reparse'
      await fs.writeFile(link, 'placeholder\n')
      injectedFs = Object.create(fs)
      injectedFs.lstat = async (file) => {
        if (file === link) {
          return {
            isFile() { return false },
            isSymbolicLink() { return true },
            mtimeMs: Date.now(),
            size: 0,
          }
        }
        return fs.lstat(file)
      }
    }
  }

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(99996)),
    maxTotalFiles: 0,
    fs: injectedFs,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 0, retainedFiles: 0, errors: [] })
  assert.ok(await exists(target), 'symlink target must not be touched')
  assert.ok(await exists(link), 'symlink itself must not be deleted')
  t.diagnostic('symlink case exercised with: ' + mode)
})

test('uses process.kill(pid, 0) by default and retains a live process run', async (t) => {
  const dir = await tempDir(t)
  const live = await seedRun(dir, process.pid)

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(99995)),
    maxTotalFiles: 0,
  })

  assert.deepEqual(result, { deletedFiles: 0, retainedFiles: 1, errors: [] })
  for (const file of live.files) assert.ok(await exists(file))
})

test('retains files when the liveness probe throws or returns an unknown value', async (t) => {
  const dir = await tempDir(t)
  const run = await seedRun(dir, 67001)
  const base = {
    directory: dir,
    currentFilePath: path.join(dir, baseName(99994)),
    maxTotalFiles: 0,
  }

  const thrown = await pruneRuns({
    ...base,
    isAlive: () => {
      const error = new Error('probe failed with super-secret-token-value')
      error.code = 'EACCES'
      throw error
    },
  })
  assert.deepEqual(thrown, { deletedFiles: 0, retainedFiles: 1, errors: ['EACCES'] })
  assert.equal(JSON.stringify(thrown).includes('super-secret-token-value'), false)

  const unexpected = await pruneRuns({ ...base, isAlive: () => true })
  assert.deepEqual(unexpected, { deletedFiles: 0, retainedFiles: 1, errors: [] })

  for (const file of run.files) assert.ok(await exists(file))
})

test('returns EINVAL instead of rejecting for a missing directory', async () => {
  const result = await pruneRuns({ directory: 42 })
  assert.deepEqual(result, { deletedFiles: 0, retainedFiles: 0, errors: ['EINVAL'] })
})

test('retains a current-process run group by default even when the probe reports dead', async (t) => {
  const dir = await tempDir(t)
  const own = await seedRun(dir, process.pid, { rotations: 1, mtime: at(0) })
  const deadOther = await seedRun(dir, 78001, { mtime: at(10) })
  const current = await seedRun(dir, 78002, { mtime: at(20) })
  const probed = []

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    maxTotalFiles: 2,
    isAlive: (pid) => {
      probed.push(pid)
      return 'dead'
    },
  })

  // 4 files, cap 2: only the unrelated dead group may go.
  assert.deepEqual(result, { deletedFiles: 1, retainedFiles: 3, errors: [] })
  for (const file of own.files) assert.ok(await exists(file), 'default must retain the current process run')
  for (const file of deadOther.files) assert.equal(await exists(file), false)
  for (const file of current.files) assert.ok(await exists(file))
  assert.equal(probed.includes(process.pid), false, 'the current process must not be probed by default')
})

test('prunes only unprotected same-PID groups when pruneCurrentProcessRuns is true', async (t) => {
  const dir = await tempDir(t)
  const abandoned = await seedRun(dir, process.pid, { rotations: 2, mtime: at(0) })
  const otherLive = await seedRun(dir, 78003, { mtime: at(10) })
  const otherUnknown = await seedRun(dir, 78004, { mtime: at(15) })
  const current = await seedRun(dir, 78005, { mtime: at(20) })
  const probed = []

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    maxTotalFiles: 4,
    pruneCurrentProcessRuns: true,
    isAlive: (pid) => {
      probed.push(pid)
      return pid === 78003 ? 'live' : 'unknown'
    },
  })

  // 6 files, cap 4: the abandoned same-PID group of 3 is definitely dead.
  assert.deepEqual(result, { deletedFiles: 3, retainedFiles: 3, errors: [] })
  for (const file of abandoned.files) assert.equal(await exists(file), false, 'unprotected same-PID run must be pruned')
  for (const file of otherLive.files) assert.ok(await exists(file), 'other live runs must be preserved')
  for (const file of otherUnknown.files) assert.ok(await exists(file), 'other unknown runs must be preserved')
  for (const file of current.files) assert.ok(await exists(file))
  assert.equal(probed.includes(process.pid), false, 'a definitely-dead same-PID group needs no probe')
})

test('protects currentFilePath and every activeFilePaths run group, rotations included', async (t) => {
  const dir = await tempDir(t)
  const active = await seedRun(dir, 4242, { rotations: 2, mtime: at(0) })
  const abandoned = await seedRun(dir, 4242, { rotations: 1, mtime: at(5) })
  const unknownOther = await seedRun(dir, 78006, { mtime: at(10) })
  const current = await seedRun(dir, 78007, { mtime: at(20) })
  const probed = []

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    // A rotated segment still identifies (and protects) its whole run group.
    activeFilePaths: [active.files[2]],
    currentProcessPid: 4242,
    pruneCurrentProcessRuns: true,
    maxTotalFiles: 4,
    isAlive: (pid) => {
      probed.push(pid)
      return 'unknown'
    },
  })

  // 7 files, cap 4: only the unprotected same-PID group (2) may go.
  assert.deepEqual(result, { deletedFiles: 2, retainedFiles: 5, errors: [] })
  for (const file of active.files) assert.ok(await exists(file), 'active rotations must be protected')
  for (const file of abandoned.files) assert.equal(await exists(file), false)
  for (const file of unknownOther.files) assert.ok(await exists(file))
  for (const file of current.files) assert.ok(await exists(file))
  assert.equal(probed.includes(4242), false)
})

test('protects an activeFilePaths group of another PID from a dead probe result', async (t) => {
  const dir = await tempDir(t)
  const activeOther = await seedRun(dir, 78010, { rotations: 1, mtime: at(0) })
  const deadRun = await seedRun(dir, 78011, { rotations: 1, mtime: at(5) })
  const current = await seedRun(dir, 78012, { mtime: at(20) })

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    activeFilePaths: [activeOther.files[0]],
    maxTotalFiles: 2,
    isAlive: () => 'dead',
  })

  // 5 files, cap 2: the protected group stays, the unprotected dead group goes.
  assert.deepEqual(result, { deletedFiles: 2, retainedFiles: 3, errors: [] })
  for (const file of activeOther.files) assert.ok(await exists(file), 'an active run of any PID must be protected')
  for (const file of deadRun.files) assert.equal(await exists(file), false)
  for (const file of current.files) assert.ok(await exists(file))
})

test('ignores malformed activeFilePaths entries without reporting errors', async (t) => {
  const dir = await tempDir(t)
  const deadButActive = await seedRun(dir, 78020, { rotations: 1, mtime: at(0) })
  const dead = await seedRun(dir, 78021, { rotations: 1, mtime: at(5) })
  const current = await seedRun(dir, 78022, { mtime: at(20) })

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    activeFilePaths: [null, 42, '', 'notes.txt', 'host-0-x.jsonl', deadButActive.files[0]],
    maxTotalFiles: 3,
    isAlive: () => 'dead',
  })

  assert.deepEqual(result, { deletedFiles: 2, retainedFiles: 3, errors: [] })
  for (const file of deadButActive.files) assert.ok(await exists(file), 'a valid entry must still protect its group')
  for (const file of dead.files) assert.equal(await exists(file), false)
  for (const file of current.files) assert.ok(await exists(file))
})

test('treats only boolean true as the current-process prune opt-in', async (t) => {
  const dir = await tempDir(t)
  const own = await seedRun(dir, process.pid, { mtime: at(0) })
  const current = await seedRun(dir, 78030, { mtime: at(10) })

  const truthy = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    maxTotalFiles: 0,
    pruneCurrentProcessRuns: 'true',
    currentProcessPid: 0,
    isAlive: () => 'dead',
  })

  assert.deepEqual(truthy, { deletedFiles: 0, retainedFiles: 2, errors: [] })
  for (const file of own.files) assert.ok(await exists(file), 'a truthy non-boolean must not opt in')
  for (const file of current.files) assert.ok(await exists(file))
})

test('retains an explicitly declared current-process PID by default', async (t) => {
  const dir = await tempDir(t)
  const own = await seedRun(dir, 5555, { rotations: 1, mtime: at(0) })
  const current = await seedRun(dir, 78040, { mtime: at(10) })
  const probed = []

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: current.files[0],
    currentProcessPid: 5555,
    maxTotalFiles: 0,
    isAlive: (pid) => {
      probed.push(pid)
      return 'dead'
    },
  })

  assert.deepEqual(result, { deletedFiles: 0, retainedFiles: 3, errors: [] })
  for (const file of own.files) assert.ok(await exists(file), 'declared current-process runs are retained by default')
  for (const file of current.files) assert.ok(await exists(file))
  assert.deepEqual(probed, [], 'no same-PID group needs a probe')
})

test('rechecks active run paths after an asynchronous directory scan', async (t) => {
  const dir = await tempDir(t)
  const stale = await seedRun(dir, process.pid, { mtime: at(0) })
  const activeBase = baseName(process.pid)
  const activePath = path.join(dir, activeBase)
  const active = new Set()
  const racingFs = Object.create(fs)
  racingFs.readdir = async (directory) => {
    await fs.writeFile(activePath, JSON.stringify({ message: 'new run' }) + '\n')
    active.add(activeBase)
    return fs.readdir(directory)
  }

  const result = await pruneRuns({
    directory: dir,
    currentFilePath: path.join(dir, baseName(99991)),
    activeFilePaths: [],
    currentProcessPid: process.pid,
    pruneCurrentProcessRuns: true,
    maxTotalFiles: 0,
    fs: racingFs,
    isAlive: () => 'dead',
    isRunActive: (_pid, base) => active.has(base),
  })

  assert.deepEqual(result, { deletedFiles: 1, retainedFiles: 1, errors: [] })
  for (const file of stale.files) assert.equal(await exists(file), false)
  assert.ok(await exists(activePath), 'run created after the protection snapshot must survive')
})
