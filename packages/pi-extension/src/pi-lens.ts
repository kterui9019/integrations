/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * pi-lens (https://github.com/apmantza/pi-lens) running inside the sandbox.
 *
 * Its MCP server (`pi-lens-mcp`) runs over the PTY transport (remote-process.ts)
 * against the sandbox checkout. Its tools are registered as Pi tools, every
 * write/edit is analyzed and the findings are appended to the tool result, and
 * turn-end findings are steered into the next model call.
 */

import { randomBytes } from 'node:crypto'
import type { Sandbox } from '@daytona/sdk'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { type RemoteProcess, killRemoteProcesses, spawnRemoteProcess } from './remote-process.ts'
import { execCommand, withRecovery } from './sandbox.ts'
import type { ToolSandbox } from './tools.ts'
import { shellQuote } from './util.ts'

const BINARY = 'pi-lens-mcp'
const ID_PREFIX = 'pi-lens-'
const LOG_PATH = `/tmp/${ID_PREFIX}mcp.log`
const REQUEST_TIMEOUT_MS = 120_000
// An open PTY WebSocket keeps the sandbox from idle-pausing.
const IDLE_SHUTDOWN_MS = 5 * 60_000
// Driven by the hooks below; letting the model call them would desync pi-lens's session state.
const LIFECYCLE_TOOLS: Record<string, true> = { pilens_session_start: true, pilens_turn_end: true, pilens_session_end: true }

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

interface Message {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

class McpConnectionClosedError extends Error {}

/** MCP client over a byte stream: newline-delimited JSON-RPC. */
class McpClient {
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private closedError: Error | undefined

  constructor(private readonly proc: RemoteProcess) {
    void this.readLoop()
  }

  get closed(): boolean {
    return this.closedError !== undefined
  }

  request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`${method}: no response within ${timeoutMs}ms`))
    }, timeoutMs)
    this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
    this.send({ id, method, params }).catch((err: Error) => {
      this.pending.delete(id)
      clearTimeout(timer)
      reject(err)
    })
    return promise
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError)
    return this.send({ method, params })
  }

  private send(msg: Message): Promise<void> {
    return this.proc.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }

  private dispatch(msg: Message): void {
    if (msg.id === undefined) return
    if (msg.method !== undefined) {
      const reply = msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: `unsupported: ${msg.method}` } }
      void this.send({ id: msg.id, ...reply }).catch(() => undefined)
      return
    }
    const req = this.pending.get(msg.id)
    if (!req) return
    this.pending.delete(msg.id)
    clearTimeout(req.timer)
    if (msg.error) req.reject(new Error(`${req.method}: ${msg.error.message}`))
    else req.resolve(msg.result)
  }

  private async readLoop(): Promise<void> {
    let buf = ''
    const decoder = new TextDecoder()
    try {
      for await (const chunk of this.proc.stdout) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) this.dispatch(JSON.parse(line) as Message)
        }
      }
      this.closedError = new McpConnectionClosedError('pi-lens connection closed')
    } catch (err) {
      this.closedError = new McpConnectionClosedError(`pi-lens stream failed: ${err instanceof Error ? err.message : err}`)
    }
    for (const req of this.pending.values()) {
      clearTimeout(req.timer)
      req.reject(this.closedError)
    }
    this.pending.clear()
  }
}

export class PiLensNotInstalledError extends Error {
  constructor() {
    super(`${BINARY} is not installed in the sandbox — pi-lens is off for this session. Use a snapshot with pi-lens installed (see the README).`)
  }
}

interface Server {
  sandbox: Sandbox
  root: string
  proc: RemoteProcess
  client: McpClient
  tools: McpTool[]
}

/** One pi-lens server, started on first use and restarted when its connection is gone. */
export class PiLens {
  private server: Server | undefined
  private starting: Promise<Server> | undefined
  private readonly reaped = new Set<string>()
  private idleTimer: NodeJS.Timeout | undefined
  private activeCalls = 0

  constructor(private readonly idleShutdownMs = IDLE_SHUTDOWN_MS) {}

