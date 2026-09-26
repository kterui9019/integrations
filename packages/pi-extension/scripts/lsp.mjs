/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline lifecycle test for the `lsp` tool. The fake sandbox reproduces the
 * daemon behavior observed against real Daytona sandboxes (see docs/lsp-poc.md):
 * didOpen snapshots the file, a re-didOpen of an open document is ignored,
 * workspace symbols need an open document, a restarted sandbox answers
 * "server not initialized", and a dead server process answers
 * "connection is closed" until stop() + start().
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
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
const { registerTools } = await jiti.import(path.join(root, 'src/tools.ts'))

const CWD = '/home/daytona/proj'

class FakeSandbox {
  constructor(files) {
    this.id = 'sb-lsp'
    this.state = 'started'
    this.files = new Map(Object.entries(files))
    this.daemon = { initialized: false, alive: false, open: new Map(), starts: 0, stops: 0, opened: [] }
    this.created = 0
    this.fs = {
      uploadFile: async (buf, p) => this.ensureStarted(() => this.files.set(p, buf.toString('utf8'))),
      downloadFile: async (p) => this.ensureStarted(() => Buffer.from(this.files.get(p) ?? '')),
    }
    this.process = {
      executeCommand: async (command, cwd) =>
        this.ensureStarted(() => {
          if (command.includes('find ')) {
            const rels = [...this.files.keys()].filter((p) => p.startsWith(`${cwd}/`) && p.endsWith('.ts')).map((p) => p.slice(cwd.length + 1)).sort()
            return { exitCode: 0, result: `${rels.find((r) => r.startsWith('src/')) ?? rels[0] ?? ''}\n` }
          }
          return { exitCode: 0, result: '' }
        }),
    }
  }
  ensureStarted(fn) {
    if (this.state !== 'started') throw new Error('sandbox is not started')
    return fn()
  }
  async refreshData() {}
  async start() {
    this.state = 'started'
  }
  /** Stop the sandbox: the daemon (and its in-memory LSP servers) goes away. */
  stopSandbox() {
    this.state = 'stopped'
    Object.assign(this.daemon, { initialized: false, alive: false, open: new Map() })
  }
  async createLspServer(language, projectRoot) {
    this.created++
    const d = this.daemon
    const guard = () => {
      this.ensureStarted(() => {})
      if (!d.initialized) throw new Error('server not initialized')
      if (!d.alive) throw new Error('bad request: jsonrpc2: connection is closed')
    }
    const symbolsIn = (p, text) =>
      [...text.matchAll(/class (\w+)/g)].map((m) => ({
        name: m[1],
        kind: 5,
        location: { uri: `file://${p}`, range: { start: { line: text.slice(0, m.index).split('\n').length - 1, character: m.index }, end: { line: 0, character: 0 } } },
      }))
    return {
      languageId: language,
      pathToProject: projectRoot,
      start: async () => {
        this.ensureStarted(() => {})
        if (d.initialized) return
        d.starts++
        Object.assign(d, { initialized: true, alive: true, open: new Map() })
      },
      stop: async () => {
        d.stops++
        const wasAlive = d.alive
        Object.assign(d, { initialized: false, alive: false, open: new Map() })
        if (!wasAlive) throw new Error('internal server error: error stopping LSP server')
      },
      didOpen: async (p) => {
        guard()
        if (!this.files.has(p)) throw new Error(`bad request: failed to read file: open ${p}: no such file or directory`)
        d.opened.push(p)
        if (!d.open.has(p)) d.open.set(p, this.files.get(p))
      },
      didClose: async (p) => {
        guard()
        d.open.delete(p)
      },
      documentSymbols: async (p) => {
        guard()
        return d.open.has(p) ? symbolsIn(p, d.open.get(p)) : []
      },
      sandboxSymbols: async (q) => {
        guard()
        if (d.open.size === 0) throw new Error('bad request: jsonrpc2: code 1 message: No Project.')
        return [...this.files.keys()]
          .filter((p) => p.startsWith(projectRoot) && p.endsWith('.ts'))
          .flatMap((p) => symbolsIn(p, d.open.get(p) ?? this.files.get(p)))
          .filter((s) => s.name.includes(q))
      },
      completions: async (p) => {
        guard()
        return { isIncomplete: false, items: symbolsIn(p, d.open.get(p)).map((s) => ({ label: s.name, kind: 7 })) }
      },
    }
  }
}

function load(sandbox, { daytonaFlag = true } = {}) {
  const tools = new Map()
  const stubPi = {
    registerTool: (t) => tools.set(t.name, t),
    on: () => {},
    getFlag: (name) => (name === 'daytona' ? daytonaFlag : undefined),
  }
  registerTools(stubPi, () => (sandbox ? { sandbox, cwd: CWD } : null))
  const call = async (name, params) => {
    const res = await tools.get(name).execute('id', params, undefined, undefined, {})
    return res.content.map((c) => c.text).join('\n')
  }
  return { lsp: (params) => call('lsp', params), write: (params) => call('write', params) }
}

const files = {
  [`${CWD}/src/user.ts`]: 'export class UserRepository {}\n',
  [`${CWD}/src/main.ts`]: "import { UserRepository } from './user'\n",
}

