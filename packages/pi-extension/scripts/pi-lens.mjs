/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline test for the pi-lens bridge, the PTY transport, and sandbox tool
 * routing. The fake sandbox's PTY behaves like the real one (shell noise before
 * the sentinel, output split at arbitrary points, disconnect on sandbox stop)
 * and forwards the stream to a tiny in-process MCP server that mimics
 * pi-lens-mcp's tool results. No API key or network needed.
 */

import assert from 'node:assert/strict'
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
const { PiLens, registerPiLens } = await jiti.import(path.join(root, 'src/pi-lens.ts'))

const CWD = '/home/daytona/proj'
const TOOLS = ['pilens_analyze', 'pilens_symbol_search', 'pilens_session_start', 'pilens_turn_end', 'pilens_session_end']
const toolText = (prose, data) => ({ content: [{ type: 'text', text: `${prose}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n\nresult ok` }] })

/** Just enough of pi-lens-mcp: files containing ERROR have a finding. */
function fakeMcpServer(send, sandbox) {
  const read = (file) => sandbox.files.get(file.startsWith('/') ? file : `${CWD}/${file}`) ?? ''
  const calls = {
    pilens_session_start: () => toolText('Session started.', {}),
    pilens_analyze: ({ file }) => {
      const line = read(file).split('\n').findIndex((l) => l.includes('ERROR'))
      const diagnostics = line < 0 ? [] : [{ line: line + 1, column: 1, severity: 'error', rule: 'ts:2322', message: 'bad' }]
      return toolText(`${file} [warm] — ${diagnostics.length} blocking`, { counts: { diagnostics: diagnostics.length }, diagnostics })
    },
    pilens_turn_end: ({ files }) => {
      const dirty = files.filter((f) => read(f).includes('ERROR'))
      return dirty.length
        ? toolText(`Turn-end over ${files.length} file(s).\ncascade: ${dirty.join(', ')}`, { filesRegistered: files.length, turnEnd: `cascade: ${dirty.join(', ')}` })
        : toolText(`Turn-end over ${files.length} file(s).\nNo turn-end advisory.`, { filesRegistered: files.length })
    },
    pilens_symbol_search: (args) =>
      args.query === 'fail' ? { content: [{ type: 'text', text: 'query failed' }], isError: true } : toolText(`found ${args.query}`, {}),
  }
  const handlers = {
    initialize: () => ({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pi-lens-mcp' } }),
    'tools/list': () => ({ tools: TOOLS.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } })) }),
    'tools/call': ({ name, arguments: args }) => {
      sandbox.calls.push({ name, args })
      return calls[name](args)
    },
  }
  let buf = ''
  return (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: handlers[msg.method](msg.params) })
    }
  }
}

