/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code intelligence from language servers running inside the sandbox, against
 * the same checkout and dependencies as the other tools. There is no local
 * fallback. Servers are spawned on first use over the PTY transport
 * (remote-process.ts) and respawned once if the sandbox stopped (idle pause),
 * the process died, or the connection dropped.
 *
 * Document sync: the files the server has open are re-checked against the
 * sandbox (one md5sum) before every query, and edit/write tool writes are
 * pushed immediately (fileWritten). Files that were never opened are seen
 * through the server's own file watching.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Sandbox } from '@daytona/sdk'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { LspClient, LspConnectionClosedError } from './lsp-client.ts'
import { type RemoteProcess, killRemoteProcesses, spawnRemoteProcess } from './remote-process.ts'
import { execCommand, withRecovery } from './sandbox.ts'
import { joinPath, shellQuote } from './util.ts'

interface LanguageConfig {
  /** Executable checked with `command -v` before spawning. */
  binary: string
  command: string
  install: string
  /** File extension → LSP languageId. */
  extensions: Record<string, string>
  /**
   * `tsserver`: pulled synchronously through `typescript.tsserverRequest`, ordered after our changes.
   * `push`: textDocument/publishDiagnostics, only for the changed document, tagged with its version.
   */
  diagnostics: 'tsserver' | 'push'
  initializationOptions?: Record<string, unknown>
}

const LANGUAGES = {
  typescript: {
    binary: 'typescript-language-server',
    command: 'typescript-language-server --stdio',
    install: 'npm install -g typescript-language-server typescript',
    extensions: {
      ts: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascriptreact',
    },
    // Pushed diagnostics race cross-file re-checks (no version in the notification).
    diagnostics: 'tsserver',
    // The syntax-only tsserver answers while the project loads and resolves names to their
    // import binding instead of the declaration; route everything to the semantic server.
    initializationOptions: { tsserver: { useSyntaxServer: 'never' } },
  },
  python: {
    binary: 'pylsp',
    command: 'pylsp',
    install: "pip install 'python-lsp-server[all]'",
    extensions: { py: 'python', pyi: 'python' },
    diagnostics: 'push',
  },
} satisfies Record<string, LanguageConfig>

export type LspLanguage = keyof typeof LANGUAGES

const LANGUAGE_ORDER = Object.keys(LANGUAGES) as LspLanguage[]
const ID_PREFIX = 'pi-lsp-'
const DIAGNOSTICS_WAIT_MS = 15_000
const MAX_LOCATIONS = 200
const MAX_PREVIEW_FILES = 50

// --- LSP protocol shapes (the subset used here) ---

interface Position {
  line: number
  character: number
}
interface Range {
  start: Position
  end: Position
}
interface Location {
  uri: string
  range: Range
}
interface LocationLink {
  targetUri: string
  targetSelectionRange: Range
}
interface Diagnostic {
  range: Range
  severity?: number
  code?: string | number
  message: string
}
interface TsServerDiagnostic {
  start: { line: number; offset: number }
  text: string
  code?: number
  category: string
}
/** 1-based, ready to print. */
interface FileDiagnostic {
  line: number
  character: number
  severity: string
  code?: string
  message: string
}
interface DocumentSymbol {
  name: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}
interface SymbolInformation {
  name: string
  kind: number
  location: Location
  containerName?: string
}
interface TextEdit {
  range: Range
  newText: string
}
interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: Array<{ textDocument?: { uri: string }; edits?: TextEdit[]; kind?: string }>
}
type MarkedString = string | { language: string; value: string }
interface Hover {
  contents: MarkedString | MarkedString[] | { kind: string; value: string }
}

// --- server state ---

interface OpenDocument {
  version: number
  text: string
  md5: string
  /** Value of Server.changes when this version was sent. */
  changeSeq: number
}

interface PushedDiagnostics {
  version?: number
  receivedSeq: number
  diagnostics: Diagnostic[]
}

