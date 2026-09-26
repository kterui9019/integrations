/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline test for the lsp tool and its PTY transport. The fake sandbox's PTY
 * behaves like the real one (shell noise before the sentinel, output split at
 * arbitrary points, disconnect on sandbox stop) and forwards the stream to a
 * tiny in-process language server. No API key or network needed.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url, { alias: { '@daytona/sdk': path.join(__dirname, 'stub-daytona-sdk.mjs') } })
const { registerTools } = await jiti.import(path.join(root, 'src/tools.ts'))
const { spawnRemoteProcess } = await jiti.import(path.join(root, 'src/remote-process.ts'))
const { LspManager, runLspAction } = await jiti.import(path.join(root, 'src/lsp.ts'))

const CWD = '/home/daytona/proj'
const uriOf = (p) => `file://${p}`
const pathOf = (u) => decodeURIComponent(new URL(u).pathname)

/** Just enough of a language server: open documents override files on `disk`. */
function fakeServer(send, disk, onRequest) {
  const docs = new Map()
  const project = () => new Map([...[...disk].filter(([p]) => p.endsWith('.ts')).map(([p, t]) => [uriOf(p), t]), ...docs])
  const wordAt = (uri, { line, character }) => {
    const text = docs.get(uri).split('\n')[line]
    return /^\w+/.exec(text.slice(character))?.[0]
  }
  const declarations = (name) =>
    [...project()].flatMap(([uri, text]) =>
      text.split('\n').flatMap((l, line) => {
        const at = l.indexOf(`class ${name}`)
        return at < 0 ? [] : [{ uri, range: { start: { line, character: at + 6 }, end: { line, character: at + 6 + name.length } } }]
      }),
    )
  const handlers = {
    initialize: () => ({
      capabilities: { definitionProvider: true, hoverProvider: true, renameProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true },
    }),
    'textDocument/didOpen': (p) => docs.set(p.textDocument.uri, p.textDocument.text),
    'textDocument/didChange': (p) => docs.set(p.textDocument.uri, p.contentChanges[0].text),
    'textDocument/didClose': (p) => docs.delete(p.textDocument.uri),
    'textDocument/hover': (p) => ({ contents: { kind: 'plaintext', value: `line: ${docs.get(p.textDocument.uri).split('\n')[p.position.line]}` } }),
    'textDocument/definition': (p) => declarations(wordAt(p.textDocument.uri, p.position)),
    'textDocument/rename': (p) => {
      const word = wordAt(p.textDocument.uri, p.position)
      const changes = {}
      for (const [uri, text] of project()) {
        const edits = text.split('\n').flatMap((l, line) =>
          [...l.matchAll(new RegExp(`\\b${word}\\b`, 'g'))].map((m) => ({ range: { start: { line, character: m.index }, end: { line, character: m.index + word.length } }, newText: p.newName })),
        )
        if (edits.length) changes[uri] = edits
      }
      return { changes }
    },
    'workspace/executeCommand': (p) => {
      if (p.arguments[0] !== 'semanticDiagnosticsSync') return { body: [] }
      const lines = docs.get(uriOf(p.arguments[1].file)).split('\n')
      return { body: lines.flatMap((l, i) => (l.includes('ERROR') ? [{ start: { line: i + 1, offset: l.indexOf('ERROR') + 1 }, text: 'bad', code: 1, category: 'error' }] : [])) }
    },
  }
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, end).toString())[1])
      if (buf.length < end + 4 + len) return
      const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString())
      buf = buf.subarray(end + 4 + len)
      onRequest(msg.method)
      const result = handlers[msg.method]?.(msg.params)
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
    }
  }
}

