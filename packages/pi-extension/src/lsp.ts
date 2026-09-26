/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code intelligence via Daytona's native LSP API. The language server runs
 * inside the sandbox against the same checkout and dependencies as the other
 * tools; there is no local fallback.
 */

import type { Sandbox } from '@daytona/sdk'
import { execCommand, withRecovery } from './sandbox.ts'
import { joinPath } from './util.ts'

/** The subset of the SDK's (unexported) LspServer class used here. */
interface LspServer {
  start(): Promise<void>
  stop(): Promise<void>
  didOpen(path: string): Promise<void>
  didClose(path: string): Promise<void>
  documentSymbols(path: string): Promise<LspSymbol[]>
  sandboxSymbols(query: string): Promise<LspSymbol[]>
  completions(path: string, position: LspPosition): Promise<LspCompletionList>
}

const LANGUAGES = {
  typescript: { extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] },
} as const

export type LspLanguage = keyof typeof LANGUAGES

export interface LspPosition {
  line: number
  character: number
}

export interface LspSymbol {
  name: string
  kind: number
  location: { uri: string; range: { start: LspPosition; end: LspPosition } }
}

export interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  sortText?: string
}

export interface LspCompletionList {
  isIncomplete: boolean
  items: LspCompletionItem[]
}

interface Entry {
  sandbox: Sandbox
  server: LspServer
  started?: Promise<void>
}

export class LspManager {
  private entries = new Map<string, Entry>()

  /** Language server for (language, root) on this sandbox, started on first use. */
  async getOrCreate(sandbox: Sandbox, language: LspLanguage, root: string): Promise<Entry> {
    const key = `${language}:${root}`
    let entry = this.entries.get(key)
    // A resumed session hands us a new Sandbox object; its toolbox client must be rebuilt.
    if (!entry || entry.sandbox !== sandbox) {
      entry = { sandbox, server: await sandbox.createLspServer(language, root) }
      this.entries.set(key, entry)
    }
    const e = entry
    e.started ??= withRecovery(sandbox, () => e.server.start()).catch((err) => {
      e.started = undefined
      throw new Error(`Language server failed to start (${language} @ ${root}): ${errorMessage(err)}`)
    })
    await e.started
    return e
  }

  status(sandbox: Sandbox, language: LspLanguage, root: string): 'not started' | 'started' {
    const entry = this.entries.get(`${language}:${root}`)
    return entry?.sandbox === sandbox && entry.started ? 'started' : 'not started'
  }

  async workspaceSymbols(
    sandbox: Sandbox,
    language: LspLanguage,
    root: string,
    query: string,
    path?: string,
  ): Promise<LspSymbol[]> {
    const entry = await this.getOrCreate(sandbox, language, root)
    return this.call(entry, async () => {
      // workspace/symbol fails with "No Project" unless a file of the project is open.
      const anchor = path ?? (await findAnchor(sandbox, language, root))
      return withDocument(entry.server, anchor, () => entry.server.sandboxSymbols(query))
    })
  }

  async documentSymbols(sandbox: Sandbox, language: LspLanguage, root: string, path: string): Promise<LspSymbol[]> {
    const entry = await this.getOrCreate(sandbox, language, root)
    return this.call(entry, () => withDocument(entry.server, path, () => entry.server.documentSymbols(path)))
  }

  async completions(
    sandbox: Sandbox,
    language: LspLanguage,
    root: string,
    path: string,
    position: LspPosition,
  ): Promise<LspCompletionList> {
    const entry = await this.getOrCreate(sandbox, language, root)
    return this.call(entry, () => withDocument(entry.server, path, () => entry.server.completions(path, position)))
  }

  /**
   * Run an LSP call, recovering once from a stopped sandbox (withRecovery) and
   * once from a language server the daemon no longer has.
   */
  private call<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
    return withRecovery(entry.sandbox, async () => {
      try {
        return await fn()
      } catch (err) {
        const message = errorMessage(err)
        if (message.includes('connection is closed')) {
          // The server process died but the daemon still reports it initialized,
          // so start() would be a no-op. stop() errors here yet drops the entry.
          await entry.server.stop().catch(() => undefined)
        } else if (!message.includes('server not initialized')) {
          throw err
        }
        try {
          await entry.server.start()
        } catch (startErr) {
          throw new Error(`Language server failed to start: ${errorMessage(startErr)}`)
        }
        return fn()
      }
    })
  }
}

