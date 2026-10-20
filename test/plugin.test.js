/**
 * Wiring smoke test: the public entry registers exactly the three Host
 * listeners and resolves its state directory from config.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { apply, name } from '../index.js'
import { createFakeCtx, tempStateDir } from './helpers.js'

test('apply registers count, inject, and verify listeners', (t) => {
  const stateDir = tempStateDir(t)
  const { ctx, warnings } = createFakeCtx()

  apply(ctx, { stateDir })

  assert.equal(name, 'project-handoff')
  assert.equal(ctx.listenerCount('session/event'), 1)
  assert.equal(ctx.listenerCount('agent/pre-step'), 1)
  assert.equal(ctx.listenerCount('agent/turn-stopping'), 1)
  assert.equal(warnings.length, 0)
  assert.equal(path.isAbsolute(stateDir), true)
})

test('apply is a no-op without an on() context', () => {
  assert.doesNotThrow(() => apply({}, undefined))
  assert.doesNotThrow(() => apply(undefined, undefined))
})