class FakeSandbox {
  constructor(files = {}) {
    this.id = 'sb-lsp'
    this.state = 'started'
    this.files = new Map(Object.entries(files))
    this.ptys = new Map()
    this.spawned = 0
    this.installed = true
    this.chunks = []
    this.execCwds = []
    this.requests = []
    this.uploadHook = undefined
    this.fs = {
      uploadFile: async (buf, p) => {
        this.uploadHook?.(p)
        this.files.set(p, Buffer.from(buf).toString())
      },
      downloadFile: async (p) => {
        if (!this.files.has(p)) throw new Error('not found')
        return Buffer.from(this.files.get(p))
      },
    }
    this.process = {
      executeCommand: async (cmd, cwd) => {
        this.execCwds.push(cwd)
        return this.exec(cmd)
      },
      listPtySessions: async () => [...this.ptys.keys()].map((id) => ({ id })),
      killPtySession: async (id) => this.ptys.get(id)?.kill(),
      createPty: async (opts) => this.createPty(opts),
    }
  }
  exec(cmd) {
    if (cmd.startsWith('command -v')) return { exitCode: this.installed ? 0 : 1, result: '' }
    if (cmd.startsWith('md5sum')) {
      const paths = [...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1])
      const lines = paths.filter((p) => this.files.has(p)).map((p) => `${createHash('md5').update(this.files.get(p)).digest('hex')}  ${p}`)
      return { exitCode: 0, result: lines.join('\n') }
    }
    if (cmd.startsWith('test -f')) return { exitCode: this.files.has(/'([^']+)'/.exec(cmd)[1]) ? 0 : 1, result: '' }
    if (cmd.includes('find ')) return { exitCode: 0, result: [...this.files.keys()].find((p) => p.endsWith('.ts'))?.slice(CWD.length + 1) ?? '' }
    return { exitCode: 0, result: '' }
  }
  createPty({ id, onData }) {
    if (this.state !== 'started') throw new Error('sandbox is not started')
    this.spawned++
    let connected = true
    let raw = false
    let feed
    let exit
    const exited = new Promise((r) => (exit = r))
    const emit = (bytes) => {
      // Deliver in awkward pieces, like the real WebSocket stream.
      for (let i = 0; i < bytes.length; i += 7) onData(bytes.subarray(i, i + 7))
    }
    const handle = {
      waitForConnection: async () => {},
      isConnected: () => connected,
      wait: () => exited,
      kill: async () => {
        connected = false
        this.ptys.delete(id)
        exit({ exitCode: 137 })
      },
      disconnect: () => {
        connected = false
        this.ptys.delete(id)
      },
      sendInput: async (data) => {
        if (!connected) throw new Error('PTY is not connected')
        if (!raw) {
          const [, a, b] = /printf '%s%s' '([^']*)' '([^']*)'/.exec(String(data))
          raw = true
          emit(Buffer.from(`% ${data}\r\n\x1b[?2004l${a}${b}`))
          feed = fakeServer((msg) => {
            const body = Buffer.from(JSON.stringify(msg))
            emit(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
          }, this.files, (method) => this.requests.push(method))
          return
        }
        this.chunks.push(Buffer.from(data))
        feed(Buffer.from(data))
      },
    }
    this.ptys.set(id, handle)
    return handle
  }
  stopSandbox() {
    this.state = 'stopped'
    for (const pty of [...this.ptys.values()]) pty.disconnect()
  }
  async refreshData() {}
  async start() {
    this.state = 'started'
  }
}

function load(sandbox, { daytona = true } = {}) {
  const tools = new Map()
  const handlers = new Map()
  registerTools(
    { registerTool: (t) => tools.set(t.name, t), on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]), getFlag: (n) => (n === 'daytona' ? daytona : undefined) },
    () => (sandbox ? { sandbox, cwd: CWD } : null),
  )
  const emit = async (e) => {
    for (const fn of handlers.get(e) ?? []) await fn({}, {})
  }
  const call = async (name, params) => (await tools.get(name).execute('id', params, undefined, () => {}, {})).content[0].text
  return { tools, emit, call, lsp: (p) => call('lsp', p) }
}

const files = () => ({
  [`${CWD}/src/user.ts`]: 'export class UserRepository {}\n',
  [`${CWD}/src/main.ts`]: "import { UserRepository } from './user'\nconst repo = new UserRepository()\n",
})

// Registration
{
  const off = load(new FakeSandbox(), { daytona: false })
  await off.emit('session_start')
  assert.ok(!off.tools.has('lsp'))
  const on = load(new FakeSandbox())
  await on.emit('session_start')
  await on.emit('session_start')
  assert.ok(on.tools.has('lsp'))
  console.log('✓ lsp is registered once, and only in --daytona sessions')
}

