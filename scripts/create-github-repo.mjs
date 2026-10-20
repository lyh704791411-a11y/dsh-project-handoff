#!/usr/bin/env node
/**
 * Create the GitHub repository for this plugin using the credential Git
 * Credential Manager already stored, then report (never print) the token.
 *
 * Usage: node scripts/create-github-repo.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')
const OWNER_HINT = 'mini-yifan'
const REPO = 'dsh-project-handoff'
const DESCRIPTION =
  'DSH host plugin: counts automatic context compactions and injects one short project-handoff notice per turn.'

function readCredential() {
  const input = 'protocol=https\nhost=github.com\n\n'
  let out
  try {
    out = execFileSync('git', ['credential', 'fill'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 20000,
    })
  } catch (error) {
    console.error('credential-fill-failed:', error.message.split('\n')[0])
    process.exit(2)
  }
  const map = new Map()
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1))
  }
  return { username: map.get('username') ?? '', password: map.get('password') ?? '' }
}

const { username, password } = readCredential()
console.log(`credential: username=${username || '(none)'} token=${password ? `len ${password.length}` : '(none)'}`)
if (!password) process.exit(2)

const headers = {
  Authorization: `Bearer ${password}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-project-handoff-publish',
}

const me = await fetch('https://api.github.com/user', { headers })
if (!me.ok) {
  console.error(`api /user: HTTP ${me.status}`)
  process.exit(3)
}
const meJson = await me.json()
console.log(`api /user: HTTP 200 login=${meJson.login}`)

const existing = await fetch(`https://api.github.com/repos/${meJson.login}/${REPO}`, { headers })
console.log(`repo exists check: HTTP ${existing.status}`)
if (existing.ok) {
  console.log('repo: already exists, nothing to create')
  process.exit(0)
}

if (dryRun) {
  console.log('dry-run: would create', `${meJson.login}/${REPO}`, 'public with issues enabled')
  process.exit(0)
}

const created = await fetch('https://api.github.com/user/repos', {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: REPO,
    description: DESCRIPTION,
    homepage: `https://github.com/${meJson.login}/${REPO}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  }),
})
console.log(`create repo: HTTP ${created.status}`)
if (!created.ok) {
  const body = await created.text()
  console.error('create failed:', body.slice(0, 400))
  process.exit(4)
}
const repo = await created.json()
console.log(`created: ${repo.full_name} (${repo.private ? 'private' : 'public'}) issues=${repo.has_issues}`)
console.log(`url: ${repo.html_url}`)
