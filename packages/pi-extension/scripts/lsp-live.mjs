/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live test for the `lsp` tool against a real Daytona sandbox, driven through
 * the registered Pi tools (bash/edit/lsp share one sandbox checkout):
 *   project root = bash's checkout, sandbox-only node_modules resolution,
 *   edits via the edit tool, sandbox stop/start, Pi resume (fresh client),
 *   and a killed language server process.
 *
 * Requires DAYTONA_API_KEY.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const { createJiti } = createRequire(hostEntry)('jiti')
const jiti = createJiti(import.meta.url)
const { Daytona } = await import('@daytona/sdk')
const { registerTools } = await jiti.import(path.join(root, 'src/tools.ts'))

function tools(active) {
  const map = new Map()
  registerTools({ registerTool: (t) => map.set(t.name, t), on: () => {}, getFlag: () => true }, () => active)
  return async (name, params) => {
    const res = await map.get(name).execute('id', params, undefined, () => {}, {})
    return res.content.map((c) => c.text).join('\n')
  }
}

const daytona = new Daytona()
const sandbox = await daytona.create({ labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 })
try {
  const home = (await sandbox.getUserHomeDir()) ?? '/home/daytona'
  const cwd = `${home}/proj`
  await sandbox.process.executeCommand(`mkdir -p ${cwd}`)
  let run = tools({ sandbox, cwd })

  // The project (incl. a dependency that exists only in the sandbox's node_modules) is created with bash.
  await run('bash', {
    command: [
      'mkdir -p src node_modules/sandbox-only-dep',
      `echo '{"compilerOptions":{"strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}' > tsconfig.json`,
      `echo '{"name":"sandbox-only-dep","types":"index.d.ts"}' > node_modules/sandbox-only-dep/package.json`,
      `printf 'export declare class Thing { sandboxOnlyMethod(): void }\\nexport declare function makeThing(): Thing\\n' > node_modules/sandbox-only-dep/index.d.ts`,
      `printf "import { makeThing } from 'sandbox-only-dep'\\nexport class UserRepository {}\\nmakeThing().\\n" > src/user.ts`,
    ].join(' && '),
  })

  assert.match(await run('lsp', { action: 'status' }), /not started/)
  assert.match(await run('lsp', { action: 'workspace_symbols', query: 'UserRepository' }), /class UserRepository — src\/user\.ts:2:1/)
  console.log('✓ project root is the checkout bash operates on')

  let completions = ''
  for (let i = 0; i < 10 && !/sandboxOnlyMethod/.test(completions); i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000))
    completions = await run('lsp', { action: 'completions', path: 'src/user.ts', line: 3, character: 13 })
  }
  assert.match(completions, /sandboxOnlyMethod/)
  console.log('✓ dependencies resolve from the sandbox node_modules')

  await run('edit', { path: 'src/user.ts', edits: [{ oldText: 'export class UserRepository {}', newText: 'export class UserRepository {}\nexport class AdminRepository {}' }] })
  assert.match(await run('lsp', { action: 'document_symbols', path: 'src/user.ts' }), /class AdminRepository — src\/user\.ts:3:1/)
  assert.match(await run('lsp', { action: 'workspace_symbols', query: 'AdminRepository' }), /AdminRepository/)
  console.log('✓ edits made with the edit tool are visible to the next query')

  await sandbox.stop()
  assert.match(await run('lsp', { action: 'workspace_symbols', query: 'AdminRepository' }), /AdminRepository/)
  console.log('✓ stopped sandbox: restarted and the language server re-initialized')

  // Pi resume: new process → new Daytona client, Sandbox object and tool registration.
  const resumed = await new Daytona().get(sandbox.id)
  run = tools({ sandbox: resumed, cwd })
  await run('bash', { command: `printf 'export class ResumedThing {}\\n' >> src/user.ts` })
  assert.match(await run('lsp', { action: 'document_symbols', path: 'src/user.ts' }), /ResumedThing/)
  console.log('✓ resumed session: fresh client against the reattached sandbox, current file content')

  await run('bash', { command: 'pkill -f typescript-language-server; pkill -f tsserver; true' })
  assert.match(await run('lsp', { action: 'workspace_symbols', query: 'UserRepository' }), /UserRepository/)
  console.log('✓ killed language server process is recreated')

  await assert.rejects(run('lsp', { action: 'document_symbols', path: 'src/missing.ts' }), /does not exist inside the sandbox/)
  console.log('✓ missing file reported as a sandbox path')
} finally {
  await sandbox.delete().catch(() => undefined)
}

console.log('\nlsp live test passed.')