class Server {
  readonly documents = new Map<string, OpenDocument>()
  private readonly pushed = new Map<string, PushedDiagnostics>()
  private readonly publishWaiters = new Map<string, Set<() => void>>()
  /** Count of document changes sent; orders pushes without a version against our changes. */
  private changes = 0
  private lock: Promise<unknown> = Promise.resolve()

  constructor(
    readonly sandbox: Sandbox,
    readonly root: string,
    readonly language: LspLanguage,
    readonly proc: RemoteProcess,
    readonly client: LspClient,
    readonly capabilities: Record<string, unknown>,
  ) {
    client.onNotification(({ method, params }) => {
      if (method !== 'textDocument/publishDiagnostics' || !isObject(params) || typeof params.uri !== 'string') return
      this.pushed.set(params.uri, {
        version: typeof params.version === 'number' ? params.version : undefined,
        receivedSeq: this.changes,
        diagnostics: Array.isArray(params.diagnostics) ? (params.diagnostics as Diagnostic[]) : [],
      })
      for (const wake of this.publishWaiters.get(params.uri) ?? []) wake()
      this.publishWaiters.delete(params.uri)
    })
  }

  get alive(): boolean {
    return this.proc.isConnected() && !this.client.closed
  }

  /** Serialize document sync + requests so concurrent tool calls can't double-open or reorder versions. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  /** Diagnostics for the current content of open document `path`; `fresh` is false if a push timed out. */
  async diagnosticsFor(path: string): Promise<{ items: FileDiagnostic[]; fresh: boolean }> {
    if (LANGUAGES[this.language].diagnostics === 'tsserver') {
      const items: FileDiagnostic[] = []
      for (const command of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync']) {
        const res = await this.client.request<{ body?: TsServerDiagnostic[] }>('workspace/executeCommand', {
          command: 'typescript.tsserverRequest',
          arguments: [command, { file: path }],
        })
        for (const d of res?.body ?? []) {
          items.push({ line: d.start.line, character: d.start.offset, severity: d.category, code: d.code === undefined ? undefined : `TS${d.code}`, message: d.text })
        }
      }
      return { items, fresh: true }
    }
    const uri = fileUri(path)
    const deadline = Date.now() + DIAGNOSTICS_WAIT_MS
    let fresh = this.pushIsCurrent(path)
    while (!fresh && Date.now() < deadline) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const waiters = this.publishWaiters.get(uri) ?? new Set()
      this.publishWaiters.set(uri, waiters)
      waiters.add(resolve)
      const timer = setTimeout(resolve, deadline - Date.now())
      await promise
      clearTimeout(timer)
      waiters.delete(resolve)
      fresh = this.pushIsCurrent(path)
    }
    const items = (this.pushed.get(uri)?.diagnostics ?? []).map((d) => ({
      line: d.range.start.line + 1,
      character: d.range.start.character + 1,
      severity: SEVERITIES[d.severity ?? 1] ?? 'error',
      code: d.code === undefined ? undefined : String(d.code),
      message: d.message,
    }))
    return { items, fresh }
  }

  private pushIsCurrent(path: string): boolean {
    const doc = this.documents.get(path)
    const push = this.pushed.get(fileUri(path))
    if (!doc || !push) return false
    return push.version !== undefined ? push.version >= doc.version : push.receivedSeq >= doc.changeSeq
  }

  /** Open `path` (or push new content if it is open and changed). */
  async sync(path: string, content?: Buffer): Promise<OpenDocument> {
    const bytes = content ?? (await this.download(path))
    const md5 = createHash('md5').update(bytes).digest('hex')
    const uri = fileUri(path)
    const current = this.documents.get(path)
    if (current?.md5 === md5) return current
    const text = bytes.toString('utf8')
    const changeSeq = ++this.changes
    if (current) {
      const doc = { version: current.version + 1, text, md5, changeSeq }
      this.documents.set(path, doc)
      await this.client.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] })
    } else {
      const doc = { version: 1, text, md5, changeSeq }
      this.documents.set(path, doc)
      const languageId = languageIdFor(path) ?? this.language
      await this.client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } })
    }
    return this.documents.get(path)!
  }

  /** Re-check every open document against the sandbox; push changes, close deleted files. */
  async refresh(): Promise<void> {
    if (this.documents.size === 0) return
    const paths = [...this.documents.keys()]
    const res = await execCommand(this.sandbox, `md5sum -- ${paths.map(shellQuote).join(' ')} 2>/dev/null`, this.root)
    const onDisk = new Map<string, string>()
    for (const line of (res.result ?? '').split('\n')) {
      const match = /^([0-9a-f]{32}) [ *](.+)$/.exec(line)
      if (match) onDisk.set(match[2], match[1])
    }
    for (const path of paths) {
      const md5 = onDisk.get(path)
      if (md5 === this.documents.get(path)?.md5) continue
      if (md5 === undefined) {
        this.documents.delete(path)
        this.pushed.delete(fileUri(path))
        await this.client.notify('textDocument/didClose', { textDocument: { uri: fileUri(path) } })
        continue
      }
      await this.sync(path)
    }
  }

  async download(path: string): Promise<Buffer> {
    try {
      return await this.sandbox.fs.downloadFile(path)
    } catch (err) {
      const exists = await execCommand(this.sandbox, `test -f ${shellQuote(path)}`)
      if (exists.exitCode !== 0) throw new Error(`File not found in the sandbox: ${path}`)
      throw err
    }
  }
}