// Navigation, sync with edit/write and out-of-band changes, diagnostics, rename
{
  const sb = new FakeSandbox(files())
  sb.ptys.set('pi-lsp-typescript-old', { kill: async () => sb.ptys.delete('pi-lsp-typescript-old') })
  const pi = load(sb)
  await pi.emit('session_start')
  assert.match(await pi.lsp({ action: 'status' }), /typescript .*not started/)
  assert.equal(sb.spawned, 0)
  console.log('✓ nothing is spawned before the first query')

  assert.equal(await pi.lsp({ action: 'definition', path: 'src/main.ts', line: 2, symbol: 'UserRepository' }), 'src/user.ts:1:14  export class UserRepository {}')
  assert.ok(!sb.ptys.has('pi-lsp-typescript-old'))
  assert.equal(sb.spawned, 1)
  console.log('✓ definition through the PTY transport (noise before the sentinel stripped); orphaned servers killed')

  await pi.call('write', { path: 'src/main.ts', content: "import { UserRepository } from './user'\nconst repo = new UserRepository() // written\n" })
  assert.equal(await pi.lsp({ action: 'hover', path: 'src/main.ts', line: 2, symbol: 'repo' }), 'line: const repo = new UserRepository() // written')
  sb.files.set(`${CWD}/src/main.ts`, "import { UserRepository } from './user'\nconst repo: UserRepository = new UserRepository() // ERROR via bash\n")
  assert.equal(await pi.lsp({ action: 'hover', path: 'src/main.ts', line: 2, symbol: 'repo' }), 'line: const repo: UserRepository = new UserRepository() // ERROR via bash')
  console.log('✓ open documents follow write-tool writes and out-of-band (bash) changes')

  assert.equal(await pi.lsp({ action: 'diagnostics', path: 'src/main.ts' }), 'src/main.ts:2:54 error TS1: bad')
  assert.equal(await pi.lsp({ action: 'diagnostics' }), 'src/main.ts:2:54 error TS1: bad')
  console.log('✓ diagnostics for a file and for all checked files')

  assert.equal(
    await pi.lsp({ action: 'rename', path: 'src/user.ts', line: 1, symbol: 'UserRepository', new_name: 'Users' }),
    'Renamed to Users: 4 edit(s) in 2 file(s)\n  src/user.ts (1)\n  src/main.ts (3)',
  )
  assert.equal(sb.files.get(`${CWD}/src/main.ts`), "import { Users } from './user'\nconst repo: Users = new Users() // ERROR via bash\n")
  assert.equal(sb.files.get(`${CWD}/src/user.ts`), 'export class Users {}\n')
  console.log('✓ rename writes every edit (several per line) and keeps the server in sync')

  sb.files.delete(`${CWD}/src/user.ts`)
  assert.equal(await pi.lsp({ action: 'definition', path: 'src/main.ts', line: 2, symbol: 'Users' }), 'No definition found.')
  console.log('✓ deleted files are closed on the next call')

  sb.stopSandbox()
  assert.match(await pi.lsp({ action: 'hover', path: 'src/main.ts', line: 1, symbol: 'Users' }), /line: import/)
  assert.equal(sb.spawned, 2)
  console.log('✓ disconnected server (sandbox stopped) is respawned once, after restarting the sandbox')

  await pi.emit('session_shutdown')
  assert.deepEqual([...sb.ptys.keys()], [])
  console.log('✓ session_shutdown kills the servers')
}

