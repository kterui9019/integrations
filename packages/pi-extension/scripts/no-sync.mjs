/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline lifecycle test for `--no-sync`: drives session_start / agent_end /
 * /merge / session_shutdown against a stubbed Daytona SDK and a stubbed `gh`,
 * and asserts nothing is written to GitHub. A sync-enabled control run proves
 * the harness does observe branch creation and pushes. No API key or network.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url, {
  alias: { '@daytona/sdk': path.join(__dirname, 'stub-daytona-sdk.mjs') },
})

process.env.DAYTONA_API_KEY = 'dtn_test'
const mod = await jiti.import(path.join(root, 'index.ts'))
const factory = mod.default ?? mod

const SESSION_ID = 'abcdef12-0000-0000-0000-000000000000'

/** Answer the host `git` / `gh` calls the extension makes. */
function execReply(cmd, args) {
  const a = args.join(' ')
  if (cmd === 'git' && a.includes('remote get-url')) return 'git@github.com:acme/api.git'
  if (cmd === 'git' && a.includes('rev-parse')) return 'feature'
  if (cmd === 'gh' && a === 'auth token') return 'gho_test'
  if (cmd === 'gh' && a.includes('.default_branch')) return 'main'
  if (cmd === 'gh' && a.includes('.object.sha')) return 'abc123'
  if (cmd === 'gh' && a.includes('.ahead_by')) return '0'
  return ''
}

/** Load a fresh extension instance and return drivers plus recorded side effects. */
async function load({ flags, persisted, entries = [] }) {
  globalThis.__daytonaCalls = []
  const handlers = {}
  const commands = {}
  const ghCalls = []
  const pi = {
    registerFlag() {},
    registerTool() {},
    registerCommand: (name, spec) => (commands[name] = spec.handler),
    on: (event, fn) => (handlers[event] = fn),
    getFlag: (name) => flags[name],
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    exec: async (cmd, args) => {
      if (cmd === 'gh') ghCalls.push(args)
      return { code: 0, stdout: execReply(cmd, args), stderr: '' }
    },
  }
  await factory(pi)
  const ctx = {
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_c, t) => t },
      confirm: async () => true,
    },
    sessionManager: {
      getSessionFile: () => (persisted ? '/tmp/pi-no-sync-test.jsonl' : undefined),
      getSessionId: () => SESSION_ID,
      getCwd: () => root,
      getEntries: () => entries,
    },
  }
  const sdk = (kind) => globalThis.__daytonaCalls.filter((c) => c[0] === kind)
  return {
    start: (reason) => handlers.session_start({ reason }, ctx),
    agentEnd: () => handlers.agent_end({}, ctx),
    merge: () => commands.merge('', ctx),
    shutdown: () => handlers.session_shutdown({ reason: 'quit' }, ctx),
    prompt: () => handlers.before_agent_start({ systemPrompt: 'Current working directory: /local' }, ctx),
    ghWrites: () => ghCalls.filter((args) => args.includes('--method')),
    pushes: () => sdk('git.push'),
    clones: () => sdk('git.clone').map((c) => c[1]),
    sdk,
  }
}

// Control: sync enabled creates the session branch and pushes.
{
  const t = await load({ flags: { daytona: true }, persisted: false })
  await t.start('startup')
  assert.equal(t.ghWrites().length, 1, 'control: ensureBranch should POST the session branch')
  assert.match(t.clones()[0].branch, /^pi\//)
  await t.agentEnd()
  assert.equal(t.pushes().length, 1, 'control: agent_end should push')
  console.log('✓ control: sync creates the branch and pushes')
}

// --no-sync, new session: clones the base branch with the token, never writes to GitHub.
{
  const t = await load({ flags: { daytona: true, 'no-sync': true }, persisted: false })
  await t.start('startup')
  assert.equal(t.sdk('create').length, 1)
  assert.deepEqual(t.clones(), [
    {
      url: 'https://github.com/acme/api.git',
      path: '/home/daytona/api',
      branch: 'feature',
      username: 'x-access-token',
      token: 'gho_test',
    },
  ])
  assert.ok(t.prompt(), 'sandbox should be active')
  await t.agentEnd()
  await t.merge()
  await t.shutdown()
  assert.deepEqual(t.ghWrites(), [], 'no GitHub writes')
  assert.deepEqual(t.pushes(), [], 'no pushes')
  assert.equal(t.sdk('delete').length, 1, 'in-memory sandbox is deleted on quit')
  console.log('✓ --no-sync new session: clones base branch, no GitHub writes, no push')
}

// --no-sync, resuming a session that recorded a GitHub target: reattaches, never writes.
{
  const entries = [
    {
      type: 'custom',
      customType: 'daytona-session',
      data: {
        sandboxId: 'sb-prev',
        cwd: '/home/daytona/api',
        git: { slug: { owner: 'acme', repo: 'api' }, base: 'main', branch: 'pi/abcdef12' },
      },
    },
  ]
  const t = await load({ flags: { daytona: true, 'no-sync': true }, persisted: true, entries })
  await t.start('resume')
  assert.deepEqual(
    t.sdk('get').map((c) => c[1]),
    ['sb-prev'],
  )
  assert.equal(t.sdk('create').length, 0, 'reattach must not create a sandbox')
  assert.deepEqual(t.clones(), [])
  assert.ok(t.prompt(), 'sandbox should be active')
  await t.agentEnd()
  await t.merge()
  await t.shutdown()
  assert.deepEqual(t.ghWrites(), [], 'no GitHub writes')
  assert.deepEqual(t.pushes(), [], 'no pushes')
  assert.equal(t.sdk('delete').length, 0, 'persisted sandbox is kept')
  console.log('✓ --no-sync resume: reattaches, no GitHub writes, no push')
}

console.log('\n--no-sync lifecycle test passed.')