// An open PTY WebSocket counts as sandbox activity: while a server is connected the
// sandbox never idle-pauses. Shutting servers down after this long restores the pause.
const IDLE_SHUTDOWN_MS = 5 * 60_000

export class LspManager {
  private readonly servers = new Map<LspLanguage, Server>()
  private readonly starting = new Map<LspLanguage, Promise<Server>>()
  private orphansReaped = false
  private idleTimer: NodeJS.Timeout | undefined
  private activeCalls = 0

  constructor(private readonly idleShutdownMs = IDLE_SHUTDOWN_MS) {}

  /**
   * Run `fn` exclusively against a live server, respawning once if the old one is gone.
   * `fn` must be safe to run twice (read-only, or idempotent document sync).
   */
  async use<T>(sandbox: Sandbox, root: string, language: LspLanguage, fn: (server: Server) => Promise<T>): Promise<T> {
    this.activeCalls++
    clearTimeout(this.idleTimer)
    try {
      let server = await this.ensure(sandbox, root, language)
      try {
        return await server.exclusive(() => fn(server))
      } catch (err) {
        if (server.alive && !(err instanceof LspConnectionClosedError)) throw err
        this.drop(language)
        server = await this.ensure(sandbox, root, language)
        return await server.exclusive(() => fn(server))
      }
    } finally {
      // The idle period starts when the last concurrent call finishes.
      if (--this.activeCalls === 0) {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => void this.dispose(), this.idleShutdownMs)
        this.idleTimer.unref()
      }
    }
  }

  /** Push content written by the edit/write tools to a running server. Never starts one; never throws. */
  fileWritten = (path: string, content: string): void => {
    const language = languageForPath(path)
    const server = language && this.servers.get(language)
    if (!server?.alive) return
    void server.exclusive(() => server.sync(path, Buffer.from(content, 'utf8'))).catch(() => undefined)
  }

  status(sandbox: Sandbox): string {
    return LANGUAGE_ORDER.map((language) => {
      const server = this.servers.get(language)
      const state = !server || server.sandbox !== sandbox ? 'not started' : server.alive ? 'running' : 'dead (respawns on next use)'
      const open = server?.alive ? ` · ${server.documents.size} open file(s)` : ''
      return `${language} (${LANGUAGES[language].binary}): ${state}${open} · log ${logPath(language)}`
    }).join('\n')
  }

  runningLanguages(sandbox: Sandbox): LspLanguage[] {
    return LANGUAGE_ORDER.filter((l) => {
      const server = this.servers.get(l)
      return server?.sandbox === sandbox && server.alive
    })
  }

  async dispose(): Promise<void> {
    clearTimeout(this.idleTimer)
    const servers = [...this.servers.values()]
    this.servers.clear()
    await Promise.allSettled(servers.map((s) => s.proc.kill()))
  }

  private async ensure(sandbox: Sandbox, root: string, language: LspLanguage): Promise<Server> {
    const existing = this.servers.get(language)
    if (existing && existing.sandbox === sandbox && existing.root === root && existing.alive) return existing
    if (existing) this.drop(language)
    let starting = this.starting.get(language)
    if (!starting) {
      starting = this.spawn(sandbox, root, language).finally(() => this.starting.delete(language))
      this.starting.set(language, starting)
    }
    return starting
  }

  private drop(language: LspLanguage): void {
    const server = this.servers.get(language)
    this.servers.delete(language)
    void server?.proc.kill().catch(() => undefined)
  }

  private async spawn(sandbox: Sandbox, root: string, language: LspLanguage): Promise<Server> {
    const config: LanguageConfig = LANGUAGES[language]
    const installed = await execCommand(sandbox, `command -v ${config.binary}`, root)
    if (installed.exitCode !== 0) {
      throw new Error(`${config.binary} is not installed in the sandbox. Install it with: ${config.install}`)
    }
    if (!this.orphansReaped) {
      this.orphansReaped = true
      // Servers from an earlier Pi run on this sandbox (Pi exited without cleanup).
      await killRemoteProcesses(sandbox, ID_PREFIX).catch(() => undefined)
    }
    const id = `${ID_PREFIX}${language}-${randomBytes(4).toString('hex')}`
    const proc = await withRecovery(sandbox, () => spawnRemoteProcess(sandbox, config.command, { id, cwd: root, stderrPath: logPath(language) }))
    const client = new LspClient(proc)
    try {
      const init = await client.request<{ capabilities: Record<string, unknown> }>('initialize', {
        processId: null,
        initializationOptions: config.initializationOptions,
        rootUri: fileUri(root),
        workspaceFolders: [{ uri: fileUri(root), name: root.split('/').pop() || root }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: false },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: false },
            publishDiagnostics: {},
          },
          workspace: { symbol: {}, workspaceEdit: { documentChanges: true }, workspaceFolders: true, configuration: true },
        },
      })
      await client.notify('initialized', {})
      const server = new Server(sandbox, root, language, proc, client, init.capabilities)
      this.servers.set(language, server)
      return server
    } catch (err) {
      await proc.kill().catch(() => undefined)
      const log = await execCommand(sandbox, `tail -n 20 ${logPath(language)} 2>/dev/null`).catch(() => undefined)
      const tail = log?.result?.trim()
      throw new Error(`${config.binary} failed to start: ${err instanceof Error ? err.message : String(err)}${tail ? `\n${tail}` : ''}`)
    }
  }
}

