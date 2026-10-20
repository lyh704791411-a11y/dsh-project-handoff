/**
 * Test-only doubles. No Harness package is imported and every state path lives
 * under a per-test os.tmpdir() directory; the real ~/.dsh is never touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Minimal Cordis-shaped context: `on`, `logger`, `get`, plus a synchronous
 * `emit` for emit-mode events and a `waterfall` helper for pre-step.
 */
export function createFakeCtx({ withLogger = true } = {}) {
  const listeners = new Map()
  const warnings = []
  const logger = {
    warn(message) {
      warnings.push(String(message))
    },
    info() {},
    debug() {},
    error() {},
  }

  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get(name) {
      return name === 'logger' ? logger : undefined
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args)
      }
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
    /**
     * Run waterfall listeners in registration order. Each listener gets a
     * `next` that falls through to the next listener and finally to
     * `fallback` (a decision object or a factory).
     */
    async waterfall(event, payload, fallback) {
      const list = [...(listeners.get(event) ?? [])]
      const run = (index) => {
        if (index >= list.length) {
          return Promise.resolve(
            typeof fallback === 'function' ? fallback() : fallback,
          )
        }
        return Promise.resolve(
          list[index](payload, () => run(index + 1)),
        )
      }
      return run(0)
    },
  }
  if (withLogger) ctx.logger = logger
  return { ctx, warnings, logger }
}

/** Create a temp root and return a (not yet created) state directory inside it. */
export function tempStateDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return path.join(root, 'state')
}

/** Minimal Session value: the plugin reads only id and header. */
export function makeSession({ id = 'session-1', origin, parentSession } = {}) {
  return {
    id,
    header: {
      ...(origin === undefined ? {} : { origin }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

export const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
