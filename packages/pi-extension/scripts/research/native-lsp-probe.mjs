/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Research: observed behavior of Daytona's native LSP API (sandbox.createLspServer).
 * Every assertion pins a finding recorded in docs/lsp-research.md; a failure means
 * Daytona changed behavior and the note needs revisiting.
 *
 * Requires DAYTONA_API_KEY. Run: node scripts/research/native-lsp-probe.mjs
 */

import assert from 'node:assert/strict'
import { Daytona } from '@daytona/sdk'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const names = (symbols) => symbols.map((s) => s.name).sort()
const rejects = (p, re) => assert.rejects(p, re)

const daytona = new Daytona()
const sandbox = await daytona.create({ labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 })
const watchdog = setTimeout(async () => {
  console.error('FAIL: watchdog')
  await sandbox.delete().catch(() => undefined)
  process.exit(1)
}, 300_000)
let exitCode = 0
try {
  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona'
  const root = `${home}/proj`
  const user = `${root}/src/user.ts`
  await sandbox.process.executeCommand(`mkdir -p ${root}/src`)
  await sandbox.fs.uploadFile(Buffer.from('{"compilerOptions":{"strict":true},"include":["src"]}'), `${root}/tsconfig.json`)
  await sandbox.fs.uploadFile(Buffer.from('export class UserRepository {}\n'), user)
  await sandbox.fs.uploadFile(Buffer.from("import { UserRepository } from './user'\n"), `${root}/src/main.ts`)

  const lsp = await sandbox.createLspServer('typescript', root)
  for (const method of ['definition', 'references', 'hover', 'diagnostics', 'rename', 'didChange']) {
    assert.equal(typeof lsp[method], 'undefined')
  }
  console.log('✓ SDK LspServer has no definition/references/hover/diagnostics/rename/didChange')

  await rejects(lsp.sandboxSymbols('UserRepository'), /server not initialized/)
  await lsp.start()
  await lsp.start()
  console.log('✓ before start(): "server not initialized"; start() is idempotent')

  await rejects(lsp.sandboxSymbols('UserRepository'), /No Project/)
  assert.deepEqual(await lsp.documentSymbols(user), [])
  assert.deepEqual(await lsp.documentSymbols('src/user.ts'), [])
  console.log('✓ nothing open: workspace symbols fail with "No Project"; documentSymbols silently [] (also for relative paths)')

  await lsp.didOpen(user)
  assert.deepEqual(names(await lsp.documentSymbols(user)), ['UserRepository'])
  await rejects(lsp.didOpen(`${root}/src/nope.ts`), /no such file or directory/)
  console.log('✓ didOpen reads the file from disk; missing file → "no such file or directory"')

  await sandbox.fs.uploadFile(Buffer.from('export class UserRepository {}\nexport class AdminRepository {}\n'), user)
  await lsp.didOpen(user)
  assert.deepEqual(names(await lsp.documentSymbols(user)), ['UserRepository'])
  await lsp.didClose(user)
  await lsp.didOpen(user)
  assert.deepEqual(names(await lsp.documentSymbols(user)), ['AdminRepository', 'UserRepository'])
  console.log('✓ open document is stale after an edit, re-didOpen is ignored; didClose + didOpen refreshes it')

  await sandbox.fs.uploadFile(Buffer.from('export class Watched {}\n'), `${root}/src/new.ts`)
  let found = []
  for (let i = 0; i < 20 && found.length === 0; i++) {
    await sleep(500)
    found = await lsp.sandboxSymbols('Watched')
  }
  assert.deepEqual(names(found), ['Watched'])
  console.log('✓ files that are not open are picked up by tsserver file watching (after a delay)')

  // A fresh handle talks to the same daemon-side server (Pi resume on a running sandbox).
  const again = await (await daytona.get(sandbox.id)).createLspServer('typescript', root)
  assert.deepEqual(names(await again.sandboxSymbols('UserRepository')), ['UserRepository'])
  console.log('✓ server state lives in the daemon and is shared across client handles')

  await sandbox.process.executeCommand('pkill -f typescript-language-server; pkill -f tsserver; true')
  await sleep(1000)
  await rejects(lsp.sandboxSymbols('UserRepository'), /connection is closed/)
  await lsp.start()
  await rejects(lsp.sandboxSymbols('UserRepository'), /connection is closed/)
  await rejects(lsp.stop(), /error stopping LSP server/)
  await lsp.start()
  await lsp.didOpen(user)
  assert.deepEqual(names(await lsp.sandboxSymbols('UserRepository')), ['UserRepository'])
  console.log('✓ dead server process: "connection is closed", start() is a no-op, stop() errors but resets, then start() works')

  await lsp.stop()
  await sleep(1000)
  const alive = (await sandbox.process.executeCommand('pgrep -f typescript-language-server | wc -l')).result.trim()
  assert.notEqual(alive, '0')
  console.log(`✓ stop() leaves the language server process running (${alive} alive)`)

  await lsp.start()
  await sandbox.stop()
  await sandbox.start()
  await rejects(lsp.sandboxSymbols('UserRepository'), /server not initialized/)
  await lsp.start()
  await rejects(lsp.sandboxSymbols('UserRepository'), /No Project/)
  console.log('✓ sandbox stop/start: server gone ("server not initialized"); after start() documents must be reopened')
} catch (err) {
  exitCode = 1
  console.error('FAIL:', err)
} finally {
  clearTimeout(watchdog)
  await sandbox.delete().catch(() => undefined)
}
console.log(exitCode ? '\nnative LSP probe FAILED' : '\nnative LSP probe passed.')
process.exit(exitCode)
