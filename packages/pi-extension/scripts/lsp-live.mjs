/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live test for the `lsp` tool against a real Daytona sandbox, driven through
 * the registered Pi tools: navigation, diagnostics that follow edits made with
 * edit/write/bash, rename, Python, sandbox stop, a killed server, Pi resume
 * (orphan cleanup), shutdown cleanup, concurrent calls and error messages.
 *
 * Requires DAYTONA_API_KEY.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url)
const { Daytona } = await import('@daytona/sdk')
const { registerTools } = await jiti.import(path.join(root, 'src/tools.ts'))

/** A fresh extension instance (one Pi process) bound to `active`. */
async function pi(active, { daytona = true } = {}) {
  const tools = new Map()
  const handlers = new Map()
  const api = {
    registerTool: (t) => tools.set(t.name, t),
    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    getFlag: (name) => (name === 'daytona' ? daytona : undefined),
  }
  registerTools(api, () => active)
  const emit = async (event) => {
    for (const fn of handlers.get(event) ?? []) await fn({}, {})
  }
  await emit('session_start')
  const call = async (name, params) => {
    // What Pi passes: its own (host) cwd plus the session manager.
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'session-id', getSessionFile: () => undefined } }
    const res = await tools.get(name).execute('id', params, undefined, () => {}, ctx)
    return res.content.map((c) => c.text).join('\n')
  }
  return { tools, emit, call, lsp: (params) => call('lsp', params) }
}

const daytona = new Daytona()
const sandbox = await daytona.create({ labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 })
const watchdog = setTimeout(async () => {
  console.error('FAIL: watchdog')
  await sandbox.delete().catch(() => undefined)
  process.exit(1)
}, 480_000)
const lspSessions = async () => (await sandbox.process.listPtySessions()).filter((s) => s.id.startsWith('pi-lsp-')).map((s) => s.id)