  listTools(sandbox: Sandbox, root: string): Promise<McpTool[]> {
    return this.use(sandbox, root, async (server) => server.tools)
  }

  callTool(sandbox: Sandbox, root: string, name: string, args: unknown): Promise<McpToolResult> {
    return this.use(sandbox, root, (server) => server.client.request<McpToolResult>('tools/call', { name, arguments: args }))
  }

  async dispose(): Promise<void> {
    clearTimeout(this.idleTimer)
    const server = this.server
    this.server = undefined
    await server?.proc.kill().catch(() => undefined)
  }

  // ponytail: tool calls are never retried (pilens_ast_grep_replace writes files); a dead
  // connection is replaced on the next call instead.
  private async use<T>(sandbox: Sandbox, root: string, fn: (server: Server) => Promise<T>): Promise<T> {
    this.activeCalls++
    clearTimeout(this.idleTimer)
    try {
      return await fn(await this.ensure(sandbox, root))
    } finally {
      if (--this.activeCalls === 0) {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => void this.dispose(), this.idleShutdownMs)
        this.idleTimer.unref()
      }
    }
  }

  private ensure(sandbox: Sandbox, root: string): Promise<Server> {
    const current = this.server
    if (current && current.sandbox === sandbox && current.root === root && current.proc.isConnected() && !current.client.closed) {
      return Promise.resolve(current)
    }
    if (current) {
      this.server = undefined
      void current.proc.kill().catch(() => undefined)
    }
    this.starting ??= this.spawn(sandbox, root).finally(() => (this.starting = undefined))
    return this.starting
  }

  private async spawn(sandbox: Sandbox, root: string): Promise<Server> {
    const installed = await execCommand(sandbox, `command -v ${BINARY}`, root)
    if (installed.exitCode !== 0) throw new PiLensNotInstalledError()
    if (!this.reaped.has(sandbox.id)) {
      this.reaped.add(sandbox.id)
      // Left behind by an earlier Pi run that exited without cleanup.
      await killRemoteProcesses(sandbox, ID_PREFIX).catch(() => undefined)
    }
    const id = `${ID_PREFIX}${randomBytes(4).toString('hex')}`
    const proc = await withRecovery(sandbox, () =>
      spawnRemoteProcess(sandbox, `${BINARY} --cwd=${shellQuote(root)}`, { id, cwd: root, stderrPath: LOG_PATH }),
    )
    const client = new McpClient(proc)
    try {
      await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pi-daytona', version: '1' },
      })
      await client.notify('notifications/initialized', {})
      const { tools } = await client.request<{ tools: McpTool[] }>('tools/list', {})
      await client.request('tools/call', { name: 'pilens_session_start', arguments: {} })
      const server = { sandbox, root, proc, client, tools }
      this.server = server
      return server
    } catch (err) {
      await proc.kill().catch(() => undefined)
      const log = await execCommand(sandbox, `tail -n 20 ${LOG_PATH} 2>/dev/null`).catch(() => undefined)
      const tail = log?.result?.trim()
      throw new Error(`${BINARY} failed to start: ${err instanceof Error ? err.message : String(err)}${tail ? `\n${tail}` : ''}`)
    }
  }
}

/**
 * Wire pi-lens into Pi. `getActive` returns the session's sandbox (null when local);
 * `requireSandbox` additionally throws when `--daytona` is set but no sandbox is up.
 */