class FakeSandbox {
  constructor(files = {}) {
    this.id = 'sb-test'
    this.state = 'started'
    this.files = new Map(Object.entries(files))
    this.ptys = new Map()
    this.installed = true
    this.spawned = 0
    this.calls = []
    this.commands = []
    this.chunks = []
    this.execCwds = []
    this.process = {
      executeCommand: async (cmd, cwd) => {
        this.commands.push(cmd)
        this.execCwds.push(cwd)
        if (cmd.startsWith('command -v')) return { exitCode: this.installed ? 0 : 1, result: '' }
        return { exitCode: 0, result: '' }
      },
      listPtySessions: async () => [...this.ptys.keys()].map((id) => ({ id })),
      killPtySession: async (id) => this.ptys.get(id)?.kill(),
      createPty: async (opts) => this.createPty(opts),
    }
  }
  createPty({ id, onData }) {
    if (this.state !== 'started') throw new Error('sandbox is not started')
    this.spawned++
    let connected = true
    let feed
    const emit = (bytes) => {
      // Deliver in awkward pieces, like the real WebSocket stream.
      for (let i = 0; i < bytes.length; i += 7) onData(bytes.subarray(i, i + 7))
    }
    const handle = {
      command: undefined,
      waitForConnection: async () => {},
      isConnected: () => connected,
      kill: async () => {
        connected = false
        this.ptys.delete(id)
      },
      disconnect: async () => {
        connected = false
        this.ptys.delete(id)
      },
      sendInput: async (data) => {
        if (!connected) throw new Error('PTY is not connected')
        if (!feed) {
          const [, a, b] = /printf '%s%s' '([^']*)' '([^']*)'/.exec(String(data))
          handle.command = String(data)
          emit(Buffer.from(`% ${data}\r\n\x1b[?2004l${a}${b}`))
          feed = handle.command.includes('pi-lens-mcp') ? fakeMcpServer((msg) => emit(Buffer.from(`${JSON.stringify(msg)}\n`)), this) : () => {}
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

function load(sandbox, { lens = new PiLens(), active = true } = {}) {
  const tools = new Map()
  const handlers = new Map()
  const notices = []
  const messages = []
  const pi = {
    registerTool: (t) => tools.set(t.name, t),
    on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    sendMessage: (message, options) => messages.push({ message, options }),
  }
  const getActive = () => (active ? { sandbox, cwd: CWD } : null)
  registerPiLens(pi, getActive, getActive, lens)
  const ctx = { ui: { notify: (text, level) => notices.push({ text, level }) } }
  const emit = async (e, event = {}) => {
    let result
    for (const fn of handlers.get(e) ?? []) result = (await fn(event, ctx)) ?? result
    return result
  }
  const edited = (file, toolName = 'edit') => emit('tool_result', { toolName, input: { path: file }, content: [{ type: 'text', text: 'Edited.' }], isError: false })
  return { tools, emit, edited, notices, messages }
}

// Pi ≥0.8x passes the host working directory as ctx.cwd; sandbox tools must ignore it
{
  const sb = new FakeSandbox()
  const tools = new Map()
  registerTools({ registerTool: (t) => tools.set(t.name, t), on: () => {}, getFlag: (n) => n === 'daytona' }, () => ({ sandbox: sb, cwd: CWD }))
  const ctx = { cwd: '/Users/me/host-project', hasUI: false, sessionManager: { getSessionId: () => 'session-id', getSessionFile: () => undefined } }
  await tools.get('bash').execute('id', { command: 'pwd' }, undefined, () => {}, ctx)
  assert.deepEqual(sb.execCwds, [CWD])
  console.log('✓ bash runs in the sandbox cwd even when ctx.cwd is the host directory')
}

// No sandbox: nothing starts
{
  const sb = new FakeSandbox()
  const pi = load(sb, { active: false })
  await pi.emit('before_agent_start')
  assert.equal(pi.tools.size, 0)
  assert.equal(await pi.edited('src/main.ts'), undefined)
  assert.equal(sb.spawned, 0)
  console.log('✓ without an active sandbox, pi-lens never starts')
}

// Tools, per-edit analysis, turn-end findings
{
  const sb = new FakeSandbox({ [`${CWD}/src/main.ts`]: 'const n: number = 1\n' })
  sb.ptys.set('pi-lens-old', { kill: async () => sb.ptys.delete('pi-lens-old') })
  const pi = load(sb)
  await pi.emit('before_agent_start')
  await pi.emit('before_agent_start')
  assert.deepEqual([...pi.tools.keys()], ['pilens_analyze', 'pilens_symbol_search'])
  assert.equal(sb.spawned, 1)
  assert.ok(!sb.ptys.has('pi-lens-old'))
  assert.match([...sb.ptys.values()][0].command, /exec pi-lens-mcp --cwd='\/home\/daytona\/proj' 2>/)
  assert.deepEqual(sb.calls.map((c) => c.name), ['pilens_session_start'])
  console.log('✓ first prompt starts pi-lens once (orphans killed) and registers its tools, except the lifecycle ones')

  const search = await pi.tools.get('pilens_symbol_search').execute('id', { query: 'UserRepository' }, undefined)
  assert.match(search.content[0].text, /^found UserRepository/)
  await assert.rejects(pi.tools.get('pilens_symbol_search').execute('id', { query: 'fail' }, undefined), /query failed/)
  console.log('✓ bridged tools forward arguments; an MCP error result fails the tool call')

  assert.equal(await pi.edited('src/main.ts'), undefined)
  sb.files.set(`${CWD}/src/main.ts`, "const n: number = 'ERROR'\n")
  const result = await pi.edited('src/main.ts')
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Edited.' },
    { type: 'text', text: 'pi-lens: src/main.ts [warm] — 1 blocking\n  1:1 error ts:2322: bad' },
  ])
  assert.equal(await pi.edited('src/main.ts', 'bash'), undefined)
  assert.equal(sb.calls.filter((c) => c.name === 'pilens_analyze').length, 2)
  console.log('✓ write/edit results get pi-lens findings appended; clean files and other tools are left alone')

  await pi.emit('turn_end')
  assert.deepEqual(sb.calls.at(-1), { name: 'pilens_turn_end', args: { files: ['src/main.ts'] } })
  assert.deepEqual(pi.messages, [
    {
      message: { customType: 'pi-lens', content: 'pi-lens turn-end:\nTurn-end over 1 file(s).\ncascade: src/main.ts', display: true },
      options: { deliverAs: 'steer' },
    },
  ])
  const turnEnds = sb.calls.filter((c) => c.name === 'pilens_turn_end').length
  await pi.emit('turn_end')
  assert.equal(sb.calls.filter((c) => c.name === 'pilens_turn_end').length, turnEnds, 'no edits since the last turn: no turn-end run')
  sb.files.set(`${CWD}/src/main.ts`, 'const n: number = 1\n')
  await pi.edited('src/main.ts')
  await pi.emit('turn_end')
  assert.equal(pi.messages.length, 1, 'a clean turn-end sends nothing')
  console.log('✓ turn-end runs over the files edited this turn and steers its advisory into the next model call')

  sb.stopSandbox()
  await new Promise((r) => setTimeout(r, 300))
  await sb.start()
  assert.match((await pi.tools.get('pilens_symbol_search').execute('id', { query: 'x' }, undefined)).content[0].text, /^found x/)
  assert.equal(sb.spawned, 2)
  console.log('✓ a dropped connection (sandbox stopped) is replaced by a fresh server on the next call')

  await pi.emit('session_shutdown')
  assert.deepEqual([...sb.ptys.keys()], [])
  console.log('✓ session_shutdown kills the server')
}

// Not installed, failures
{
  const sb = new FakeSandbox()
  sb.installed = false
  const pi = load(sb)
  await pi.emit('before_agent_start')
  await pi.emit('before_agent_start')
  assert.equal(pi.tools.size, 0)
  assert.equal(sb.commands.filter((c) => c.startsWith('command -v')).length, 1)
  assert.equal(pi.notices.length, 1)
  assert.match(pi.notices[0].text, /pi-lens-mcp is not installed in the sandbox/)
  assert.equal(await pi.edited('src/main.ts'), undefined)
  console.log('✓ without pi-lens in the sandbox: one notice, no tools, no analysis, no repeated checks')

  const broken = new FakeSandbox({ [`${CWD}/src/main.ts`]: 'x\n' })
  const b = load(broken)
  await b.emit('before_agent_start')
  broken.calls.push = () => {
    throw new Error('boom')
  }
  assert.equal(await b.edited('src/main.ts'), undefined)
  assert.match(b.notices.at(-1).text, /^pi-lens: analysis of src\/main\.ts failed — /)
  await b.emit('session_shutdown')
  console.log('✓ a failed analysis leaves the edit result untouched and is reported in the UI')
}

// Idle shutdown: a connected PTY keeps the sandbox from idle-pausing
{
  const sb = new FakeSandbox()
  const lens = new PiLens(100)
  await lens.listTools(sb, CWD)
  await new Promise((r) => setTimeout(r, 60))
  await lens.callTool(sb, CWD, 'pilens_symbol_search', { query: 'a' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(sb.ptys.size, 1, 'each call restarts the idle timer')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(sb.ptys.size, 0)
  await lens.callTool(sb, CWD, 'pilens_symbol_search', { query: 'b' })
  assert.equal(sb.spawned, 2)
  await lens.dispose()
  console.log('✓ the server shuts down after the idle period and restarts on the next call')
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
  await proc.kill()
  console.log('✓ transport: writes are split into ≤64 KiB messages and never interleave')
}

console.log('\npi-lens offline test passed.')