/**
 * Open `path` from disk for the duration of `fn`. didOpen snapshots the file and
 * there is no didChange, so a document left open (by an earlier call or a previous
 * Pi session on the same sandbox) would serve stale content: close it first.
 */
async function withDocument<T>(server: LspServer, path: string, fn: () => Promise<T>): Promise<T> {
  await server.didClose(path)
  try {
    await server.didOpen(path)
  } catch (err) {
    if (errorMessage(err).includes('no such file or directory')) {
      throw new Error(`Requested file does not exist inside the sandbox: ${path}`)
    }
    throw err
  }
  try {
    return await fn()
  } finally {
    await server.didClose(path).catch(() => undefined)
  }
}

// ponytail: first source file (src/ preferred) anchors the search; in a monorepo only that
// file's tsconfig project is searched. Callers can pass `path` to pick another project.
async function findAnchor(sandbox: Sandbox, language: LspLanguage, root: string): Promise<string> {
  const names = LANGUAGES[language].extensions.map((ext) => `-name '*.${ext}'`).join(' -o ')
  const find = (dir: string) =>
    `find ${dir} -type f \\( ${names} \\) -not -name '*.d.ts' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`
  const res = await execCommand(sandbox, `{ ${find('src')}; ${find('.')}; } | head -n 1`, root)
  const rel = (res.result ?? '').trim().replace(/^\.\//, '')
  if (!rel) throw new Error(`Unable to determine project root: no ${language} source files under ${root}`)
  return joinPath(root, rel)
}

/** Language for a file path, or undefined if no configured server handles it. */
export function languageForPath(path: string): LspLanguage | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  for (const [language, { extensions }] of Object.entries(LANGUAGES)) {
    if ((extensions as readonly string[]).includes(ext)) return language as LspLanguage
  }
  return undefined
}

const SYMBOL_KINDS = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
  'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
  'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter',
]

const COMPLETION_KINDS = [
  '', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module',
  'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder',
  'enum member', 'constant', 'struct', 'event', 'operator', 'type parameter',
]

/** One line per symbol, 1-based `path:line:col`, paths relative to `root`. */
export function formatSymbols(symbols: LspSymbol[], root: string): string {
  if (symbols.length === 0) return 'No symbols found.'
  const prefix = `file://${root.replace(/\/+$/, '')}/`
  return symbols
    .map((s) => {
      const { line, character } = s.location.range.start
      const file = s.location.uri.startsWith(prefix) ? s.location.uri.slice(prefix.length) : s.location.uri.replace(/^file:\/\//, '')
      return { file, line, text: `${SYMBOL_KINDS[s.kind] ?? s.kind} ${s.name} — ${file}:${line + 1}:${character + 1}` }
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((s) => s.text)
    .join('\n')
}

// ponytail: fixed cap, the server returns every identifier in scope (1000+) unfiltered.
const MAX_COMPLETIONS = 100

export function formatCompletions(list: LspCompletionList): string {
  // Observed: empty for a few seconds after the project first loads, with no readiness signal from the API.
  if (list.items.length === 0) return 'No completions. If the language server just started, retry in a few seconds.'
  const items = [...list.items]
    .sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label))
    .slice(0, MAX_COMPLETIONS)
    .map((i) => `${i.label} (${COMPLETION_KINDS[i.kind ?? 0] || 'unknown'})${i.detail ? ` — ${i.detail}` : ''}`)
  const more = list.items.length > MAX_COMPLETIONS ? `\n… ${list.items.length - MAX_COMPLETIONS} more` : ''
  return items.join('\n') + more
}

/** Resolve a tool path against the sandbox working directory. */
export function resolvePath(cwd: string, path: string): string {
  return path.startsWith('/') ? path : joinPath(cwd, path)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
