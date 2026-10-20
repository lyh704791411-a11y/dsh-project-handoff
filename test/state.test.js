/**
 * State store: per-session filename safety, atomic writes, corrupt fallback.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createStateStore,
  emptyState,
  normalizeState,
  safeSessionFileName,
} from '../lib/state.js'
import { DEFAULT_STATE_DIR, resolveConfig } from '../lib/util.js'
import { createFakeCtx, tempStateDir } from './helpers.js'

test('default stateDir is under the real home but no test writes there', () => {
  assert.equal(
    DEFAULT_STATE_DIR,
    path.join(os.homedir(), '.dsh', 'state', 'project-handoff'),
  )
  const settings = resolveConfig({})
  assert.equal(settings.stateDir, path.resolve(DEFAULT_STATE_DIR))
  assert.equal(settings.steer, false)
  assert.equal(resolveConfig({ steer: true }).steer, true)
})

test('safeSessionFileName strips separators and traversal', () => {
  const name = safeSessionFileName('../../session/one two')
  assert.equal(name.includes('/'), false)
  assert.equal(name.includes('\\'), false)
  assert.equal(name.startsWith('.'), false)
  assert.match(name, /\.json$/)
  assert.notEqual(safeSessionFileName(''), safeSessionFileName('.'))
})

test('write then read round-trips the documented fields', (t) => {
  const stateDir = tempStateDir(t)
  const { logger } = createFakeCtx()
  const store = createStateStore({ stateDir, logger })

  const wrote = store.write('session-1', {
    count: 4,
    lastCompactionAt: '2026-10-20T01:00:00.000Z',
    updatedAt: '2026-10-20T01:00:01.000Z',
    lastInjectedTurn: 9,
    lastInjectedNotice: 'notice',
  })
  assert.equal(wrote, true)

  const state = store.read('session-1')
  assert.equal(state.count, 4)
  assert.equal(state.lastCompactionAt, '2026-10-20T01:00:00.000Z')
  assert.equal(state.updatedAt, '2026-10-20T01:00:01.000Z')
  assert.equal(state.lastInjectedTurn, 9)
  assert.equal(state.lastInjectedNotice, 'notice')
  assert.equal(state.lastVerify, null)
  assert.equal(state.steeredTurn, null)
})

test('write is atomic: no .tmp sibling remains', (t) => {
  const stateDir = tempStateDir(t)
  const { logger } = createFakeCtx()
  const store = createStateStore({ stateDir, logger })
  store.write('s1', { count: 1 })

  const files = fs.readdirSync(stateDir)
  assert.equal(files.length, 1)
  assert.equal(files[0].endsWith('.tmp'), false)
  assert.equal(files[0].endsWith('.json'), true)
})

test('a missing file reads as empty without a warning', (t) => {
  const stateDir = tempStateDir(t)
  const { logger, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger })

  assert.deepEqual(store.read('missing'), emptyState())
  assert.equal(warnings.length, 0)
  assert.equal(fs.existsSync(stateDir), false)
})

test('corrupt JSON falls back to empty and warns once', (t) => {
  const stateDir = tempStateDir(t)
  const { logger, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir, logger })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(store.fileFor('broken'), '{ not json', 'utf8')

  assert.deepEqual(store.read('broken'), emptyState())
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot read state/)

  // A second read of the same broken file is de-duplicated.
  assert.deepEqual(store.read('broken'), emptyState())
  assert.equal(warnings.length, 1)
})

test('a non-object JSON value falls back to empty without throwing', (t) => {
  const stateDir = tempStateDir(t)
  const { logger } = createFakeCtx()
  const store = createStateStore({ stateDir, logger })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(store.fileFor('array'), '[]', 'utf8')
  assert.deepEqual(store.read('array'), emptyState())
})

test('normalizeState repairs out-of-range fields', () => {
  const state = normalizeState({
    count: -3,
    lastInjectedTurn: 'nope',
    steeredTurn: 2.5,
    lastVerify: [],
  })
  assert.equal(state.count, 0)
  assert.equal(state.lastInjectedTurn, null)
  assert.equal(state.steeredTurn, null)
  assert.equal(state.lastVerify, null)
})

test('write failure returns false, warns once, and never throws', (t) => {
  const stateDir = tempStateDir(t)
  const blocker = `${stateDir}-blocker`
  fs.mkdirSync(path.dirname(blocker), { recursive: true })
  fs.writeFileSync(blocker, 'not a directory')
  const { logger, warnings } = createFakeCtx()
  const store = createStateStore({ stateDir: blocker, logger })

  assert.equal(store.write('s1', { count: 1 }), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot write state/)

  assert.equal(store.write('s1', { count: 2 }), false)
  assert.equal(warnings.length, 1)
})

test('session ids that sanitize to the same prefix get distinct files', (t) => {
  const stateDir = tempStateDir(t)
  const { logger } = createFakeCtx()
  const store = createStateStore({ stateDir, logger })
  const first = store.fileFor('a/b')
  const second = store.fileFor('a_b')
  assert.notEqual(first, second)
  assert.equal(path.dirname(first), path.resolve(stateDir))
})
