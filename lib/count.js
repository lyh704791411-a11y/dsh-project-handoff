/**
 * Automatic-compaction counter.
 *
 * Fact base (see the spike notes that accompany the DSH port, the inspected
 * contracts, and the real 2026-10-20 headless samples): every compaction appends
 * `compaction/start { compactionId, sourceCommandId?, turn }` and, when it
 * settles, `compaction/end { compactionId, turn, error? }`. An
 * automatic/explicit-region compaction carries the numeric open turn; a manual
 * `/compact` carries `turn: null`. The event has no `trigger` field, so `turn`
 * is the only discriminator available.
 *
 * Count rule:
 *   type === 'compaction/end'
 *   AND data.error is absent (a failed compaction changed no history, so
 *       counting it would overstate "已自动压缩 N 次"; the 2026-10-20 samples
 *       showed a transport-failed `start`/`end` pair that must not count)
 *   AND data.turn is a non-null turn (number, or a numeric string for forward
 *       compatibility)
 *   AND session.header.origin !== 'subagent'
 *   AND session.header.parentSession is absent
 *
 * Counting on `end` rather than `start` costs nothing: the same object carries
 * the turn, and a compaction that never reaches `end` degrades to "no count",
 * which is the safe direction.
 *
 * Known deviation: a programmatic `compactRegion()` call with an explicit turn
 * also has a numeric `turn` and will be counted as automatic. Normal desktop
 * usage does not produce that call.
 */
import { createWarner, messageOf, nowIso } from './util.js'

/** The Session events that open and settle a compaction. */
export const COMPACTION_START = 'compaction/start'
export const COMPACTION_END = 'compaction/end'

/**
 * Whether one `session/event` should increment the automatic-compaction count.
 *
 * `undefined`/missing turns are treated like `null` (not counted), and a
 * settled compaction carrying `error` is not counted: a malformed or failed
 * event must degrade to "no count", never to a false positive.
 *
 * @param {{ id?: string, header?: { origin?: string, parentSession?: unknown } } | null | undefined} session
 * @param {{ type?: string, data?: { turn?: unknown, error?: unknown } } | null | undefined} event
 * @returns {boolean}
 */
export function shouldCount(session, event) {
  if (!event || event.type !== COMPACTION_END) return false
  const data = event.data
  if (!data) return false
  // A settled compaction that failed changed no history; counting it would
  // overstate the notice (observed: transport-failed start/end pair).
  if (data.error !== undefined && data.error !== null && data.error !== '') {
    return false
  }
  const turn = data.turn
  if (turn === null || turn === undefined) return false
  if (!(typeof turn === 'number' || (typeof turn === 'string' && turn.trim() !== ''))) {
    return false
  }
  const header = session?.header ?? {}
  if (header.origin === 'subagent') return false
  if (header.parentSession) return false
  return true
}

/**
 * Register the `session/event` listener.
 *
 * The in-memory `counts` map is a floor, not a cache: if a write fails, the next
 * event still increments from the last known value instead of re-reading the
 * stale on-disk count and losing one.
 *
 * @param {{ on: Function }} ctx
 * @param {{ store: ReturnType<typeof import('./state.js').createStateStore>, logger?: object }} options
 * @returns {() => void}
 */
export function installCount(ctx, { store, logger } = {}) {
  if (typeof ctx?.on !== 'function' || !store) return () => {}
  const warnOnce = createWarner(logger)
  const counts = new Map()

  return ctx.on('session/event', (session, event) => {
    try {
      if (!shouldCount(session, event)) return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return

      const current = store.read(sessionId)
      const known = counts.has(sessionId) ? counts.get(sessionId) : current.count
      const count = (Number.isInteger(known) && known >= 0 ? known : 0) + 1
      counts.set(sessionId, count)

      const eventTime = event?.time
      const at =
        typeof eventTime === 'number' && Number.isFinite(eventTime)
          ? new Date(eventTime).toISOString()
          : nowIso()

      store.write(sessionId, {
        ...current,
        count,
        lastCompactionAt: at,
        updatedAt: nowIso(),
      })
    } catch (error) {
      // A counter must never break the committed Session append feed.
      warnOnce(
        'listener',
        `project-handoff: compaction counter failed: ${messageOf(error)}`,
      )
    }
  })
}
