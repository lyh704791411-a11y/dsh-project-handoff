/**
 * Shared, dependency-free helpers for dsh-project-handoff.
 *
 * Nothing here imports a DSH package. The Host install path used by this
 * profile cannot resolve `@deepseek-ai/*` from a local bundle directory, so the
 * plugin deliberately keeps its runtime dependencies to Node built-ins only.
 */
import os from 'node:os'
import path from 'node:path'

/** Default per-session state directory. Resolved against the real home, never hard-coded. */
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.dsh', 'state', 'project-handoff')

/** Expand a leading `~`, `~/` or `~\` against os.homedir(). */
export function expandHome(input) {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

/**
 * Resolve the raw Loader config object into the two settings this draft uses.
 *
 * There is intentionally no Config schema: importing `@deepseek-ai/schemastery`
 * is what broke the first install of the sibling spike bundle. Unknown keys are
 * ignored here; `config` may be undefined under `node:test`.
 *
 * @param {{ stateDir?: string, steer?: boolean } | undefined} config
 * @returns {{ stateDir: string, steer: boolean }}
 */
export function resolveConfig(config) {
  const raw =
    typeof config?.stateDir === 'string' && config.stateDir.trim() !== ''
      ? config.stateDir.trim()
      : DEFAULT_STATE_DIR
  return {
    stateDir: path.resolve(expandHome(raw)),
    steer: config?.steer === true,
  }
}

/** Pick a warn-capable logger without assuming the Cordis logger service key. */
export function loggerOf(ctx) {
  const direct = ctx?.logger
  if (direct && typeof direct.warn === 'function') return direct
  let lookedUp
  try {
    lookedUp = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
  } catch {
    lookedUp = undefined
  }
  if (lookedUp && typeof lookedUp.warn === 'function') return lookedUp
  return console
}

/** Human-readable message for anything caught. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Call a logger without letting a broken logger break the event feed. */
export function safeWarn(logger, message) {
  try {
    logger.warn(message)
  } catch {
    // Logging must never be the thing that breaks a session.
  }
}

/**
 * Build a warn-once sink keyed by a caller-chosen string.
 *
 * Event listeners run on hot paths (`session/event` on every append,
 * `agent/pre-step` on every step), so a permanently broken path or corrupt
 * state file must not write a warning forever.
 *
 * @param {{ warn: Function } | undefined} logger
 * @returns {(key: string, message: string) => void}
 */
export function createWarner(logger) {
  const seen = new Set()
  return (key, message) => {
    if (seen.has(key)) return
    seen.add(key)
    safeWarn(logger ?? console, message)
  }
}

/** Current wall-clock time in the format stored in state files. */
export function nowIso() {
  return new Date().toISOString()
}

/** True for a non-null, non-array object (JSON object). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