// Bounded recovery and errors
{
  const sb = new FakeSandbox(files())
  const pi = load(sb)
  await pi.emit('session_start')
  await pi.lsp({ action: 'hover', path: 'src/main.ts', line: 1, symbol: 'import' })
  const create = sb.createPty.bind(sb)
  sb.createPty = (opts) => {
    const handle = create(opts)
    const send = handle.sendInput
    let first = true
    handle.sendInput = async (d) => {
      if (first) return ((first = false), send(d))
      handle.disconnect()
      throw new Error('PTY is not connected')
    }
    return handle
  }
  for (const pty of [...sb.ptys.values()]) pty.disconnect()
  await assert.rejects(pi.lsp({ action: 'hover', path: 'src/main.ts', line: 1, symbol: 'import' }), /not connected/)
  assert.equal(sb.spawned, 2, 'one respawn, no loop')
  console.log('✓ recovery is attempted once')

  const fresh = load(new FakeSandbox(files()))
  await fresh.emit('session_start')
  await assert.rejects(fresh.lsp({ action: 'hover', path: 'src/nope.ts', line: 1, symbol: 'x' }), /File not found in the sandbox: \/home\/daytona\/proj\/src\/nope\.ts/)
  await assert.rejects(fresh.lsp({ action: 'hover', path: 'src/main.ts', line: 2, symbol: 'nope' }), /"nope" does not occur on line 2 of src\/main\.ts/)
  await assert.rejects(fresh.lsp({ action: 'hover', path: 'src/main.ts', line: 9, symbol: 'x' }), /Line 9 is past the end/)
  await assert.rejects(fresh.lsp({ action: 'hover', path: 'src/main.ts', line: 2 }), /requires `symbol`/)
  await assert.rejects(fresh.lsp({ action: 'hover', path: 'README.md', line: 1, symbol: 'x' }), /No language server for/)
  await assert.rejects(fresh.lsp({ action: 'document_symbols' }), /requires `path`/)
  const missing = new FakeSandbox(files())
  missing.installed = false
  const m = load(missing)
  await m.emit('session_start')
  await assert.rejects(m.lsp({ action: 'hover', path: 'src/main.ts', line: 1, symbol: 'import' }), /typescript-language-server is not installed in the sandbox\. Install it with: npm install -g/)
  console.log('✓ actionable errors')
}

// Pi ≥0.8x passes the host working directory as ctx.cwd; sandbox tools must ignore it
{
  const sb = new FakeSandbox()
  const pi = load(sb)
  const ctx = { cwd: '/Users/me/host-project', hasUI: false, sessionManager: { getSessionId: () => 'session-id', getSessionFile: () => undefined } }
  await pi.tools.get('bash').execute('id', { command: 'pwd' }, undefined, () => {}, ctx)
  assert.deepEqual(sb.execCwds, [CWD])
  console.log('✓ bash runs in the sandbox cwd even when ctx.cwd is the host directory')
}

// Idle shutdown: a connected PTY keeps the sandbox from idle-pausing
{
  const sb = new FakeSandbox(files())
  const manager = new LspManager(100)
  const target = { sandbox: sb, cwd: CWD }
  await runLspAction(manager, target, { action: 'hover', path: 'src/main.ts', line: 1, symbol: 'import' })
  await new Promise((r) => setTimeout(r, 60))
  await runLspAction(manager, target, { action: 'hover', path: 'src/main.ts', line: 1, symbol: 'import' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(sb.ptys.size, 1, 'each call restarts the idle timer')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(sb.ptys.size, 0)
  assert.match(await runLspAction(manager, target, { action: 'hover', path: 'src/main.ts', line: 1, symbol: 'import' }), /line: import/)
  assert.equal(sb.spawned, 2)
  await manager.dispose()
  console.log('✓ servers shut down after the idle period and respawn on the next call')
}

// Transport: a dropped connection ends the stream and rejects writes
{
  const sb = new FakeSandbox()
  const proc = await spawnRemoteProcess(sb, 'cat', { id: 'pi-drop' })
  sb.ptys.get('pi-drop').disconnect()
  const drained = (async () => {
    for await (const _ of proc.stdout);
    return 'ended'
  })()
  assert.equal(await Promise.race([drained, new Promise((r) => setTimeout(() => r('still open'), 2000))]), 'ended')
  assert.equal(proc.isConnected(), false)
  await assert.rejects(proc.write('x'), /not connected/)
  console.log('✓ transport: a dropped connection ends stdout and rejects further writes')
}

// Transport: concurrent writes larger than one chunk stay contiguous
{
  const sb = new FakeSandbox()
  const proc = await spawnRemoteProcess(sb, 'cat', { id: 'pi-test' })
  sb.chunks = []
  await Promise.all([proc.write(Buffer.alloc(200_000, 0x41)), proc.write(Buffer.alloc(200_000, 0x42))])
  assert.ok(sb.chunks.every((c) => c.length <= 64 * 1024))
  assert.equal(Buffer.concat(sb.chunks).toString().replace(/(.)\1*/g, '$1'), 'AB')
  console.log('✓ transport: writes are split into ≤64 KiB messages and never interleave')
}

console.log('\nlsp offline test passed.')