// --- actions ---

const ACTIONS = ['definition', 'references', 'hover', 'diagnostics', 'document_symbols', 'workspace_symbols', 'rename', 'status'] as const
type LspAction = (typeof ACTIONS)[number]

const CAPABILITY: Partial<Record<LspAction, string>> = {
  definition: 'definitionProvider',
  references: 'referencesProvider',
  hover: 'hoverProvider',
  document_symbols: 'documentSymbolProvider',
  workspace_symbols: 'workspaceSymbolProvider',
  rename: 'renameProvider',
}

export interface LspParams {
  action: LspAction
  path?: string
  line?: number
  symbol?: string
  character?: number
  query?: string
  new_name?: string
}

export interface LspTarget {
  sandbox: Sandbox
  cwd: string
}

export async function runLspAction(manager: LspManager, target: LspTarget, params: LspParams): Promise<string> {
  const { sandbox, cwd } = target
  if (params.action === 'status') return manager.status(sandbox)
  if (!ACTIONS.includes(params.action)) throw new Error(`Unsupported lsp action: ${String(params.action)} (supported: ${ACTIONS.join(', ')})`)

  const path = params.path === undefined ? undefined : params.path.startsWith('/') ? params.path : joinPath(cwd, params.path)
  if (params.action === 'workspace_symbols') {
    const query = required(params.query, 'query', params.action)
    const language = path ? requireLanguage(path) : await defaultLanguage(manager, sandbox, cwd)
    return manager.use(sandbox, cwd, language, async (server) => {
      requireCapability(server, params.action)
      await server.refresh()
      // workspace/symbol only searches projects the server has loaded, i.e. of an open file.
      if (path && !server.documents.has(path)) await server.sync(path)
      else if (server.documents.size === 0) await server.sync(await findSourceFile(sandbox, cwd, language))
      const symbols = (await server.client.request<SymbolInformation[] | null>('workspace/symbol', { query })) ?? []
      return formatSymbolList(symbols, cwd)
    })
  }

  if (params.action === 'rename') {
    const file = required(path, 'path', params.action)
    const newName = required(params.new_name, 'new_name', params.action)
    // Planning only reads, so it may be retried on a respawned server; writing may not.
    const plan = await manager.use(sandbox, cwd, requireLanguage(file), async (server) => {
      requireCapability(server, params.action)
      await server.refresh()
      const doc = server.documents.get(file) ?? (await server.sync(file))
      const position = resolvePosition(doc.text, params)
      const edit = await server.client.request<WorkspaceEdit | null>('textDocument/rename', { textDocument: { uri: fileUri(file) }, position, newName })
      return planWorkspaceEdit(server, edit)
    })
    return writeRenamePlan(manager, sandbox, plan, cwd, newName)
  }

  if (params.action === 'diagnostics' && !path) {
    const languages = manager.runningLanguages(sandbox)
    if (languages.length === 0) return 'No files have been checked yet. Pass `path` to check a file.'
    const parts = []
    for (const language of languages) {
      parts.push(
        await manager.use(sandbox, cwd, language, async (server) => {
          await server.refresh()
          const lines = []
          for (const p of server.documents.keys()) lines.push(formatDiagnostics(relativePath(p, cwd), await server.diagnosticsFor(p), true))
          return lines.filter(Boolean).join('\n')
        }),
      )
    }
    return parts.filter(Boolean).join('\n') || 'No diagnostics in the checked files.'
  }

  const file = required(path, 'path', params.action)
  const language = requireLanguage(file)
  return manager.use(sandbox, cwd, language, async (server) => {
    requireCapability(server, params.action)
    await server.refresh()
    // Open documents were just re-checked by refresh().
    const doc = server.documents.get(file) ?? (await server.sync(file))
    const uri = fileUri(file)
    switch (params.action) {
      case 'diagnostics':
        return formatDiagnostics(relativePath(file, cwd), await server.diagnosticsFor(file), false)
      case 'document_symbols': {
        const symbols = (await server.client.request<Array<DocumentSymbol | SymbolInformation> | null>('textDocument/documentSymbol', { textDocument: { uri } })) ?? []
        return formatDocumentSymbols(symbols, cwd)
      }
      default:
        break
    }
    const position = resolvePosition(doc.text, params)
    const textDocument = { uri }
    switch (params.action) {
      case 'definition': {
        const result = await server.client.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', { textDocument, position })
        return formatLocations(server, toLocations(result), cwd, 'No definition found.')
      }
      case 'references': {
        const result = await server.client.request<Location[] | null>('textDocument/references', { textDocument, position, context: { includeDeclaration: true } })
        return formatLocations(server, result ?? [], cwd, 'No references found.')
      }
      case 'hover': {
        const result = await server.client.request<Hover | null>('textDocument/hover', { textDocument, position })
        return result ? hoverText(result.contents) : 'No hover information.'
      }
      default:
        throw new Error(`Unsupported lsp action: ${params.action}`)
    }
  })
}

