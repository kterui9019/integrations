/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline test for `--secrets`: drives session_start against the stubbed
 * Daytona SDK and asserts the parsed env-var → Secret-name map reaches
 * `Daytona.create`, and that a malformed value fails the start without
 * creating a sandbox. No API key or network.
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

/** Run session_start with `flags` and return the create() params and notifications. */
async function start(flags) {
  globalThis.__daytonaCalls = []
  const handlers = {}
  const notes = []
  const pi = {
    registerFlag() {},
    registerTool() {},
    registerCommand() {},
    on: (event, fn) => (handlers[event] = fn),
    getFlag: (name) => ({ daytona: true, 'no-sync': true, ...flags })[name],
    appendEntry() {},
    // Not in a git repo: no clone, no GitHub.
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
  }
  await factory(pi)
  const ctx = {
    hasUI: false,
    ui: { notify: (msg, level) => notes.push({ msg, level }), setStatus() {}, theme: { fg: (_c, t) => t } },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => 'abcdef12-0000-0000-0000-000000000000',
      getCwd: () => root,
      getEntries: () => [],
    },
  }
  await handlers.session_start({ reason: 'startup' }, ctx)
  const creates = globalThis.__daytonaCalls.filter((c) => c[0] === 'create').map((c) => c[1])
  return { creates, notes }
}

{
  const { creates } = await start({ secrets: ' ANTHROPIC_API_KEY = anthropic ,GITHUB_TOKEN=gh-bot,' })
  assert.equal(creates.length, 1)
  assert.deepEqual(creates[0].secrets, { ANTHROPIC_API_KEY: 'anthropic', GITHUB_TOKEN: 'gh-bot' })
  console.log('✓ --secrets map is passed to Daytona.create')
}

{
  const { creates } = await start({})
  assert.equal(creates[0].secrets, undefined)
  console.log('✓ no --secrets: create gets no secrets')
}

for (const bad of ['ANTHROPIC_API_KEY', 'A=b=c', '=anthropic', 'A=']) {
  const { creates, notes } = await start({ secrets: bad })
  assert.equal(creates.length, 0, `"${bad}" must not create a sandbox`)
  assert.ok(
    notes.some((n) => n.level === 'error' && n.msg.includes('--secrets')),
    `"${bad}" should report an error`,
  )
}
console.log('✓ malformed --secrets fails the start without creating a sandbox')
