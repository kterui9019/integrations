/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Research: can a long-lived sandbox process be driven over a bidirectional
 * byte stream with existing Daytona APIs? Uses the PTY transport
 * (pty-process.mjs) and a transport-agnostic LSP client (lsp-client.mjs):
 *   1. echo round trips on one process
 *   2. typescript-language-server --stdio: initialize, didOpen, definition,
 *      references, hover, publishDiagnostics
 *   3. edits through the extension's Daytona edit tool + didChange
 *   4. sandbox stop/start: detect the dead handle, respawn, re-initialize, reopen
 *
 * Requires DAYTONA_API_KEY. Run: node scripts/research/remote-process-lsp.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLspClient } from './lsp-client.mjs'
import { attachPtyProcess, spawnPtyProcess } from './pty-process.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url)
const { Daytona } = await import('@daytona/sdk')
const { createEditTool } = await import('@earendil-works/pi-coding-agent')
const { createEditOps } = await jiti.import(path.join(root, 'src/ops.ts'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timed = async (fn) => {
  const t = Date.now()
  const value = await fn()
  return [value, Date.now() - t]
}

const daytona = new Daytona()
const sandbox = await daytona.create({ labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 })
let exitCode = 0
const watchdog = setTimeout(async () => {
  console.error('FAIL: watchdog (a step hung)')
  await sandbox.delete().catch(() => undefined)
  process.exit(1)
}, 300_000)
try {
  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona'
  const cwd = `${home}/proj`
  const uri = (rel) => `file://${cwd}/${rel}`
  const readFile = async (rel) => (await sandbox.fs.downloadFile(`${cwd}/${rel}`)).toString('utf8')
  await sandbox.process.executeCommand(`mkdir -p ${cwd}/src`)
  await sandbox.fs.uploadFile(Buffer.from('{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}'), `${cwd}/tsconfig.json`)
  await sandbox.fs.uploadFile(Buffer.from('export class UserRepository {\n  findUser(id: string): string {\n    return id\n  }\n}\n'), `${cwd}/src/user.ts`)
  await sandbox.fs.uploadFile(Buffer.from("import { UserRepository } from './user'\nconst repo = new UserRepository()\nrepo.findUser('a')\nconst n: number = 'oops'\nexport { n }\n"), `${cwd}/src/main.ts`)

  // --- 1. echo: several round trips on the same process ---
  {
    const proc = await spawnPtyProcess(sandbox, 'cat', { cwd })
    const reader = proc.stdout[Symbol.asyncIterator]()
    for (const msg of ['one', 'two', 'three\r\n', `${'x'.repeat(1_000_000)}日本語`]) {
      const expected = Buffer.from(msg, 'utf8')
      const [got, ms] = await timed(async () => {
        await proc.write(msg)
        let out = Buffer.alloc(0)
        while (out.length < expected.length) out = Buffer.concat([out, (await reader.next()).value])
        return out
      })
      assert.ok(got.equals(expected))
      console.log(`✓ echo ${JSON.stringify(msg.length > 20 ? `${msg.length} bytes` : msg)} round trip ${ms}ms, byte-exact`)
    }
    await proc.kill()
    assert.equal(await proc.wait(), 137)
    console.log('✓ kill() terminates the process (exit 137)')
  }

  // --- 2. typescript-language-server over the same transport ---
  const docs = new Map() // uri -> { version, text }: what must be reopened after a respawn
  async function startLsp() {
    const proc = await spawnPtyProcess(sandbox, 'typescript-language-server --stdio', { cwd, stderrPath: '/tmp/tsls.err' })
    const lsp = createLspClient(proc, { requestTimeoutMs: 20000 })
    const [init, ms] = await timed(() =>
      lsp.request('initialize', {
        processId: null,
        rootUri: `file://${cwd}`,
        capabilities: { textDocument: { hover: { contentFormat: ['plaintext'] }, publishDiagnostics: { versionSupport: true } } },
      }),
    )
    await lsp.notify('initialized', {})
    return { proc, lsp, init, ms }
  }
  async function open(lsp, rel) {
    const text = await readFile(rel)
    docs.set(uri(rel), { version: 1, text })
    await lsp.notify('textDocument/didOpen', { textDocument: { uri: uri(rel), languageId: 'typescript', version: 1, text } })
  }
  const diagnosticsFor = (lsp, rel, predicate) =>
    lsp.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri(rel) && predicate(p.diagnostics))
  const codes = (diags) => diags.map((d) => d.code)

  let { proc, lsp, init, ms } = await startLsp()
  assert.ok(init.capabilities.definitionProvider && init.capabilities.referencesProvider && init.capabilities.hoverProvider)
  console.log(`✓ initialize → ${Object.keys(init.capabilities).length} capabilities, round trip ${ms}ms (definition, references, hover, rename=${!!init.capabilities.renameProvider})`)

  const firstDiags = diagnosticsFor(lsp, 'src/main.ts', (d) => d.length > 0)
  await open(lsp, 'src/user.ts')
  await open(lsp, 'src/main.ts')
  assert.deepEqual(codes((await firstDiags).diagnostics), [2322])
  console.log('✓ publishDiagnostics (server → client) received: TS2322 in main.ts')

  const defPos = { textDocument: { uri: uri('src/main.ts') }, position: { line: 1, character: 17 } }
  let [def, defMs] = await timed(() => lsp.request('textDocument/definition', defPos))
  assert.equal(def[0].uri, uri('src/user.ts'))
  assert.equal(def[0].range.start.line, 0)
  console.log(`✓ definition main.ts:2 UserRepository → user.ts:${def[0].range.start.line + 1} (${defMs}ms)`)

  const refs = await lsp.request('textDocument/references', {
    textDocument: { uri: uri('src/user.ts') },
    position: { line: 1, character: 2 },
    context: { includeDeclaration: true },
  })
  assert.deepEqual(refs.map((r) => `${r.uri.split('/').pop()}:${r.range.start.line}`).sort(), ['main.ts:2', 'user.ts:1'])
  console.log('✓ references findUser → user.ts:2, main.ts:3')

  const hover = await lsp.request('textDocument/hover', { textDocument: { uri: uri('src/main.ts') }, position: { line: 2, character: 1 } })
  const hoverText = JSON.stringify(hover.contents)
  assert.match(hoverText, /const repo: UserRepository/)
  console.log(`✓ hover repo → ${hoverText.slice(0, 60)}`)

  // --- 3. edits through the Daytona edit tool, then didChange ---
  const edit = createEditTool(cwd, { operations: createEditOps(sandbox) })
  await edit.execute('e1', {
    path: 'src/user.ts',
    edits: [
      { oldText: 'export class UserRepository {', newText: 'export const VERSION = 1\nexport class UserRepository {' },
      { oldText: 'findUser(id', newText: 'getUser(id' },
    ],
  })
  ;[def] = await timed(() => lsp.request('textDocument/definition', defPos))
  assert.equal(def[0].range.start.line, 0, 'open documents are owned by the client until didChange')
  console.log('✓ after the edit tool writes user.ts, the server still has the old open buffer (needs didChange)')

  async function change(rel) {
    const doc = docs.get(uri(rel))
    doc.version++
    doc.text = await readFile(rel)
    await lsp.notify('textDocument/didChange', { textDocument: { uri: uri(rel), version: doc.version }, contentChanges: [{ text: doc.text }] })
  }
  const crossFile = diagnosticsFor(lsp, 'src/main.ts', (d) => codes(d).includes(2339))
  await change('src/user.ts')
  assert.deepEqual(codes((await crossFile).diagnostics).sort(), [2322, 2339])
  console.log('✓ didChange user.ts v2 → main.ts diagnostics now include TS2339 (findUser renamed)')
  ;[def] = await timed(() => lsp.request('textDocument/definition', defPos))
  assert.equal(def[0].range.start.line, 1)
  console.log('✓ definition follows the edit → user.ts:2')

  await edit.execute('e2', {
    path: 'src/main.ts',
    edits: [
      { oldText: "repo.findUser('a')", newText: "repo.getUser('a')" },
      { oldText: "const n: number = 'oops'", newText: 'const n: number = 1' },
    ],
  })
  const clean = diagnosticsFor(lsp, 'src/main.ts', (d) => d.length === 0)
  await change('src/main.ts')
  const cleanParams = await clean
  console.log(`✓ didChange main.ts v2 → diagnostics cleared (version in notification: ${cleanParams.version ?? 'not sent'})`)

  // --- Pi exits / resumes while the sandbox keeps running ---
  await proc.disconnect()
  assert.ok((await sandbox.process.listPtySessions()).some((p) => p.id === proc.id))
  proc = await attachPtyProcess(sandbox, proc.id)
  lsp = createLspClient(proc, { requestTimeoutMs: 20000 })
  ;[def] = await timed(() => lsp.request('textDocument/definition', defPos))
  assert.equal(def[0].range.start.line, 1)
  console.log('✓ client disconnect leaves the process running (listPtySessions); connectPty reattaches with server state intact')

  // --- 4. sandbox stop / start ---
  const [, stopMs] = await timed(() => sandbox.stop())
  let detectedMs = -1
  for (let t = 0; t < 30000; t += 250) {
    if (!proc.isConnected()) {
      detectedMs = t
      break
    }
    await sleep(250)
  }
  console.log(`  sandbox.stop() took ${stopMs}ms; PTY handle isConnected()=false after ${detectedMs < 0 ? '>30000' : detectedMs}ms`)
  await assert.rejects(lsp.request('textDocument/definition', defPos, 5000), /timed out|ended|not connected/i)
  console.log('✓ the old process handle is dead after a sandbox stop (request fails)')

  await sandbox.start()
  await assert.rejects(proc.write('x'), /not connected/i)
  ;({ proc, lsp, ms } = await startLsp())
  const reopened = diagnosticsFor(lsp, 'src/main.ts', () => true)
  for (const [docUri] of docs) await open(lsp, docUri.slice(`file://${cwd}/`.length))
  assert.deepEqual((await reopened).diagnostics, [])
  ;[def] = await timed(() => lsp.request('textDocument/definition', defPos))
  assert.equal(def[0].range.start.line, 1)
  console.log(`✓ after restart: respawn + initialize (${ms}ms) + reopen ${docs.size} docs from disk → definition/diagnostics current`)

  await proc.kill()
} catch (err) {
  exitCode = 1
  console.error('FAIL:', err)
} finally {
  await sandbox.delete().catch(() => undefined)
}
console.log(exitCode ? '\nremote-process research FAILED' : '\nremote-process research passed.')
// PTY WebSockets of the dead sandbox never close on their own.
process.exit(exitCode)