// Lazy start, reuse, restart, dead process, file changes, isolation.
{
  const sb = new FakeSandbox(files)
  const { lsp, write } = load(sb)

  assert.match(await lsp({ action: 'status' }), /not started/)
  assert.equal(sb.daemon.starts, 0, 'status must not start the server')
  assert.equal(sb.created, 0)
  console.log('✓ language server starts lazily')

  assert.match(await lsp({ action: 'workspace_symbols', query: 'UserRepository' }), /class UserRepository — src\/user\.ts:1:\d+/)
  assert.match(await lsp({ action: 'document_symbols', path: 'src/user.ts' }), /UserRepository/)
  assert.match(await lsp({ action: 'completions', path: 'src/user.ts', line: 1, character: 1 }), /UserRepository \(class\)/)
  assert.match(await lsp({ action: 'status' }), /· started/)
  assert.equal(sb.daemon.starts, 1)
  assert.equal(sb.created, 1)
  console.log('✓ queries reuse one server while the sandbox is valid')

  await write({ path: 'src/user.ts', content: 'export class UserRepository {}\nexport class AdminRepository {}\n' })
  assert.match(await lsp({ action: 'document_symbols', path: 'src/user.ts' }), /AdminRepository — src\/user\.ts:2/)
  assert.match(await lsp({ action: 'workspace_symbols', query: 'Admin' }), /AdminRepository/)
  // A document left open by a previous Pi session on the same daemon holds stale text.
  sb.daemon.open.set(`${CWD}/src/user.ts`, 'export class Stale {}\n')
  assert.doesNotMatch(await lsp({ action: 'document_symbols', path: 'src/user.ts' }), /Stale/)
  assert.equal(sb.daemon.open.size, 0, 'documents are closed after each query')
  console.log('✓ queries reflect edits made through the Daytona write tool')

  sb.stopSandbox()
  assert.match(await lsp({ action: 'workspace_symbols', query: 'UserRepository' }), /UserRepository/)
  assert.equal(sb.daemon.starts, 2)
  console.log('✓ stopped sandbox: sandbox restarted, then server re-initialized once')

  sb.daemon.alive = false
  assert.match(await lsp({ action: 'document_symbols', path: 'src/main.ts' }), /No symbols|UserRepository/)
  assert.equal(sb.daemon.stops, 1)
  assert.equal(sb.daemon.starts, 3)
  console.log('✓ dead server process: stop() + start(), then retried')

  assert.ok(sb.daemon.opened.every((p) => p.startsWith(`${CWD}/`)), 'paths are resolved against the sandbox cwd')
  assert.ok(!existsSync(CWD), 'sandbox path must not exist on the host')
  console.log('✓ LSP operations target sandbox paths, not the local filesystem')
}

// Resume: a new Sandbox object for the same sandbox gets a fresh client.
{
  const sb = new FakeSandbox(files)
  const { lsp } = load(sb)
  await lsp({ action: 'workspace_symbols', query: 'User' })
  const resumed = Object.assign(new FakeSandbox({}), { files: sb.files, daemon: sb.daemon })
  const tools = new Map()
  let active = { sandbox: sb, cwd: CWD }
  registerTools({ registerTool: (t) => tools.set(t.name, t), on: () => {}, getFlag: () => true }, () => active)
  await tools.get('lsp').execute('id', { action: 'workspace_symbols', query: 'User' })
  active = { sandbox: resumed, cwd: CWD }
  await tools.get('lsp').execute('id', { action: 'workspace_symbols', query: 'User' })
  assert.equal(resumed.created, 1, 'new Sandbox object → new LSP client')
  assert.equal(sb.daemon.starts, 1, 'daemon server still initialized → start() is a no-op')
  console.log('✓ resumed session rebuilds the LSP client against the reattached sandbox')
}

// Errors and bounded retry.
{
  const sb = new FakeSandbox(files)
  const { lsp } = load(sb)
  await assert.rejects(lsp({ action: 'document_symbols', path: 'src/nope.ts' }), /does not exist inside the sandbox: \/home\/daytona\/proj\/src\/nope\.ts/)
  await assert.rejects(lsp({ action: 'document_symbols', path: 'README.md' }), /No language server/)
  await assert.rejects(lsp({ action: 'workspace_symbols' }), /requires `query`/)
  await assert.rejects(lsp({ action: 'completions', path: 'src/user.ts' }), /requires `line`/)
  await assert.rejects(lsp({ action: 'hover', path: 'src/user.ts' }), /Unsupported LSP action/)

  const empty = new FakeSandbox({ [`${CWD}/README.md`]: '' })
  await assert.rejects(load(empty).lsp({ action: 'workspace_symbols', query: 'x' }), /Unable to determine project root/)

  await assert.rejects(load(null).lsp({ action: 'status' }), /sandbox is unavailable — the tool was NOT run on your host/)
  await assert.rejects(load(null, { daytonaFlag: false }).lsp({ action: 'status' }), /No active Daytona sandbox/)

  const broken = new FakeSandbox(files)
  const origCreate = broken.createLspServer.bind(broken)
  broken.createLspServer = async (...args) => ({ ...(await origCreate(...args)), start: async () => { throw new Error('spawn typescript-language-server ENOENT') } })
  await assert.rejects(load(broken).lsp({ action: 'workspace_symbols', query: 'x' }), /Language server failed to start.*ENOENT/)

  // start() "succeeds" but the daemon keeps answering not-initialized: exactly one retry.
  const stuck = new FakeSandbox(files)
  const { lsp: stuckLsp } = load(stuck)
  await stuckLsp({ action: 'status' })
  const origStuck = stuck.createLspServer.bind(stuck)
  let startCalls = 0
  stuck.createLspServer = async (...args) => {
    const server = await origStuck(...args)
    return { ...server, start: async () => { startCalls++ }, didClose: async () => { throw new Error('server not initialized') } }
  }
  await assert.rejects(stuckLsp({ action: 'workspace_symbols', query: 'x' }), /server not initialized/)
  assert.equal(startCalls, 2, 'initial lazy start + one retry')
  console.log('✓ useful errors; no local fallback; retry is bounded to one')
}

console.log('\nlsp lifecycle test passed.')