/** 0-based LSP position from a 1-based line plus a symbol name (or 1-based column) on that line. */
function resolvePosition(text: string, params: LspParams): Position {
  const lineNumber = required(params.line, 'line', params.action)
  const lines = text.split('\n')
  const lineText = lines[lineNumber - 1]
  if (lineText === undefined) throw new Error(`Line ${lineNumber} is past the end of ${params.path} (${lines.length} lines).`)
  if (params.symbol !== undefined && params.symbol !== '') {
    const at = lineText.indexOf(params.symbol)
    if (at < 0) throw new Error(`"${params.symbol}" does not occur on line ${lineNumber} of ${params.path}: ${lineText.trim()}`)
    return { line: lineNumber - 1, character: at }
  }
  if (params.character !== undefined) return { line: lineNumber - 1, character: params.character - 1 }
  throw new Error(`lsp ${params.action} requires \`symbol\` (a name on the line) or \`character\`.`)
}

interface FileUpdate {
  path: string
  original: string
  text: string
  edits: number
}

/** Resolve a WorkspaceEdit into the new content of every file, without writing anything. */
async function planWorkspaceEdit(server: Server, edit: WorkspaceEdit | null): Promise<FileUpdate[]> {
  const perFile = new Map<string, TextEdit[]>()
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) perFile.set(uri, edits)
  for (const change of edit?.documentChanges ?? []) {
    if (change.kind || !change.textDocument || !change.edits) throw new Error('Rename needs file create/rename/delete operations, which are not supported.')
    perFile.set(change.textDocument.uri, [...(perFile.get(change.textDocument.uri) ?? []), ...change.edits])
  }
  const updates: FileUpdate[] = []
  for (const [uri, edits] of perFile) {
    const path = uriToPath(uri)
    const original = server.documents.get(path)?.text ?? (await server.download(path)).toString('utf8')
    updates.push({ path, original, text: applyTextEdits(original, edits), edits: edits.length })
  }
  return updates
}

