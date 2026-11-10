/**
 * dsh-runtime-log - bounded retention for per-process run files.
 *
 * pruneRuns({
 *   directory,
 *   currentFilePath,
 *   activeFilePaths = [],
 *   maxTotalFiles = 16,
 *   currentProcessPid = process.pid,
 *   pruneCurrentProcessRuns = false,
 *   fs?,
 *   isAlive?,
 * })
 * returns { deletedFiles, retainedFiles, errors } and never rejects.
 *
 * A run file is recognized only when its basename is exactly
 * host-<positive decimal pid>-<valid UUID>.jsonl with an optional .1 ... .31
 * rotation suffix. Recognized files are grouped by their run basename (the
 * rotation suffixes belong to the same run), and only regular files are
 * considered: symbolic links, junctions, directories and unrelated names are
 * ignored and never followed.
 *
 * Every protected run group is always retained: the current run, identified
 * by currentFilePath (including any rotation), and each group named by an
 * activeFilePaths entry (again including any rotation). Unrecognized or
 * malformed entries are ignored rather than treated as errors.
 *
 * When the number of recognized files exceeds maxTotalFiles, whole run groups
 * whose process is definitely dead are removed oldest first, where a group's
 * age is the newest mtime among its files. Groups with a live or unknown
 * process are never removed. Pruning stops as soon as the cap is met or no
 * dead groups remain, so live/unknown/protected runs can legitimately leave
 * the directory above the cap.
 *
 * process.pid is the current process, so its own older run groups are not
 * "definitely dead": by default (pruneCurrentProcessRuns = false) any group
 * whose PID equals currentProcessPid is retained without probing, exactly as a
 * live run would be. A caller that tracks every active run of this process can
 * opt in with pruneCurrentProcessRuns = true; only then is an unprotected
 * same-PID group treated as definitely dead without consulting isAlive, while
 * every other PID keeps the isAlive contract and still needs an ESRCH-backed
 * "dead" result.
 *
 * isAlive(pid) is synchronous and returns "live", "dead" or "unknown". The
 * default probes with process.kill(pid, 0): only ESRCH means "dead"; success
 * means "live"; every other failure (EPERM, EACCES, ...) means "unknown".
 * A throwing predicate, an unexpected return value, or any unexpected
 * filesystem failure is reported as a sanitized error code and treated as
 * "retain" - this module never deletes on uncertainty.
 *
 * Concurrent pruners are tolerated: an ENOENT from unlink means the file is
 * already gone and is counted as removed. Other errors are returned as short
 * codes (for example "EACCES") without raw messages, paths or secrets. The
 * function only reads the configured directory (no recursion, no traversal),
 * only unlinks recognized files, and never renames anything.
 *
 * This is best-effort retention, not a hard disk quota: a directory containing
 * only current/live/unknown runs can stay above maxTotalFiles.
 */
import defaultFs from 'node:fs/promises'
import nodePath from 'node:path'

const DEFAULT_MAX_TOTAL_FILES = 16

// host-<pid>-<uuid>.jsonl[.1..31]
// PID: positive decimal without a leading zero.
// UUID: canonical 8-4-4-4-12, RFC 4122 version 1-8 and variant 8/9/a/b.
const RUN_FILE_RE = /^host-([1-9]\d*)-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\.jsonl(?:\.([1-9]|[12]\d|3[01]))?$/

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    try {
      return error && error.code === 'ESRCH' ? 'dead' : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

function resolveFs(input) {
  if (!input || typeof input !== 'object') return defaultFs
  return {
    readdir: typeof input.readdir === 'function' ? input.readdir.bind(input) : defaultFs.readdir,
    lstat: typeof input.lstat === 'function' ? input.lstat.bind(input) : defaultFs.lstat,
    unlink: typeof input.unlink === 'function' ? input.unlink.bind(input) : defaultFs.unlink,
  }
}

function resolveMaxTotalFiles(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return DEFAULT_MAX_TOTAL_FILES
}

function parseRunFile(name) {
  if (typeof name !== 'string') return null
  const match = RUN_FILE_RE.exec(name)
  if (match === null) return null
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const runId = match[2].toLowerCase()
  return {
    pid,
    rotation: match[3] === undefined ? 0 : Number(match[3]),
    base: 'host-' + pid + '-' + runId + '.jsonl',
  }
}

function currentGroupBase(currentFilePath) {
  if (typeof currentFilePath !== 'string' || currentFilePath.length === 0) return null
  let name
  try {
    name = nodePath.basename(currentFilePath)
  } catch {
    return null
  }
  const parsed = parseRunFile(name)
  return parsed === null ? null : parsed.base
}

// Run-group bases that must never be pruned: the current file plus every
// caller-declared active file. Rotations resolve to their base, so declaring
// any segment protects the whole group. Malformed entries are ignored.
function protectedGroupBases(settings) {
  const bases = new Set()
  const add = (value) => {
    const base = currentGroupBase(value)
    if (base !== null) bases.add(base)
  }
  add(settings.currentFilePath)
  const activeFilePaths = settings.activeFilePaths
  if (Array.isArray(activeFilePaths)) {
    for (const value of activeFilePaths) {
      try {
        add(value)
      } catch {
        // An exotic value (throwing toString/getter) is simply not protected.
      }
    }
  }
  return bases
}

function resolveCurrentProcessPid(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  return process.pid
}

// Strict opt-in: any non-boolean truthy value stays with the conservative path.
function resolvePruneCurrentProcessRuns(value) {
  return value === true
}

function isRegularFile(stats) {
  try {
    if (!stats || typeof stats.isFile !== 'function') return false
    if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) return false
    return stats.isFile()
  } catch {
    return false
  }
}

