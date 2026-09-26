/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Research: can pi-lens's MCP server run inside a Daytona sandbox and be driven
 * from the host over the PTY transport (src/remote-process.ts)?
 *   1. install pi-lens in a fresh sandbox (default snapshot)
 *   2. spawn `pi-lens-mcp --cwd=<proj>` and speak newline-delimited JSON-RPC
 *   3. initialize, tools/list, pilens_session_start, pilens_analyze on a file with a type error
 *
 * Requires DAYTONA_API_KEY. Run: node scripts/research/pi-lens-mcp.mjs
 *   SPIKE_MEM_GB=4      create from node:24 with 4 GiB (the default snapshot's 1 GiB is OOM-killed)
 *   SPIKE_LOCAL_TS=1    install typescript into the project (without it the TS LSP reported 0 diagnostics)
 *   SPIKE_DIAG=1        also run pilens_diagnostics source=lsp, pilens_health, and list processes by RSS
 *   SKIP_SESSION_START=1
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url)
const { Daytona } = await import('@daytona/sdk')
const { spawnRemoteProcess } = await jiti.import(path.join(root, 'src/remote-process.ts'))

const PI_LENS = process.env.PI_LENS_VERSION ?? '4.3.0'
const timed = async (label, fn) => {
  const t = Date.now()
  const value = await fn()
  console.log(`[${label}] ${Date.now() - t} ms`)
  return value
}
const sh = async (sandbox, cmd, timeout = 600) => {
  const r = await sandbox.process.executeCommand(cmd, undefined, undefined, timeout)
  return { code: r.exitCode, out: r.result.trim() }
}

