/**
 * Verification: first body paragraph extraction, lastVerify state, steer gate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  buildInjectionText,
  buildNotice,
} from '../lib/inject.js'
import { createStateStore } from '../lib/state.js'
import {
  firstParagraph,
  installVerify,
  lastUserMessage,
  noticeMatches,
} from '../lib/verify.js'
import { createFakeCtx, tempStateDir } from './helpers.js'

function user(text, overrides = {}) {
  return {
    id: `user-${text}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    ...overrides,
  }
}

function assistant(text) {
  return {
    id: `assistant-${text}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  }
}

function makeAgent(messages, steered, { withDerive = true } = {}) {
  const session = withDerive
    ? { id: 's1', deriveMessages: () => messages }
    : { id: 's1' }
  return {
    id: 's1',
    session,
    steer(message) {
      steered.push(message)
    },
  }
}

function seedNotice(store, overrides = {}) {
  const notice = buildNotice(3)
  store.write('s1', {
    count: 3,
    lastInjectedTurn: 1,
    lastInjectedNotice: notice,
    lastInjectedText: buildInjectionText(notice),
    ...overrides,
  })
  return notice
}

test('firstParagraph: normal paragraph stops at a blank line', () => {
  assert.equal(firstParagraph('第一段\n续行\n\n第二段'), '第一段\n续行')
  assert.equal(firstParagraph('\n\n第一段\n\n第二段'), '第一段')
})

test('firstParagraph: skips a leading blockquote', () => {
  assert.equal(firstParagraph('> 引用\n> 继续引用\n\n正文\n续行'), '正文\n续行')
  assert.equal(firstParagraph('> 只有引用'), '')
})

test('firstParagraph: skips a leading fenced code block', () => {
  assert.equal(firstParagraph('```js\nconst x = 1\n```\n\n正文'), '正文')
  assert.equal(firstParagraph('~~~\ncode\n~~~\n正文'), '正文')
  assert.equal(firstParagraph('```\n只有代码\n```'), '')
})

test('firstParagraph: empty and whitespace-only input', () => {
  assert.equal(firstParagraph(''), '')
  assert.equal(firstParagraph('\n \n\t\n'), '')
  assert.equal(firstParagraph(null), '')
})

test('noticeMatches requires the notice text, not just any paragraph', () => {
  const notice = buildNotice(3)
  assert.equal(noticeMatches(notice, notice), true)
  assert.equal(noticeMatches(`说明：${notice}后面还有话`, notice), true)
  assert.equal(noticeMatches('好的，已经完成。', notice), false)
  assert.equal(noticeMatches('', notice), false)
})

test('lastUserMessage ignores the runtime-context message', () => {
  const real = user('真实输入')
  const context = user('runtime', { source: { kind: 'runtime-context' } })
  assert.deepEqual(lastUserMessage([real, context]), real)
  assert.equal(lastUserMessage([context]), null)
})

test('matching first paragraph records lastVerify without steering', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  const notice = seedNotice(store)
  installVerify(ctx, { store, steer: false, logger: ctx.logger })

  const steered = []
  const messages = [user('继续'), assistant(`${notice}\n\n后续说明`)]
  ctx.emit('agent/turn-stopping', {
    agent: makeAgent(messages, steered),
    turn: 1,
  })

  const state = store.read('s1')
  assert.equal(state.lastVerify.match, true)
  assert.equal(state.lastVerify.expected, notice)
  assert.equal(state.lastVerify.actual, notice)
  assert.equal(state.lastVerify.turn, 1)
  assert.equal(state.lastVerify.steered, false)
  assert.equal(steered.length, 0)
  assert.equal(warnings.length, 0)
})

test('a mismatch with steer:false records the result and does not steer', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  seedNotice(store)
  installVerify(ctx, { store, steer: false, logger: ctx.logger })

  const steered = []
  ctx.emit('agent/turn-stopping', {
    agent: makeAgent([user('继续'), assistant('好的，已完成。')], steered),
    turn: 1,
  })

  const state = store.read('s1')
  assert.equal(state.lastVerify.match, false)
  assert.equal(state.lastVerify.steered, false)
  assert.equal(state.steeredTurn, null)
  assert.equal(steered.length, 0)
})

test('steer:true steers a clone once per turn', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  const notice = seedNotice(store)
  installVerify(ctx, { store, steer: true, logger: ctx.logger })

  const steered = []
  const messages = [user('继续'), assistant('好的，已完成。')]
  const agent = makeAgent(messages, steered)

  ctx.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(steered.length, 1)
  assert.equal(steered[0].role, 'user')
  assert.match(steered[0].content[0].text, /已自动压缩 3 次/)
  assert.equal(store.read('s1').steeredTurn, 1)
  assert.equal(store.read('s1').lastVerify.steered, true)

  // Same turn fires again (possible after a steer adds another step): no second steer.
  ctx.emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(steered.length, 1)

  // A later turn may steer once again.
  ctx.emit('agent/turn-stopping', { agent, turn: 2 })
  assert.equal(steered.length, 2)
  assert.equal(store.read('s1').steeredTurn, 2)
  assert.equal(warnings.length, 0)
})

test('steer clones the last real user message, not runtime context', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  seedNotice(store)
  installVerify(ctx, { store, steer: true, logger: ctx.logger })

  const real = user('真实输入')
  const context = user('runtime context', {
    source: { kind: 'runtime-context' },
  })
  const steered = []
  ctx.emit('agent/turn-stopping', {
    agent: makeAgent([real, context, assistant('不对')], steered),
    turn: 1,
  })

  assert.equal(steered.length, 1)
  assert.deepEqual(steered[0].source, { kind: 'user' })
  assert.notEqual(steered[0].id, real.id)
  assert.match(steered[0].content[0].text, /已自动压缩 3 次/)
})

test('a quote/code-only answer counts as a mismatch and can steer', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  seedNotice(store)
  installVerify(ctx, { store, steer: true, logger: ctx.logger })

  const steered = []
  const answer = '> 引用\n\n```\ncode only\n```'
  ctx.emit('agent/turn-stopping', {
    agent: makeAgent([user('继续'), assistant(answer)], steered),
    turn: 1,
  })

  assert.equal(store.read('s1').lastVerify.actual, '')
  assert.equal(store.read('s1').lastVerify.match, false)
  assert.equal(steered.length, 1)
})

test('skips safely when agent/session/deriveMessages is unavailable', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  seedNotice(store)
  installVerify(ctx, { store, steer: true, logger: ctx.logger })

  assert.doesNotThrow(() => {
    ctx.emit('agent/turn-stopping', { agent: { id: 's1' }, turn: 1 })
  })
  assert.equal(store.read('s1').lastVerify, null)
  assert.equal(warnings.length, 0)
})

test('skips when no notice has ever been injected', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx } = createFakeCtx()
  const store = createStateStore({ stateDir, logger: ctx.logger })
  installVerify(ctx, { store, steer: true, logger: ctx.logger })

  const steered = []
  ctx.emit('agent/turn-stopping', {
    agent: makeAgent([user('继续'), assistant('好的')], steered),
    turn: 1,
  })
  assert.equal(fs.existsSync(store.fileFor('s1')), false)
  assert.equal(steered.length, 0)
})