let exitCode = 0
try {
  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona'
  const cwd = `${home}/proj`
  await sandbox.process.executeCommand(`mkdir -p ${cwd}`)
  const active = { sandbox, cwd }

  assert.ok(!(await pi(active, { daytona: false })).tools.has('lsp'))
  const a = await pi(active)
  assert.ok(a.tools.has('lsp'))
  console.log('✓ lsp is registered only in --daytona sessions')

  await a.call('bash', {
    command: [
      'mkdir -p src node_modules/sandbox-only-dep',
      `echo '{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}' > tsconfig.json`,
      `echo '{"name":"sandbox-only-dep","types":"index.d.ts"}' > node_modules/sandbox-only-dep/package.json`,
      `echo 'export declare function sandboxOnly(n: number): string' > node_modules/sandbox-only-dep/index.d.ts`,
      `printf 'export class UserRepository {\\n  findUser(id: string): string {\\n    return id\\n  }\\n}\\n' > src/user.ts`,
      `printf "import { UserRepository } from './user'\\nimport { sandboxOnly } from 'sandbox-only-dep'\\nconst repo = new UserRepository()\\nrepo.findUser(sandboxOnly(1))\\nconst n: number = 'oops'\\nexport { n }\\n" > src/main.ts`,
    ].join(' && '),
  })

  assert.match(await a.lsp({ action: 'status' }), /typescript .*not started/)
  assert.deepEqual(await lspSessions(), [])
  console.log('✓ nothing is spawned until the first query')

  assert.equal(
    await a.lsp({ action: 'definition', path: 'src/main.ts', line: 3, symbol: 'UserRepository' }),
    'src/user.ts:1:14  export class UserRepository {',
  )
  const refs = await a.lsp({ action: 'references', path: 'src/user.ts', line: 2, symbol: 'findUser' })
  assert.deepEqual(refs.split('\n').map((l) => l.split('  ')[0]).sort(), ['src/main.ts:4:6', 'src/user.ts:2:3'])
  assert.match(await a.lsp({ action: 'hover', path: 'src/main.ts', line: 3, symbol: 'repo' }), /const repo: UserRepository/)
  assert.match(await a.lsp({ action: 'hover', path: 'src/main.ts', line: 4, symbol: 'sandboxOnly' }), /sandboxOnly\(n: number\): string/)
  console.log('✓ definition / references / hover (incl. a package that exists only in the sandbox node_modules)')

  assert.match(await a.lsp({ action: 'diagnostics', path: 'src/main.ts' }), /^src\/main\.ts:5:7 error TS2322: Type 'string' is not assignable to type 'number'\./)
  console.log('✓ diagnostics')

  await a.call('edit', {
    path: 'src/user.ts',
    edits: [
      { oldText: 'export class UserRepository {', newText: 'export const VERSION = 1\nexport class UserRepository {' },
      { oldText: 'findUser(id', newText: 'getUser(id' },
    ],
  })
  const afterEdit = await a.lsp({ action: 'diagnostics', path: 'src/main.ts' })
  assert.match(afterEdit, /TS2339: Property 'findUser' does not exist/)
  assert.match(await a.lsp({ action: 'definition', path: 'src/main.ts', line: 3, symbol: 'UserRepository' }), /^src\/user\.ts:2:14/)
  console.log('✓ an edit-tool change to user.ts is reflected at once, including cross-file diagnostics in main.ts')

  await a.call('bash', { command: `sed -i "s/repo.findUser/repo.getUser/; s/: number = 'oops'/: number = 1/" src/main.ts` })
  assert.equal(await a.lsp({ action: 'diagnostics', path: 'src/main.ts' }), 'src/main.ts: no diagnostics')
  console.log('✓ a bash (sed) change to an open file is picked up on the next call')

  assert.equal(await a.lsp({ action: 'document_symbols', path: 'src/user.ts' }), 'constant VERSION :1\nclass UserRepository :2\n  method getUser :3')
  assert.match(await a.lsp({ action: 'workspace_symbols', query: 'UserRepo' }), /^class UserRepository — src\/user\.ts:2:1$/m)
  console.log('✓ document_symbols (tree) / workspace_symbols')

  assert.equal(
    await a.lsp({ action: 'rename', path: 'src/user.ts', line: 3, symbol: 'getUser', new_name: 'fetchUser' }),
    'Renamed to fetchUser: 2 edit(s) in 2 file(s)\n  src/user.ts (1)\n  src/main.ts (1)',
  )
  assert.equal((await a.call('bash', { command: 'grep -c fetchUser src/user.ts src/main.ts' })).trim(), 'src/user.ts:1\nsrc/main.ts:1')
  assert.equal(await a.lsp({ action: 'diagnostics', path: 'src/main.ts' }), 'src/main.ts: no diagnostics')
  console.log('✓ rename edits every file and the server stays consistent')

  const [defs, hover] = await Promise.all([
    a.lsp({ action: 'definition', path: 'src/main.ts', line: 3, symbol: 'UserRepository' }),
    a.lsp({ action: 'hover', path: 'src/main.ts', line: 3, symbol: 'repo' }),
  ])
  assert.match(defs, /src\/user\.ts:2:14/)
  assert.match(hover, /UserRepository/)
  console.log('✓ concurrent calls')

  // The default snapshot's pylsp has no lint plugins; pyflakes adds diagnostics.
  await a.call('bash', { command: 'pip install -q pyflakes 2>/dev/null || pip install -q --break-system-packages pyflakes' })
  await a.call('write', { path: 'app.py', content: 'def greet(name: str) -> str:\n    return name\n\nprint(greet("x"))\nprint(undefined_name)\n' })
  assert.equal(await a.lsp({ action: 'definition', path: 'app.py', line: 4, symbol: 'greet' }), 'app.py:1:5  def greet(name: str) -> str:')
  assert.match(await a.lsp({ action: 'hover', path: 'app.py', line: 4, symbol: 'greet' }), /greet\(name: str\) -> str/)
  assert.match(await a.lsp({ action: 'diagnostics', path: 'app.py' }), /app\.py:5:7 error.*undefined name 'undefined_name'/)
  console.log('✓ Python via pylsp: definition / hover / diagnostics')

  // A separate Node process spawns a remote process, then the sandbox stops under it. The
  // connection drops without an exit code; nothing may keep that process alive afterwards.
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { createRequire } from 'node:module'
      import { fileURLToPath } from 'node:url'
      const { createJiti } = createRequire(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))('jiti')
      const { spawnRemoteProcess } = await createJiti(import.meta.url).import(process.env.REMOTE_PROCESS_MODULE)
      const { Daytona } = await import('@daytona/sdk')
      const sandbox = await new Daytona().get(process.env.SANDBOX_ID)
      const proc = await spawnRemoteProcess(sandbox, 'cat', { id: 'pi-exit-probe' })
      await sandbox.stop()
      for await (const _ of proc.stdout);
      console.log('stdout ended, connected=' + proc.isConnected())
      `,
    ],
    {
      cwd: root,
      env: { ...process.env, SANDBOX_ID: sandbox.id, REMOTE_PROCESS_MODULE: process.env.REMOTE_PROCESS_MODULE ?? path.join(root, 'src/remote-process.ts') },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  let childOut = ''
  child.stdout.on('data', (d) => (childOut += d))
  const childExit = await Promise.race([once(child, 'exit').then(([code]) => code), new Promise((r) => setTimeout(() => r('still running'), 60_000))])
  if (childExit === 'still running') child.kill()
  assert.equal(childExit, 0)
  assert.equal(childOut.trim(), 'stdout ended, connected=false')
  console.log('✓ a dropped connection (sandbox stop) ends stdout and leaves nothing keeping Node alive')

  assert.match(await a.lsp({ action: 'definition', path: 'src/main.ts', line: 3, symbol: 'UserRepository' }), /src\/user\.ts:2:14/)
  console.log('✓ after the sandbox stopped (idle pause): restarted and respawned transparently')

  await a.call('bash', { command: 'pkill -f typescript-language-server; pkill -f tsserver; true' })
  assert.match(await a.lsp({ action: 'hover', path: 'src/main.ts', line: 3, symbol: 'repo' }), /UserRepository/)
  console.log('✓ killed language server: respawned on the next call')

  // Pi exits without cleanup and the session is resumed: a new extension instance on the same sandbox.
  const before = await lspSessions()
  assert.ok(before.length >= 1)
  const b = await pi({ sandbox: await daytona.get(sandbox.id), cwd })
  assert.match(await b.lsp({ action: 'definition', path: 'src/main.ts', line: 3, symbol: 'UserRepository' }), /src\/user\.ts:2:14/)
  const after = await lspSessions()
  assert.equal(after.length, 1)
  assert.ok(!before.includes(after[0]))
  console.log('✓ resumed Pi: servers orphaned by the previous run are killed, one fresh server remains')

  await b.emit('session_shutdown')
  assert.deepEqual(await lspSessions(), [])
  console.log('✓ session_shutdown kills the language servers')

  await assert.rejects(b.lsp({ action: 'hover', path: 'src/missing.ts', line: 1, symbol: 'x' }), /File not found in the sandbox: .*src\/missing\.ts/)
  await assert.rejects(b.lsp({ action: 'hover', path: 'src/main.ts', line: 3, symbol: 'nope' }), /"nope" does not occur on line 3 of src\/main\.ts: const repo = new UserRepository\(\)/)
  await assert.rejects(b.lsp({ action: 'hover', path: 'src/main.ts', line: 99, symbol: 'x' }), /Line 99 is past the end/)
  await assert.rejects(b.lsp({ action: 'hover', path: 'README.md', line: 1, symbol: 'x' }), /No language server for .*README\.md/)
  await assert.rejects(b.lsp({ action: 'workspace_symbols', path: 'app.py', query: 'greet' }), /pylsp does not support workspace_symbols/)
  console.log('✓ actionable errors')
  await b.emit('session_shutdown')
} catch (err) {
  exitCode = 1
  console.error('FAIL:', err)
} finally {
  clearTimeout(watchdog)
  await sandbox.delete().catch(() => undefined)
}
console.log(exitCode ? '\nlsp live test FAILED' : '\nlsp live test passed.')
process.exit(exitCode)