/** Write every file of the plan; on failure restore the ones already written. Never retried. */
async function writeRenamePlan(manager: LspManager, sandbox: Sandbox, plan: FileUpdate[], root: string, newName: string): Promise<string> {
  if (plan.length === 0) return 'Nothing to rename.'
  const upload = (path: string, text: string) => withRecovery(sandbox, () => sandbox.fs.uploadFile(Buffer.from(text, 'utf8'), path))
  const written: FileUpdate[] = []
  for (const update of plan) {
    try {
      await upload(update.path, update.text)
    } catch (err) {
      const notRestored: string[] = []
      for (const done of written) await upload(done.path, done.original).catch(() => notRestored.push(relativePath(done.path, root)))
      const reason = `${relativePath(update.path, root)}: ${err instanceof Error ? err.message : String(err)}`
      if (notRestored.length > 0) {
        throw new Error(`Rename to ${newName} failed writing ${reason}. These files keep the new name and could not be restored: ${notRestored.join(', ')}`)
      }
      throw new Error(`Rename to ${newName} failed writing ${reason}. No files were changed${written.length ? ` (${written.length} restored)` : ''}.`)
    }
    written.push(update)
  }
  for (const { path, text } of plan) manager.fileWritten(path, text)
  const total = plan.reduce((n, u) => n + u.edits, 0)
  return [`Renamed to ${newName}: ${total} edit(s) in ${plan.length} file(s)`, ...plan.map((u) => `  ${relativePath(u.path, root)} (${u.edits})`)].join('\n')
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const offset = (p: Position) => Math.min((lineStarts[p.line] ?? text.length) + p.character, text.length)
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))
  let out = text
  for (const e of sorted) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end))
  return out
}

// --- formatting ---

const SYMBOL_KINDS = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
  'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
  'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter',
]
const SEVERITIES = ['', 'error', 'warning', 'info', 'hint']

function toLocations(result: Location | Location[] | LocationLink[] | null): Location[] {
  if (!result) return []
  const list: Array<Location | LocationLink> = Array.isArray(result) ? result : [result]
  return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l))
}

