/**
 * Once-per-turn notice injection.
 *
 * `agent/pre-step` is a waterfall. This listener lets the rest of the chain run
 * first (`next()`), then appends exactly one UserMessage to the decision's
 * message list. Appending to `decision.messages` instead of rebuilding from
 * `payload.messages` keeps any runtime-context message a later/default
 * listener already produced.
 *
 * Deduplication is per Session *and turn*, in memory plus the persisted
 * `lastInjectedTurn`. A turn can contain several steps (tool calls); without
 * this gate the notice would be appended at every step and would also be
 * committed to the durable log each time.
 *
 * Shape of the injected message: clone of the first claimed user message, with
 * `content` replaced by one text block and a fresh `id`. Keeping the clone's
 * role/source/extra fields preserves the message shape, while the fresh id
 * avoids two distinct log entries sharing one message identity.
 */
import { randomUUID } from 'node:crypto'

import { createWarner, messageOf, nowIso } from './util.js'

/** Hard cap for the complete injected text. */
export const MAX_INJECTION_CHARS = 1000

/** One short display instruction; the model-facing text stays well under the cap. */
export const DISPLAY_INSTRUCTION =
  '请把上一行原样写进最终答复正文第一段；这是交接提醒，不涉及文件操作。'

/**
 * Build the one-line notice. A zero count is legal but must stay short.
 *
 * @param {unknown} count
 * @returns {string}
 */
export function buildNotice(count) {
  const n =
    typeof count === 'number' && Number.isFinite(count) && count > 0
      ? Math.floor(count)
      : 0
  return n > 0
    ? `project-handoff：本会话已自动压缩 ${n} 次。`
    : 'project-handoff：本会话尚未自动压缩。'
}

/**
 * Build the complete injected text, bounded to MAX_INJECTION_CHARS.
 *
 * @param {string} notice
 * @returns {string}
 */
export function buildInjectionText(notice) {
  const text = `${notice}\n${DISPLAY_INSTRUCTION}`
  if (text.length <= MAX_INJECTION_CHARS) return text
  return `${text.slice(0, MAX_INJECTION_CHARS - 1)}…`
}

/**
 * Clone a message and replace its text content.
 *
 * The fresh `id` is required: the cloned source is usually a message that is
 * about to be appended in the same decision, and two log entries with one
 * message identity would be ambiguous for inbox lookup and projections.
 *
 * @param {object | null | undefined} base
 * @param {string} text
 * @returns {object}
 */
export function cloneMessageWithText(base, text) {
  const source = base && typeof base === 'object' ? base : {}
  const clone = {
    ...source,
    id: randomUUID(),
    content: [{ type: 'text', text }],
  }
  // A goal-round prompt carries `source.kind === 'goal'`. Inheriting it would
  // make this notice look like a second admission of the same round to the
  // strict goal fold, so the goal projection fails replay and the goal stops.
  // The notice is our own message; it is never a goal round.
  if (
    !clone.source ||
    typeof clone.source !== 'object' ||
    clone.source.kind === 'goal'
  ) {
    clone.source = { kind: 'user' }
  }
  if (typeof clone.role !== 'string' || clone.role === '') {
    clone.role = 'user'
  }
  return clone
}

function sessionIdOf(agent) {
  if (typeof agent?.id === 'string' && agent.id !== '') return agent.id
  if (typeof agent?.session?.id === 'string' && agent.session.id !== '') {
    return agent.session.id
  }
  return null
}

function fallbackDecision(payload) {
  return {
    kind: 'enter',
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
  }
}

/**
 * Register the `agent/pre-step` waterfall listener.
 *
 * @param {{ on: Function }} ctx
 * @param {{ store: ReturnType<typeof import('./state.js').createStateStore>, logger?: object }} options
 * @returns {() => void}
 */
export function installInject(ctx, { store, logger } = {}) {
  if (typeof ctx?.on !== 'function' || !store) return () => {}
  const warnOnce = createWarner(logger)
  const seenTurns = new Map()

  return ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision =
        typeof next === 'function' ? await next() : fallbackDecision(payload)
    } catch (error) {
      // Do not break the Agent loop because another listener failed.
      warnOnce(
        'next',
        `project-handoff: pre-step chain failed: ${messageOf(error)}`,
      )
      return fallbackDecision(payload)
    }

    try {
      if (!decision || decision.kind !== 'enter') return decision
      const messages = payload?.messages
      if (!Array.isArray(messages) || messages.length === 0) return decision

      const sessionId = sessionIdOf(payload?.agent)
      if (sessionId === null) return decision

      const turn = payload?.turn
      if (!Number.isInteger(turn)) return decision

      const seen = seenTurns.get(sessionId)
      const current = store.read(sessionId)
      if ((seen && seen.has(turn)) || current.lastInjectedTurn === turn) {
        return decision
      }

      // Claim the turn before any fallible work: a failure later must not make
      // the same turn inject twice.
      if (seen) seen.add(turn)
      else seenTurns.set(sessionId, new Set([turn]))

      const notice = buildNotice(current.count)
      const text = buildInjectionText(notice)
      const message = cloneMessageWithText(messages[0], text)
      const at = nowIso()

      store.write(sessionId, {
        ...current,
        lastInjectedTurn: turn,
        lastInjectedNotice: notice,
        lastInjectedText: text,
        lastInjectedAt: at,
        updatedAt: at,
      })

      const baseMessages = Array.isArray(decision.messages)
        ? decision.messages
        : messages
      return {
        ...decision,
        kind: 'enter',
        messages: [...baseMessages, message],
      }
    } catch (error) {
      warnOnce(
        'listener',
        `project-handoff: pre-step injection failed: ${messageOf(error)}`,
      )
      return decision ?? fallbackDecision(payload)
    }
  })
}
