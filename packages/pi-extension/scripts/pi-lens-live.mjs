/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live test for the pi-lens bridge against a real Daytona sandbox: install
 * pi-lens (4 GiB — the default 1 GiB is OOM-killed), then drive the bridge's
 * Pi hooks the way Pi does: first prompt, write with a type error, turn end,
 * a bridged tool call, shutdown.
 *
 * Requires DAYTONA_API_KEY. Run: node scripts/pi-lens-live.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url)
const { Daytona } = await import('@daytona/sdk')
const { registerPiLens } = await jiti.import(path.join(root, 'src/pi-lens.ts'))

const PI_LENS = process.env.PI_LENS_VERSION ?? '4.3.0'
const timed = async (label, fn) => {
  const t = Date.now()
  const value = await fn()
  console.log(`  [${label}] ${Date.now() - t} ms`)
  return value
}

const daytona = new Daytona()
const sandbox = await daytona.create(
  { image: 'node:24', resources: { cpu: 2, memory: 4 }, labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 },
  { timeout: 600 },
)
const watchdog = setTimeout(async () => {
  console.error('FAIL: watchdog (a step hung)')
  await sandbox.delete().catch(() => undefined)
  process.exit(1)
}, 600_000)
const handlers = new Map()
try {
  const cwd = `${(await sandbox.getUserHomeDir()) ?? '/root'}/proj`
  const install = await timed('install pi-lens', () =>
    sandbox.process.executeCommand(
      `npm i -g pi-lens@${PI_LENS} @earendil-works/pi-tui@^0.85.0 @earendil-works/pi-coding-agent typebox 2>&1 | tail -n 3 && ` +
        `mkdir -p ${cwd}/src && cd ${cwd} && git init -q && echo '{"private":true,"type":"module"}' > package.json && npm i -D typescript 2>&1 | tail -n 1`,
      undefined,
      undefined,
      600,
    ),
  )
  assert.equal(install.exitCode, 0, install.result)
  await sandbox.fs.uploadFile(Buffer.from('{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler","noEmit":true},"include":["src"]}'), `${cwd}/tsconfig.json`)

  const tools = new Map()
  const messages = []
  const notices = []
  const pi = {
    registerTool: (t) => tools.set(t.name, t),
    on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    sendMessage: (message, options) => messages.push({ message, options }),
  }
  const active = () => ({ sandbox, cwd })
  registerPiLens(pi, active, active)
  const ctx = { ui: { notify: (text, level) => notices.push({ text, level }) } }
  const emit = async (e, event = {}) => {
    let result
    for (const fn of handlers.get(e) ?? []) result = (await fn(event, ctx)) ?? result
    return result
  }

  await timed('first prompt (spawn + initialize + session start)', () => emit('before_agent_start'))
  assert.deepEqual(notices, [])
  assert.ok(tools.has('pilens_lsp_navigation') && tools.has('pilens_analyze'), [...tools.keys()].join(', '))
  assert.ok(!tools.has('pilens_session_start') && !tools.has('pilens_turn_end'))
  console.log(`✓ pi-lens tools registered (${tools.size}): ${[...tools.keys()].join(', ')}`)

  await sandbox.fs.uploadFile(Buffer.from("export const n: number = 'oops'\n"), `${cwd}/src/main.ts`)
  const written = await timed('write → pilens_analyze', () =>
    emit('tool_result', { toolName: 'write', input: { path: 'src/main.ts' }, content: [{ type: 'text', text: 'Wrote src/main.ts' }], isError: false }),
  )
  assert.deepEqual(notices, [])
  const report = written?.content?.[1]?.text ?? ''
  console.log(report.replace(/^/gm, '    '))
  assert.match(report, /ts:2322/)
  console.log('✓ a write with a type error gets the TS2322 finding appended')

  await sandbox.fs.uploadFile(Buffer.from('export const n: number = 1\n'), `${cwd}/src/main.ts`)
  const clean = await timed('edit → pilens_analyze (clean)', () =>
    emit('tool_result', { toolName: 'edit', input: { path: 'src/main.ts' }, content: [{ type: 'text', text: 'Edited src/main.ts' }], isError: false }),
  )
  assert.equal(clean, undefined)
  console.log('✓ a clean edit is left alone')

  await timed('turn_end → pilens_turn_end', () => emit('turn_end'))
  assert.deepEqual(notices, [])
  for (const { message } of messages) console.log(message.content.replace(/^/gm, '    '))
  console.log(`✓ turn-end ran (${messages.length} advisory message(s))`)

  const outline = await timed('pilens_module_report', () => tools.get('pilens_module_report').execute('id', { file: 'src/main.ts' }, undefined))
  assert.match(outline.content[0].text, /main\.ts/)
  console.log('✓ a bridged tool call returns the server result')

  await emit('session_shutdown')
  const left = await sandbox.process.listPtySessions()
  assert.deepEqual(left.filter((s) => s.id.startsWith('pi-lens-') && s.active), [])
  console.log('✓ session_shutdown stops the server')
  console.log('\npi-lens live test passed.')
} catch (err) {
  console.error('FAIL:', err)
  const log = await sandbox.process.executeCommand('tail -n 30 /tmp/pi-lens-mcp.log').catch(() => undefined)
  if (log?.result) console.error(`--- pi-lens-mcp log ---\n${log.result}`)
  process.exitCode = 1
} finally {
  await Promise.allSettled((handlers.get('session_shutdown') ?? []).map((fn) => fn({}, {})))
  clearTimeout(watchdog)
  await sandbox.delete().catch(() => undefined)
}