/** Minimal MCP client over a byte stream: one JSON object per line. */
function mcpClient(proc) {
  let nextId = 1
  const waiting = new Map()
  ;(async () => {
    let buf = ''
    for await (const chunk of proc.stdout) {
      buf += Buffer.from(chunk).toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          console.log(`[non-json stdout] ${line.slice(0, 200)}`)
          continue
        }
        const w = waiting.get(msg.id)
        if (w) {
          waiting.delete(msg.id)
          msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result)
        }
      }
    }
    for (const w of waiting.values()) w.reject(new Error('stdout closed'))
  })()
  return {
    request(method, params, timeoutMs = 120_000) {
      const id = nextId++
      const p = new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        setTimeout(() => waiting.delete(id) && reject(new Error(`${method} timed out`)), timeoutMs).unref()
      })
      proc.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return p
    },
    notify(method, params) {
      return proc.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

const text = (result) => (result?.content ?? []).map((c) => c.text ?? '').join('\n')

const daytona = new Daytona()
// SPIKE_MEM_GB: create from a plain Node image with that much memory (resources can't be set on snapshots).
const memGb = Number(process.env.SPIKE_MEM_GB ?? 0)
const sandbox = await daytona.create(
  memGb
    ? { image: 'node:24', resources: { cpu: 2, memory: memGb }, labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 }
    : { labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 },
  { timeout: 600 },
)
const watchdog = setTimeout(async () => {
  console.error('FAIL: watchdog (a step hung)')
  await sandbox.delete().catch(() => undefined)
  process.exit(1)
}, 900_000)
let proc
try {
  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona'
  const cwd = `${home}/proj`
  console.log('node/npm:', (await sh(sandbox, 'node -v && npm -v')).out.replace('\n', ' / '))
  console.log('tsls:', (await sh(sandbox, 'command -v typescript-language-server || echo none')).out)

  // pi-lens's peers (pi-tui / pi-coding-agent / typebox) aren't pulled in by npm here, but its MCP entry imports pi-tui.
  const install = await timed('npm i -g pi-lens', () =>
    sh(sandbox, `npm i -g pi-lens@${PI_LENS} @earendil-works/pi-tui@^0.85.0 @earendil-works/pi-coding-agent typebox${memGb ? ' typescript typescript-language-server' : ''} 2>&1 | tail -n 15`, 900),
  )
  console.log(`install exit=${install.code}\n${install.out}`)
  console.log('bin:', (await sh(sandbox, 'command -v pi-lens-mcp || echo none')).out)

  await sh(sandbox, `mkdir -p ${cwd}/src && cd ${cwd} && git init -q`)
  await sandbox.fs.uploadFile(Buffer.from('{"name":"proj","private":true,"type":"module"}'), `${cwd}/package.json`)
  await sandbox.fs.uploadFile(Buffer.from('{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler","noEmit":true},"include":["src"]}'), `${cwd}/tsconfig.json`)
  await sandbox.fs.uploadFile(Buffer.from("export function add(a: number, b: number): number {\n  return a + b\n}\nconst n: number = 'oops'\nexport { n }\n"), `${cwd}/src/main.ts`)
  if (process.env.SPIKE_LOCAL_TS) console.log('local ts:', (await sh(sandbox, `cd ${cwd} && npm i -D typescript 2>&1 | tail -n 2`)).out)

  proc = await timed('spawn pi-lens-mcp', () =>
    spawnRemoteProcess(sandbox, `bash -c 'pi-lens-mcp --cwd=${cwd}; echo exit=$? >&2'`, { id: 'pi-lens-spike', cwd, stderrPath: '/tmp/pi-lens-mcp.err' }),
  )
  const mcp = mcpClient(proc)
  const init = await timed('initialize', () =>
    mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-daytona-spike', version: '0' } }),
  )
  console.log('server:', JSON.stringify(init.serverInfo), 'protocol:', init.protocolVersion)
  await mcp.notify('notifications/initialized', {})

  const { tools } = await timed('tools/list', () => mcp.request('tools/list', {}))
  console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '))
  console.log('pilens_diagnostics schema:', JSON.stringify(tools.find((t) => t.name === 'pilens_diagnostics')?.inputSchema))

  if (!process.env.SKIP_SESSION_START) {
    const start = await timed('pilens_session_start', () => mcp.request('tools/call', { name: 'pilens_session_start', arguments: {} }, 300_000))
    console.log(text(start).slice(0, 300))
  }

  for (const round of [1, 2]) {
    const res = await timed(`pilens_analyze #${round}`, () =>
      mcp.request('tools/call', { name: 'pilens_analyze', arguments: { file: `${cwd}/src/main.ts` } }, 300_000),
    )
    console.log(process.env.SPIKE_RAW ? JSON.stringify(res, null, 1) : text(res).slice(0, 2000))
  }
  if (process.env.SPIKE_RAW) {
    const turn = await timed('pilens_turn_end', () => mcp.request('tools/call', { name: 'pilens_turn_end', arguments: {} }, 300_000))
    console.log(JSON.stringify(turn, null, 1))
    await sandbox.fs.uploadFile(Buffer.from('export const ok: number = 1\n'), `${cwd}/src/main.ts`)
    const clean = await timed('pilens_analyze clean', () => mcp.request('tools/call', { name: 'pilens_analyze', arguments: { file: `${cwd}/src/main.ts` } }, 300_000))
    console.log(JSON.stringify(clean, null, 1))
    const turn2 = await timed('pilens_turn_end clean', () => mcp.request('tools/call', { name: 'pilens_turn_end', arguments: {} }, 300_000))
    console.log(JSON.stringify(turn2, null, 1))
  }
  if (process.env.SPIKE_DIAG) {
    const lspDiag = await timed('pilens_diagnostics lsp', () =>
      mcp.request('tools/call', { name: 'pilens_diagnostics', arguments: { source: 'lsp', scope: 'paths', paths: [`${cwd}/src/main.ts`] } }, 300_000),
    )
    console.log(text(lspDiag).slice(0, 1500))
    const health = await mcp.request('tools/call', { name: 'pilens_health', arguments: {} }, 60_000)
    console.log(text(health).slice(0, 2500))
    console.log((await sh(sandbox, "ps -eo rss,args --sort=-rss | head -n 12 | cut -c1-160")).out)
  }
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  const err = await sh(sandbox, 'tail -n 30 /tmp/pi-lens-mcp.err; cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.peak 2>/dev/null; grep oom /sys/fs/cgroup/memory.events 2>/dev/null; nproc').catch(() => ({ out: '' }))
  if (err.out) console.log(`--- pi-lens-mcp stderr (tail) ---\n${err.out}`)
  await proc?.kill().catch(() => undefined)
  clearTimeout(watchdog)
  await sandbox.delete().catch(() => undefined)
}