function mtimeOf(stats) {
  try {
    const value = Number(stats.mtimeMs)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function sanitizedErrorCode(error) {
  try {
    const code = error && typeof error.code === 'string' ? error.code : ''
    return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'EUNKNOWN'
  } catch {
    return 'EUNKNOWN'
  }
}

export async function pruneRuns(options = {}) {
  const result = { deletedFiles: 0, retainedFiles: 0, errors: [] }
  const errorCodes = new Set()
  let deletedFiles = 0
  let retainedFiles = 0

  const noteError = (error) => {
    errorCodes.add(sanitizedErrorCode(error))
  }
  const finalize = () => {
    result.deletedFiles = deletedFiles
    result.retainedFiles = retainedFiles
    result.errors = Array.from(errorCodes)
    return result
  }

  try {
    const settings = options !== null && typeof options === 'object' ? options : null
    if (settings === null) {
      errorCodes.add('EINVAL')
      return finalize()
    }

    const directory = settings.directory
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      errorCodes.add('EINVAL')
      return finalize()
    }

    const fsp = resolveFs(settings.fs)
    const isAlive = typeof settings.isAlive === 'function' ? settings.isAlive : defaultIsAlive
    const maxTotalFiles = resolveMaxTotalFiles(settings.maxTotalFiles)
    const protectedBases = protectedGroupBases(settings)
    const currentProcessPid = resolveCurrentProcessPid(settings.currentProcessPid)
    const pruneCurrentProcessRuns = resolvePruneCurrentProcessRuns(settings.pruneCurrentProcessRuns)

    let names
    try {
      names = await fsp.readdir(directory)
    } catch (error) {
      // A missing directory simply means there is nothing to prune yet.
      if (!(error && error.code === 'ENOENT')) noteError(error)
      return finalize()
    }
    if (!Array.isArray(names)) return finalize()

    const files = []
    for (const name of names) {
      const parsed = parseRunFile(name)
      if (parsed === null) continue
      const filePath = nodePath.join(directory, name)
      let stats
      try {
        stats = await fsp.lstat(filePath)
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        noteError(error)
        continue
      }
      if (!isRegularFile(stats)) continue
      files.push({
        path: filePath,
        base: parsed.base,
        pid: parsed.pid,
        rotation: parsed.rotation,
        mtimeMs: mtimeOf(stats),
      })
    }

    retainedFiles = files.length
    if (retainedFiles <= maxTotalFiles) return finalize()

    const groups = new Map()
    for (const file of files) {
      let group = groups.get(file.base)
      if (group === undefined) {
        group = { base: file.base, pid: file.pid, files: [], latestMtime: 0 }
        groups.set(file.base, group)
      }
      group.files.push(file)
      if (file.mtimeMs > group.latestMtime) group.latestMtime = file.mtimeMs
    }

    // Oldest group first, using the newest file in each group. The basename
    // tie-break keeps the order deterministic when mtimes are equal.
    const ordered = Array.from(groups.values()).sort((left, right) => {
      if (left.latestMtime !== right.latestMtime) return left.latestMtime - right.latestMtime
      if (left.base === right.base) return 0
      return left.base < right.base ? -1 : 1
    })

    const isCurrentlyActive = (group) => {
      if (typeof settings.isRunActive !== 'function') return false
      try {
        return settings.isRunActive(group.pid, group.base) === true
      } catch (error) {
        noteError(error)
        return true
      }
    }

    for (const group of ordered) {
      if (retainedFiles <= maxTotalFiles) break
      // The directory listing is asynchronous. Re-check the caller's live registry
      // after that await so new same-PID runs are not mistaken for closed runs.
      if (protectedBases.has(group.base) || isCurrentlyActive(group)) continue

      let status
      if (group.pid === currentProcessPid) {
        // This process is still running, so its own runs are never "definitely
        // dead" unless the caller explicitly asserts it tracks every active
        // run of this process.
        if (!pruneCurrentProcessRuns) continue
        status = 'dead'
      } else {
        try {
          status = isAlive(group.pid)
        } catch (error) {
          noteError(error)
          status = 'unknown'
        }
      }
      if (status !== 'dead') continue

      // Remove the oldest segments first and leave the base file for last, so
      // an interrupted prune never discards the newest part of a run first.
      const orderedFiles = group.files.slice().sort((left, right) => right.rotation - left.rotation)
      for (const file of orderedFiles) {
        if (isCurrentlyActive(group)) break
        try {
          await fsp.unlink(file.path)
          deletedFiles += 1
          retainedFiles -= 1
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            // Another pruner already removed it; the group still shrank.
            deletedFiles += 1
            retainedFiles -= 1
          } else {
            noteError(error)
          }
        }
      }
    }
  } catch (error) {
    noteError(error)
  }

  return finalize()
}
