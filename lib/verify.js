/**
 * End-of-turn verification and the optional steering fallback.
 *
 * `agent/turn-stopping` is serial and awaited before the turn boundary commits.
 * The inspected signature carries `{ agent, turn, signal }`; the runtime
 * dispatcher in this build injects `agent` into the payload (`agentEvents`),
 * so `payload.agent.session.deriveMessages()` is the intended read path. The
 * source reading is not a runtime guarantee: every access here is optional and
 * a missing `agent`/`session`/`deriveMessages` simply skips verification.
 *
 * Verification compares the first *body* paragraph of the last assistant text
 * with the notice injected earlier (`state.lastInjectedNotice`). Quoted lines,
 * fenced code blocks and leading blank lines do not count as the body.
 * `config.steer` defaults to false. When it is true, a mismatch in a turn that
 * has not been steered yet clones the last real user message (runtime-context
 * messages excluded) and calls `agent.steer()` once. The `steeredTurn` state
 * plus an in-memory set make "at most one steer per turn" hold even if the
 * state write fails.
 */
import {
  MAX_INJECTION_CHARS,
  buildInjectionText,
  cloneMessageWithText,
} from './inject.js'
import { createWarner, messageOf, nowIso } from './util.js'

/**
 * Extract readable text from a message. Text blocks are joined with newlines;
 * non-text blocks (tool calls, images, reasoning) are ignored.
 *
 * @param {{ content?: unknown } | null | undefined} message
 * @returns {string}
 */
export function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Text of the last assistant message that actually has text. Scanning past an
 * assistant message that only carried tool calls is intentional: the final
 * answer is the last assistant text, not the last assistant event.
 *
 * @param {readonly object[] | null | undefined} messages
 * @returns {string}
 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const text = textOfMessage(message)
    if (text.trim() !== '') return text
  }
  return ''
}

/**
 * First body paragraph: skip leading blank lines, blockquotes, and fenced code
 * blocks; stop at the next blank line or non-body block.
 *
 * @param {string} text
 * @returns {string}
 */
export function firstParagraph(text) {
  if (typeof text !== 'string') return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const parts = []
  let inFence = false
  let fence = ''

  for (const raw of lines) {
    const line = raw.trim()
    if (inFence) {
      if (line.startsWith(fence)) inFence = false
      continue
    }
    if (line === '') {
      if (parts.length > 0) break
      continue
    }
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (parts.length > 0) break
      inFence = true
      fence = fenceMatch[1].slice(0, 3)
      continue
    }
    if (line.startsWith('>')) {
      if (parts.length > 0) break
      continue
    }
    parts.push(line)
  }

  return parts.join('\n').trim()
}

function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether the assistant's first paragraph displays the injected notice.
 * Containment is allowed because the model may put the required line inside a
 * longer sentence; the notice itself is still required verbatim.
 *
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function noticeMatches(actual, expected) {
  const a = normalizeForCompare(actual)
  const e = normalizeForCompare(expected)
  if (a === '' || e === '') return false
  return a === e || a.includes(e)
}

/**
 * Last user message that represents actual conversation input. The runtime
 * context message this build appends with `surfaceOp: 'append'` also has
 * `role: 'user'`, but it is system-injected (`source.kind:
 * 'runtime-context'`) and must not be replayed as a steering prompt.
 *
 * @param {readonly object[] | null | undefined} messages
 * @returns {object | null}
 */
export function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (message?.source?.kind === 'runtime-context') continue
    return message
  }
  return null
}

function sessionIdOf(agent, session) {
  if (typeof session?.id === 'string' && session.id !== '') return session.id
  if (typeof agent?.id === 'string' && agent.id !== '') return agent.id
  return null
}

/**
 * Register the `agent/turn-stopping` listener.
 *
 * @param {{ on: Function }} ctx
 * @param {{
 *   store: ReturnType<typeof import('./state.js').createStateStore>,
 *   steer?: boolean,
 *   logger?: object,
 * }} options
 * @returns {() => void}
 */
export function installVerify(ctx, { store, steer = false, logger } = {}) {
  if (typeof ctx?.on !== 'function' || !store) return () => {}
  const warnOnce = createWarner(logger)
  const steeredTurns = new Map()

  return ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent
      const session = agent?.session
      if (!session || typeof session.deriveMessages !== 'function') return

      const sessionId = sessionIdOf(agent, session)
      if (sessionId === null) return

      const turn = payload?.turn
      if (!Number.isInteger(turn)) return

      const messages = session.deriveMessages()
      if (!Array.isArray(messages)) return

      const current = store.read(sessionId)
      const expected = current.lastInjectedNotice
      if (typeof expected !== 'string' || expected.trim() === '') return

      const actual = firstParagraph(lastAssistantText(messages))
      const match = noticeMatches(actual, expected)
      const at = nowIso()

      const alreadySteered = steeredTurns.get(sessionId)
      const maySteer =
        steer === true &&
        !match &&
        current.steeredTurn !== turn &&
        !(alreadySteered && alreadySteered.has(turn))

      let didSteer = false
      if (maySteer) {
        const lastUser = lastUserMessage(messages)
        if (lastUser) {
          const stored =
            typeof current.lastInjectedText === 'string' &&
            current.lastInjectedText !== ''
              ? current.lastInjectedText
              : buildInjectionText(expected)
          // The stored copy should already be bounded; cap again so a
          // hand-edited/corrupt state file cannot produce an oversized message.
          const text =
            stored.length <= MAX_INJECTION_CHARS
              ? stored
              : `${stored.slice(0, MAX_INJECTION_CHARS - 1)}…`
          const steerMessage = cloneMessageWithText(lastUser, text)
          if (typeof agent.steer === 'function') {
            try {
              const returned = agent.steer(steerMessage)
              didSteer = true
              if (returned && typeof returned.then === 'function') {
                returned.catch((error) => {
                  warnOnce(
                    `steer-reject:${sessionId}`,
                    `project-handoff: steer rejected: ${messageOf(error)}`,
                  )
                })
              }
              if (alreadySteered) alreadySteered.add(turn)
              else steeredTurns.set(sessionId, new Set([turn]))
            } catch (error) {
              warnOnce(
                `steer:${sessionId}`,
                `project-handoff: steer failed: ${messageOf(error)}`,
              )
            }
          } else {
            warnOnce(
              `steer:${sessionId}`,
              'project-handoff: agent.steer is not a function; skipped steering',
            )
          }
        }
      }

      store.write(sessionId, {
        ...current,
        lastVerify: {
          turn,
          match,
          expected,
          actual,
          noticeTurn: current.lastInjectedTurn ?? null,
          steered: didSteer,
          at,
        },
        steeredTurn: didSteer ? turn : current.steeredTurn,
        updatedAt: at,
      })
    } catch (error) {
      // turn-stopping is awaited: a throw here would abort the turn boundary.
      warnOnce(
        'listener',
        `project-handoff: turn-stopping verification failed: ${messageOf(error)}`,
      )
    }
  })
}
