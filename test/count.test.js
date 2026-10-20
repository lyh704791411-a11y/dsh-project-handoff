/**
 * Count rule: only a settled, successful automatic compaction counts —
 * never manual, never failed, never subagent, never a missing turn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { installCount, shouldCount } from '../lib/count.js'
import { createStateStore } from '../lib/state.js'
import { ISO_REGEX, createFakeCtx, makeSession, tempStateDir } from './helpers.js'

const EVENT = (turn, type = 'compaction/end') => ({
  type,
  time: 1700000000000,
  data: { compactionId: 'c1', turn },
})

test('shouldCount: automatic turn counts', () => {
  assert.equal(shouldCount(makeSession(), EVENT(1)), true)
  assert.equal(shouldCount(makeSession(), EVENT(7)), true)
})

test('shouldCount: manual /compact (turn null) does not count', () => {
  assert.equal(shouldCount(makeSession(), EVENT(null)), false)
})

test('shouldCount: subagent origin does not count', () => {
  assert.equal(
    shouldCount(makeSession({ origin: 'subagent' }), EVENT(2)),
    false,
  )
})

test('shouldCount: child session (parentSession) does not count', () => {
  assert.equal(
    shouldCount(makeSession({ parentSession: 'parent-1' }), EVENT(2)),
    false,
  )
})

test('shouldCount: a missing turn does not count', () => {
  assert.equal(
    shouldCount(makeSession(), { type: 'compaction/end', data: {} }),
    false,
  )
  assert.equal(shouldCount(makeSession(), { type: 'compaction/end' }), false)
})

test('shouldCount: a failed compaction does not count', () => {
  // Real sample (2026-10-20, headless, transport failure):
  // compaction/start turn 1 -> compaction/end turn 1 with error.
  const failed = {
    type: 'compaction/end',
    time: 1700000000000,
    data: {
      compactionId: 'c1',
      turn: 1,
      error: 'DeepSeek Messages transport failed',
    },
  }
  assert.equal(shouldCount(makeSession(), failed), false)
})

test('shouldCount: compaction/start alone does not count', () => {
  assert.equal(
    shouldCount(makeSession(), {
      type: 'compaction/start',
      time: 1700000000000,
      data: { compactionId: 'c1', turn: 1 },
    }),
    false,
  )
})

test('shouldCount: other event types do not count', () => {
  assert.equal(shouldCount(makeSession(), EVENT(3, 'compaction/summary')), false)
  assert.equal(shouldCount(makeSession(), EVENT(3, 'turn/start')), false)
  assert.equal(shouldCount(makeSession(), null), false)
})

test('counts successful automatic compactions and persists count/timestamps', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installCount(ctx, { store, logger: ctx.logger })

  ctx.emit('session/event', makeSession({ id: 's-auto' }), EVENT(1))
  ctx.emit('session/event', makeSession({ id: 's-auto' }), {
    ...EVENT(2),
    time: 1700000001000,
  })

  const state = store.read('s-auto')
  assert.equal(state.count, 2)
  assert.equal(state.lastCompactionAt, new Date(1700000001000).toISOString())
  assert.match(state.updatedAt, ISO_REGEX)
  assert.equal(warnings.length, 0)
  assert.equal(fs.existsSync(store.fileFor('s-auto')), true)
})

test('a failed start/end pair followed by a successful one counts once', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installCount(ctx, { store, logger: ctx.logger })

  const session = makeSession({ id: 's-real' })
  ctx.emit('session/event', session, {
    type: 'compaction/start',
    time: 1700000000000,
    data: { compactionId: 'c-fail', turn: 1 },
  })
  ctx.emit('session/event', session, {
    type: 'compaction/end',
    time: 1700000000001,
    data: { compactionId: 'c-fail', turn: 1, error: 'transport failed' },
  })
  ctx.emit('session/event', session, {
    type: 'compaction/start',
    time: 1700000002000,
    data: { compactionId: 'c-ok', turn: 1 },
  })
  ctx.emit('session/event', session, {
    type: 'compaction/end',
    time: 1700000003000,
    data: { compactionId: 'c-ok', turn: 1 },
  })

  const state = store.read('s-real')
  assert.equal(state.count, 1)
  assert.equal(state.lastCompactionAt, new Date(1700000003000).toISOString())
})

test('manual, subagent, child, and missing-turn events write nothing', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installCount(ctx, { store, logger: ctx.logger })

  ctx.emit('session/event', makeSession({ id: 's-manual' }), EVENT(null))
  ctx.emit(
    'session/event',
    makeSession({ id: 's-subagent', origin: 'subagent' }),
    EVENT(1),
  )
  ctx.emit(
    'session/event',
    makeSession({ id: 's-child', parentSession: 'p-1' }),
    EVENT(1),
  )
  ctx.emit('session/event', makeSession({ id: 's-no-turn' }), {
    type: 'compaction/end',
    data: { compactionId: 'c1' },
  })

  for (const id of ['s-manual', 's-subagent', 's-child', 's-no-turn']) {
    assert.equal(fs.existsSync(store.fileFor(id)), false, id)
  }
  assert.equal(warnings.length, 0)
})

test('two sessions keep independent counts', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installCount(ctx, { store, logger: ctx.logger })

  ctx.emit('session/event', makeSession({ id: 'a' }), EVENT(1))
  ctx.emit('session/event', makeSession({ id: 'b' }), EVENT(1))
  ctx.emit('session/event', makeSession({ id: 'b' }), EVENT(2))

  assert.equal(store.read('a').count, 1)
  assert.equal(store.read('b').count, 2)
})

test('a write failure never throws out of the event feed and warns once', (t) => {
  const stateDir = tempStateDir(t)
  // Make the state directory path an existing file so every write attempt fails.
  const brokenDir = `${stateDir}-blocker`
  fs.writeFileSync(brokenDir, 'not a directory')
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir: brokenDir, logger: ctx.logger })
  installCount(ctx, { store, logger: ctx.logger })

  assert.doesNotThrow(() => {
    ctx.emit('session/event', makeSession({ id: 's1' }), EVENT(1))
    ctx.emit('session/event', makeSession({ id: 's1' }), EVENT(2))
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot write state/)
})
