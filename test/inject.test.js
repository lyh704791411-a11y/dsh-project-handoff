/**
 * Injection: once per turn, original messages preserved, bounded notice text.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  MAX_INJECTION_CHARS,
  buildInjectionText,
  buildNotice,
  cloneMessageWithText,
  installInject,
} from '../lib/inject.js'
import { createStateStore } from '../lib/state.js'
import { createFakeCtx, tempStateDir } from './helpers.js'

function baseMessage(overrides = {}) {
  return {
    id: 'original-id',
    role: 'user',
    content: [{ type: 'text', text: '继续' }],
    source: { kind: 'user' },
    meta: { keep: true },
    ...overrides,
  }
}

function preStepPayload(message, turn = 1) {
  return {
    agent: { id: 's1' },
    turn,
    step: 1,
    messages: [message],
    signal: new AbortController().signal,
  }
}

test('notice text is short for both a zero and a large count', () => {
  const zero = buildNotice(0)
  assert.match(zero, /尚未自动压缩/)
  assert.equal(buildNotice(7), 'project-handoff：本会话已自动压缩 7 次。')
  for (const count of [0, 1, 999999999]) {
    const text = buildInjectionText(buildNotice(count))
    assert.ok(text.length <= MAX_INJECTION_CHARS, `${count}: ${text.length}`)
  }
})

test('buildInjectionText truncates an over-long notice at the hard cap', () => {
  const text = buildInjectionText('x'.repeat(2000))
  assert.equal(text.length, MAX_INJECTION_CHARS)
  assert.equal(text.endsWith('…'), true)
})

test('cloneMessageWithText keeps role/source/extra fields, replaces text and id', () => {
  const base = baseMessage()
  const clone = cloneMessageWithText(base, 'replacement')

  assert.equal(clone.role, 'user')
  assert.deepEqual(clone.source, { kind: 'user' })
  assert.deepEqual(clone.meta, { keep: true })
  assert.notEqual(clone.id, base.id)
  assert.deepEqual(clone.content, [{ type: 'text', text: 'replacement' }])
  // The original is not mutated.
  assert.deepEqual(base.content, [{ type: 'text', text: '继续' }])
})

test('cloneMessageWithText drops goal provenance from a goal-round message', () => {
  const base = baseMessage({
    source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 },
  })
  const clone = cloneMessageWithText(base, 'notice')

  assert.deepEqual(clone.source, { kind: 'user' })
  assert.equal(clone.source.goalId, undefined)
  assert.equal(clone.source.round, undefined)
})

test('injects once per turn and preserves the original messages', async (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  store.write('s1', { count: 2 })
  installInject(ctx, { store, logger: ctx.logger })

  const base = baseMessage()
  const payload = preStepPayload(base)
  const fallback = { kind: 'enter', messages: [base] }

  const first = await ctx.waterfall('agent/pre-step', payload, fallback)
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 2)
  assert.deepEqual(first.messages[0], base)

  const notice = first.messages[1]
  assert.equal(notice.role, 'user')
  assert.deepEqual(notice.source, { kind: 'user' })
  assert.deepEqual(notice.meta, { keep: true })
  assert.notEqual(notice.id, base.id)
  assert.equal(notice.content.length, 1)
  assert.equal(notice.content[0].type, 'text')
  assert.match(notice.content[0].text, /已自动压缩 2 次/)
  assert.ok(notice.content[0].text.length <= MAX_INJECTION_CHARS)

  const state = store.read('s1')
  assert.equal(state.lastInjectedTurn, 1)
  assert.equal(
    state.lastInjectedNotice,
    'project-handoff：本会话已自动压缩 2 次。',
  )
  assert.equal(state.lastInjectedText, notice.content[0].text)

  // Same turn, second step: no second notice.
  const second = await ctx.waterfall('agent/pre-step', payload, fallback)
  assert.equal(second.messages.length, 1)

  // New turn without a new compaction: the notice is not repeated.
  const third = await ctx.waterfall(
    'agent/pre-step',
    preStepPayload(base, 2),
    fallback,
  )
  assert.equal(third.messages.length, 1)
  assert.equal(store.read('s1').lastInjectedTurn, 1)

  // Another compaction happened: the next turn speaks once, with the new count.
  store.write('s1', { ...store.read('s1'), count: 3 })
  const fourth = await ctx.waterfall(
    'agent/pre-step',
    preStepPayload(base, 3),
    fallback,
  )
  assert.equal(fourth.messages.length, 2)
  assert.match(fourth.messages[1].content[0].text, /已自动压缩 3 次/)
  assert.equal(store.read('s1').lastInjectedTurn, 3)
  assert.equal(store.read('s1').lastInjectedCount, 3)
  assert.equal(warnings.length, 0)
})

test('a session without compactions stays silent', async (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installInject(ctx, { store, logger: ctx.logger })

  const base = baseMessage()
  const result = await ctx.waterfall(
    'agent/pre-step',
    preStepPayload(base),
    { kind: 'enter', messages: [base] },
  )
  assert.equal(result.messages.length, 1)
  assert.equal(fs.existsSync(store.fileFor('s1')), false)
})

test('skips when there are no messages', async (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installInject(ctx, { store, logger: ctx.logger })

  const result = await ctx.waterfall(
    'agent/pre-step',
    { agent: { id: 's1' }, turn: 1, step: 1, messages: [] },
    { kind: 'enter', messages: [] },
  )
  assert.deepEqual(result, { kind: 'enter', messages: [] })
  assert.equal(fs.existsSync(store.fileFor('s1')), false)
})

test('returns a reject decision untouched', async (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installInject(ctx, { store, logger: ctx.logger })

  const base = baseMessage()
  const result = await ctx.waterfall(
    'agent/pre-step',
    preStepPayload(base),
    { kind: 'reject' },
  )
  assert.deepEqual(result, { kind: 'reject' })
  assert.equal(fs.existsSync(store.fileFor('s1')), false)
})

test('appends to messages a later listener already replaced', async (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  store.write('s1', { count: 1 })
  installInject(ctx, { store, logger: ctx.logger })

  const base = baseMessage()
  const extra = baseMessage({ id: 'runtime-context', source: { kind: 'runtime-context' } })
  const result = await ctx.waterfall(
    'agent/pre-step',
    preStepPayload(base),
    { kind: 'enter', messages: [base, extra] },
  )
  assert.equal(result.messages.length, 3)
  assert.deepEqual(result.messages[1], extra)
})
