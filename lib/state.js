/**
 * Per-session JSON state for dsh-project-handoff.
 *
 * One file per Session: `<stateDir>/<safe-session-id>-<hash8>.json`. Writes are
 * atomic (write a sibling temp file, then rename). Reads and writes are
 * deliberately synchronous: `session/event` is a fire-and-forget emit and
 * `agent/turn-stopping` is awaited, so a rejected promise would surface as an
 * unhandled rejection instead of a contained failure.
 *
 * Fail-soft contract: a missing directory, an unwritable path, or a truncated
 * JSON file only produces one `logger.warn` for that failure; no state error
 * ever escapes into the Session or Agent loop.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import {
  DEFAULT_STATE_DIR,
  createWarner,
  isPlainObject,
  messageOf,
  nowIso,
} from './util.js'

/** The empty state returned for a missing, corrupt, or unreadable file. */
export function emptyState() {
  return {
    count: 0,
    lastCompactionAt: null,
    updatedAt: null,
    lastInjectedTurn: null,
    lastInjectedNotice: null,
    lastInjectedText: null,
    lastInjectedAt: null,
    lastVerify: null,
    steeredTurn: null,
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

/**
 * Coerce whatever was on disk into the shape listeners can safely read.
 * Extra fields from a future version are dropped rather than trusted.
 */
export function normalizeState(raw) {
  if (!isPlainObject(raw)) return emptyState()
  const count =
    typeof raw.count === 'number' && Number.isFinite(raw.count) && raw.count >= 0
      ? Math.floor(raw.count)
      : 0
  return {
    count,
    lastCompactionAt: stringOrNull(raw.lastCompactionAt),
    updatedAt: stringOrNull(raw.updatedAt),
    lastInjectedTurn: integerOrNull(raw.lastInjectedTurn),
    lastInjectedNotice: stringOrNull(raw.lastInjectedNotice),
    lastInjectedText: stringOrNull(raw.lastInjectedText),
    lastInjectedAt: stringOrNull(raw.lastInjectedAt),
    lastVerify: isPlainObject(raw.lastVerify) ? raw.lastVerify : null,
    steeredTurn: integerOrNull(raw.steeredTurn),
  }
}

/**
 * Turn a Session id into one safe filename component.
 *
 * Session ids are usually UUIDs, but they are caller-provided data. Strip path
 * separators and traversal dots, bound the readable part, and append a short
 * digest so two ids that sanitize to the same prefix cannot share a file.
 *
 * @param {unknown} sessionId
 * @returns {string} filename ending in `.json`
 */
export function safeSessionFileName(sessionId) {
  const raw = String(sessionId ?? '')
  const readable = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '_')
    .slice(0, 96)
  const base = readable === '' ? 'session' : readable
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8)
  return `${base}-${digest}.json`
}

function toSessionId(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Create the state store used by count/inject/verify.
 *
 * @param {{ stateDir?: string, logger?: { warn: Function } }} [options]
 * @returns {{
 *   stateDir: string,
 *   fileFor: (sessionId: unknown) => string,
 *   read: (sessionId: unknown) => ReturnType<typeof emptyState>,
 *   write: (sessionId: unknown, state: object) => boolean,
 * }}
 */
export function createStateStore({ stateDir = DEFAULT_STATE_DIR, logger } = {}) {
  const dir = path.resolve(stateDir)
  const warnOnce = createWarner(logger)

  function fileFor(sessionId) {
    return path.join(dir, safeSessionFileName(sessionId))
  }

  function read(sessionId) {
    const id = toSessionId(sessionId)
    if (id === null) return emptyState()
    const file = fileFor(id)
    try {
      const text = fs.readFileSync(file, 'utf8')
      return normalizeState(JSON.parse(text))
    } catch (error) {
      // A missing file is the normal first-run case; nothing to report.
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return emptyState()
      }
      warnOnce(
        `read:${file}`,
        `project-handoff: cannot read state ${file}: ${messageOf(error)}; using empty state`,
      )
      return emptyState()
    }
  }

  function write(sessionId, state) {
    const id = toSessionId(sessionId)
    if (id === null) return false
    const file = fileFor(id)
    const normalized = normalizeState(state)
    const record = {
      ...normalized,
      updatedAt:
        typeof state?.updatedAt === 'string' && state.updatedAt !== ''
          ? state.updatedAt
          : nowIso(),
    }
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch (error) {
      // Best-effort temp cleanup; a leftover temp file is not worth a second warn.
      try {
        fs.unlinkSync(tmp)
      } catch {
        // Ignore: the temp file may never have been created.
      }
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'unknown'
      warnOnce(
        `write:${file}:${code}`,
        `project-handoff: cannot write state ${file}: ${messageOf(error)}`,
      )
      return false
    }
  }

  return { stateDir: dir, fileFor, read, write }
}