async function formatLocations(server: Server, locations: Location[], root: string, empty: string): Promise<string> {
  if (locations.length === 0) return empty
  const shown = locations.slice(0, MAX_LOCATIONS)
  const files = [...new Set(shown.map((l) => uriToPath(l.uri)))].slice(0, MAX_PREVIEW_FILES)
  const texts = new Map<string, string[]>()
  await Promise.all(
    files.map(async (path) => {
      const text = server.documents.get(path)?.text ?? (await server.download(path).then((b) => b.toString('utf8')).catch(() => undefined))
      if (text !== undefined) texts.set(path, text.split('\n'))
    }),
  )
  const lines = shown.map((l) => {
    const path = uriToPath(l.uri)
    const { line, character } = l.range.start
    const preview = texts.get(path)?.[line]?.trim()
    return `${relativePath(path, root)}:${line + 1}:${character + 1}${preview ? `  ${preview}` : ''}`
  })
  if (locations.length > shown.length) lines.push(`… ${locations.length - shown.length} more`)
  return lines.join('\n')
}

function formatDiagnostics(rel: string, { items, fresh }: { items: FileDiagnostic[]; fresh: boolean }, skipEmpty: boolean): string {
  const note = fresh ? '' : `(the language server did not report within ${DIAGNOSTICS_WAIT_MS / 1000}s; showing the last known result)`
  if (items.length === 0) return skipEmpty && fresh ? '' : `${rel}: no diagnostics${note ? ` ${note}` : ''}`
  const lines = items.map((d) => `${rel}:${d.line}:${d.character} ${d.severity}${d.code ? ` ${d.code}` : ''}: ${d.message.replace(/\n/g, ' ')}`)
  return lines.join('\n') + (note ? `\n${note}` : '')
}

function formatDocumentSymbols(symbols: Array<DocumentSymbol | SymbolInformation>, root: string): string {
  if (symbols.length === 0) return 'No symbols found.'
  if ('location' in symbols[0]) return formatSymbolList(symbols as SymbolInformation[], root)
  const lines: string[] = []
  const walk = (list: DocumentSymbol[], depth: number) => {
    for (const s of [...list].sort((a, b) => a.range.start.line - b.range.start.line)) {
      lines.push(`${'  '.repeat(depth)}${SYMBOL_KINDS[s.kind] ?? s.kind} ${s.name} :${s.selectionRange.start.line + 1}`)
      if (s.children) walk(s.children, depth + 1)
    }
  }
  walk(symbols as DocumentSymbol[], 0)
  return lines.join('\n')
}

function formatSymbolList(symbols: SymbolInformation[], root: string): string {
  if (symbols.length === 0) return 'No symbols found.'
  const lines = symbols.slice(0, MAX_LOCATIONS).map((s) => {
    const { line, character } = s.location.range.start
    const container = s.containerName ? ` (in ${s.containerName})` : ''
    return `${SYMBOL_KINDS[s.kind] ?? s.kind} ${s.name}${container} — ${relativePath(uriToPath(s.location.uri), root)}:${line + 1}:${character + 1}`
  })
  if (symbols.length > MAX_LOCATIONS) lines.push(`… ${symbols.length - MAX_LOCATIONS} more`)
  return lines.join('\n')
}

function hoverText(contents: Hover['contents']): string {
  const part = (c: MarkedString): string => (typeof c === 'string' ? c : '```' + c.language + '\n' + c.value + '\n```')
  if (Array.isArray(contents)) return contents.map(part).join('\n\n').trim() || 'No hover information.'
  if (typeof contents === 'object' && 'kind' in contents) return contents.value.trim() || 'No hover information.'
  return part(contents).trim() || 'No hover information.'
}

// --- helpers ---

function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined || value === '') throw new Error(`lsp ${action} requires \`${name}\`.`)
  return value
}

function requireCapability(server: Server, action: LspAction): void {
  const key = CAPABILITY[action]
  if (key && !server.capabilities[key]) throw new Error(`${LANGUAGES[server.language].binary} does not support ${action}.`)
}

export function languageForPath(path: string): LspLanguage | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_ORDER.find((l) => ext in LANGUAGES[l].extensions)
}

function languageIdFor(path: string): string | undefined {
  const language = languageForPath(path)
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return language && (LANGUAGES[language].extensions as Record<string, string>)[ext]
}