export function registerPiLens(
  pi: ExtensionAPI,
  getActive: () => ToolSandbox | null,
  requireSandbox: () => ToolSandbox | null,
  lens = new PiLens(),
): void {
  const registered = new Set<string>()
  const notInstalled = new Set<string>()
  const edited = new Set<string>()

  pi.on('before_agent_start', async (_event, ctx) => {
    const active = getActive()
    if (!active || registered.size || notInstalled.has(active.sandbox.id)) return
    try {
      for (const tool of await lens.listTools(active.sandbox, active.cwd)) {
        if (LIFECYCLE_TOOLS[tool.name]) continue
        pi.registerTool(bridgeTool(lens, tool, requireSandbox))
        registered.add(tool.name)
      }
    } catch (err) {
      if (err instanceof PiLensNotInstalledError) {
        notInstalled.add(active.sandbox.id)
        ctx.ui.notify(err.message, 'info')
        return
      }
      ctx.ui.notify(`pi-lens: ${errorMessage(err)}`, 'warning')
    }
  })

  pi.on('tool_result', async (event, ctx) => {
    if ((event.toolName !== 'write' && event.toolName !== 'edit') || event.isError || !registered.size) return
    const active = getActive()
    const file = event.input.path
    if (!active || typeof file !== 'string') return
    edited.add(file)
    try {
      const report = analyzeReport(await lens.callTool(active.sandbox, active.cwd, 'pilens_analyze', { file }))
      if (report) return { content: [...event.content, { type: 'text', text: report }] }
    } catch (err) {
      ctx.ui.notify(`pi-lens: analysis of ${file} failed — ${errorMessage(err)}`, 'warning')
    }
  })

  pi.on('turn_end', async (_event, ctx) => {
    const active = getActive()
    if (!active || edited.size === 0) return
    const files = [...edited]
    edited.clear()
    try {
      const report = turnEndReport(await lens.callTool(active.sandbox, active.cwd, 'pilens_turn_end', { files }))
      if (report) pi.sendMessage({ customType: 'pi-lens', content: report, display: true }, { deliverAs: 'steer' })
    } catch (err) {
      ctx.ui.notify(`pi-lens: turn-end checks failed — ${errorMessage(err)}`, 'warning')
    }
  })

  pi.on('session_shutdown', async () => {
    edited.clear()
    await lens.dispose()
  })
}

function bridgeTool(lens: PiLens, tool: McpTool, requireSandbox: () => ToolSandbox | null) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error('aborted')
      const active = requireSandbox()
      if (!active) throw new Error(`No active Daytona sandbox — ${tool.name} only runs inside the sandbox (launch Pi with --daytona).`)
      const result = await lens.callTool(active.sandbox, active.cwd, tool.name, params)
      const text = resultText(result)
      if (result.isError) throw new Error(text)
      return { content: [{ type: 'text' as const, text }], details: undefined }
    },
  }
}

interface AnalyzeData {
  counts?: { diagnostics?: number }
  diagnostics?: Array<{ line?: number; column?: number; severity?: string; rule?: string; message?: string }>
}

/** Findings for one analyzed file, or undefined when it is clean. */
export function analyzeReport(result: McpToolResult): string | undefined {
  const text = resultText(result)
  if (result.isError) throw new Error(text)
  const data = jsonBlock<AnalyzeData>(text)
  if (!data) return `pi-lens: ${prose(text)}`
  if (!data.counts?.diagnostics) return undefined
  const lines = (data.diagnostics ?? []).map((d) => `  ${d.line}:${d.column} ${d.severity} ${d.rule}: ${d.message}`)
  return [`pi-lens: ${prose(text).split('\n')[0]}`, ...lines].join('\n')
}

/** Turn-end advisory, or undefined when there is none. */
export function turnEndReport(result: McpToolResult): string | undefined {
  const text = resultText(result)
  if (result.isError) throw new Error(text)
  const data = jsonBlock<{ turnEnd?: string; tests?: string }>(text)
  if (data && !data.turnEnd && !data.tests) return undefined
  return `pi-lens turn-end:\n${prose(text)}`
}

function resultText(result: McpToolResult): string {
  return (result.content ?? []).flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n')
}

// pi-lens's tool text is prose, then its structured result as a ```json block, then usage lines.
function jsonBlock<T>(text: string): T | undefined {
  const match = /```json\n([\s\S]*?)\n```/.exec(text)
  if (!match) return undefined
  try {
    return JSON.parse(match[1]) as T
  } catch {
    return undefined
  }
}

function prose(text: string): string {
  return text.split('```json')[0].trim()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
