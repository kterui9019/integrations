/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline test for the PTY transport and sandbox tool routing. The fake
 * sandbox's PTY behaves like the real one (shell noise before the sentinel,
 * output split at arbitrary points, disconnect on sandbox stop). No API key or
 * network needed.
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

const CWD = '/home/daytona/proj'

class FakeSandbox {
  constructor() {
    this.id = 'sb-test'
    this.state = 'started'
    this.ptys = new Map()
    this.chunks = []
    this.execCwds = []
    this.process = {
      executeCommand: async (_cmd, cwd) => {
        this.execCwds.push(cwd)
        return { exitCode: 0, result: '' }
      },
      listPtySessions: async () => [...this.ptys.keys()].map((id) => ({ id })),
      killPtySession: async (id) => this.ptys.get(id)?.kill(),
      createPty: async (opts) => this.createPty(opts),
    }
  }
  createPty({ id, onData }) {
    if (this.state !== 'started') throw new Error('sandbox is not started')
    let connected = true
    let raw = false
    const handle = {
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
        if (!raw) {
          const [, a, b] = /printf '%s%s' '([^']*)' '([^']*)'/.exec(String(data))
          raw = true
          onData(Buffer.from(`% ${data}\r\n\x1b[?2004l${a}${b}`))
          return
        }
        this.chunks.push(Buffer.from(data))
      },
    }
    this.ptys.set(id, handle)
    return handle
  }
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

console.log('\noffline transport test passed.')