function requireLanguage(path: string): LspLanguage {
  const language = languageForPath(path)
  if (!language) {
    const supported = LANGUAGE_ORDER.flatMap((l) => Object.keys(LANGUAGES[l].extensions).map((e) => `.${e}`)).join(' ')
    throw new Error(`No language server for ${path} (supported: ${supported}).`)
  }
  return language
}

async function defaultLanguage(manager: LspManager, sandbox: Sandbox, root: string): Promise<LspLanguage> {
  const running = manager.runningLanguages(sandbox)[0]
  if (running) return running
  for (const language of LANGUAGE_ORDER) {
    if (await findSourceFile(sandbox, root, language).then(() => true, () => false)) return language
  }
  throw new Error(`No supported source files under ${root}.`)
}

// ponytail: first source file (src/ preferred) decides which project is loaded; in a monorepo
// pass `path` to search another package's project.
async function findSourceFile(sandbox: Sandbox, root: string, language: LspLanguage): Promise<string> {
  const names = Object.keys(LANGUAGES[language].extensions).map((ext) => `-name '*.${ext}'`).join(' -o ')
  const find = (dir: string) =>
    `find ${dir} -type f \\( ${names} \\) -not -name '*.d.ts' -not -path '*/node_modules/*' -not -path '*/.*' 2>/dev/null`
  const res = await execCommand(sandbox, `{ ${find('src')}; ${find('.')}; } | head -n 1`, root)
  const rel = (res.result ?? '').trim().replace(/^\.\//, '')
  if (!rel) throw new Error(`No ${language} source files under ${root}.`)
  return joinPath(root, rel)
}

function relativePath(path: string, root: string): string {
  const prefix = `${root.replace(/\/+$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

function uriToPath(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname)
}

function logPath(language: LspLanguage): string {
  return `/tmp/${ID_PREFIX}${language}.log`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// --- Pi tool ---

export function createLspTool(manager: LspManager, requireSandbox: () => LspTarget | null): ToolDefinition {
  return {
    name: 'lsp',
    label: 'LSP',
    description:
      'Code intelligence from a language server running inside the Daytona sandbox (TypeScript/JavaScript via ' +
      'typescript-language-server, Python via pylsp), against the same files and dependencies as bash/read/edit. ' +
      'Positions: `line` is 1-based (as shown by read) and `symbol` is a name that occurs on that line ' +
      '(or pass a 1-based `character`). Actions: definition, references, hover, rename (`new_name`; edits files) — ' +
      'need path+line+symbol; diagnostics (type errors/lint for `path`, or for all files checked so far); ' +
      'document_symbols (outline of `path`); workspace_symbols (`query`); status. ' +
      'Edits made with edit/write are seen immediately; changes made via bash are picked up on the next call.',
    promptSnippet: 'Go to definition, find references, hover types, diagnostics, rename via the in-sandbox language server',
    promptGuidelines: [
      'Use lsp definition/references instead of grep to navigate TypeScript/JavaScript/Python symbols.',
      'Use lsp diagnostics on files you changed to catch type errors before running the full build.',
    ],
    parameters: Type.Object({
      action: Type.Unsafe<LspAction>({ type: 'string', enum: [...ACTIONS] }),
      path: Type.Optional(Type.String({ description: 'File path, relative to the working directory or absolute' })),
      line: Type.Optional(Type.Integer({ minimum: 1, description: '1-based line number' })),
      symbol: Type.Optional(Type.String({ description: 'Name on that line to target (first occurrence)' })),
      character: Type.Optional(Type.Integer({ minimum: 1, description: '1-based column, instead of symbol' })),
      query: Type.Optional(Type.String({ description: 'Symbol name to search (workspace_symbols)' })),
      new_name: Type.Optional(Type.String({ description: 'New name (rename)' })),
    }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted')
      const target = requireSandbox()
      if (!target) throw new Error('No active Daytona sandbox — the lsp tool only runs inside the sandbox (launch Pi with --daytona).')
      const text = await runLspAction(manager, target, params as LspParams)
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
}
