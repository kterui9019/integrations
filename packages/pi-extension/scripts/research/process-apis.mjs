/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Research: can Daytona's process APIs carry a byte-exact bidirectional stream?
 * Compares the session API (runAsync + sendSessionCommandInput + streamed logs)
 * with the PTY API. Assertions pin the findings in docs/lsp-research.md.
 *
 * Requires DAYTONA_API_KEY. Run: node scripts/research/process-apis.mjs
 */

import assert from 'node:assert/strict'
import { Daytona } from '@daytona/sdk'
import { spawnPtyProcess } from './pty-process.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const daytona = new Daytona()
const sandbox = await daytona.create({ labels: { 'created-by': 'pi-daytona-test' }, autoDeleteInterval: 60 })
const watchdog = setTimeout(async () => {
  console.error('FAIL: watchdog')
  await sandbox.delete().catch(() => undefined)
  process.exit(1)
}, 300_000)

/** Run `command` as an async session command; collect streamed stdout/stderr with timestamps. */
async function sessionCommand(command, { echo = false } = {}) {
  const sessionId = `probe-${Math.random().toString(36).slice(2, 8)}`
  await sandbox.process.createSession(sessionId)
  const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true, suppressInputEcho: !echo })
  const start = Date.now()
  const out = []
  const err = []
  void sandbox.process
    .getSessionCommandLogs(sessionId, cmdId, (s) => out.push([Date.now() - start, s]), (s) => err.push([Date.now() - start, s]))
    .catch(() => undefined)
  await sleep(500)
  return { sessionId, send: (data) => sandbox.process.sendSessionCommandInput(sessionId, cmdId, data), out, err, text: () => out.map(([, s]) => s).join('') }
}

let exitCode = 0
try {
  // --- session API ---
  {
    const cat = await sessionCommand('cat')
    await cat.send('one')
    await sleep(1000)
    assert.equal(cat.text(), 'one\n')
    const bytes = await sessionCommand('head -c 2 | od -An -tx1')
    await bytes.send('a')
    await sleep(1500)
    assert.match(bytes.text(), /61 0a/)
    console.log('✓ session: stdin works, but sendSessionCommandInput appends "\\n" to every write ("a" → 61 0a)')

    const partial = await sessionCommand("printf 'abc'; sleep 3; printf 'def\\n'")
    await sleep(4000)
    assert.ok(partial.out.length > 0 && partial.out[0][0] >= 2000, `first chunk at ${partial.out[0]?.[0]}ms`)
    assert.equal(partial.out[0][1], 'abcdef\n')
    console.log(`✓ session: stdout is line-buffered by the daemon's labeler ("abc" held ${partial.out[0][0]}ms until "\\n")`)

    const echoed = await sessionCommand('cat', { echo: true })
    await echoed.send('hi')
    await sleep(1000)
    assert.equal(echoed.text(), 'hi\nhi\n')
    console.log('✓ session: without suppressInputEcho, input is echoed into stdout')

    const streams = await sessionCommand('echo to-stdout; echo to-stderr >&2')
    await sleep(1000)
    assert.equal(streams.text(), 'to-stdout\n')
    assert.equal(streams.err.map(([, s]) => s).join(''), 'to-stderr\n')
    console.log('✓ session: stderr is a separate stream')

    const long = await sessionCommand('sleep 1000')
    await sandbox.process.deleteSession(long.sessionId)
    await sleep(500)
    assert.equal((await sandbox.process.executeCommand('pgrep -f "sleep 1000" | wc -l')).result.trim(), '0')
    console.log('✓ session: deleteSession kills the process tree')
  }

  // --- PTY API ---
  {
    const chunks = []
    const pty = await sandbox.process.createPty({ id: 'probe-raw', onData: (d) => chunks.push(Buffer.from(d).toString('latin1')) })
    await pty.waitForConnection()
    // Printed from two halves: the shell echoes the typed command line, so a literal marker would match early.
    await pty.sendInput(`stty raw -echo; printf '%s%s' '--MA' 'RK--'; exec sh -c 'echo to-stdout; echo to-stderr >&2'\n`)
    await pty.wait()
    const [before, after] = chunks.join('').split('--MARK--')
    assert.match(before, /stty raw -echo/)
    assert.equal(after, 'to-stdout\nto-stderr\n')
    console.log('✓ pty: interactive shell noise (prompt, echoed command) precedes the process; stdout and stderr are one stream')

    const cat = await spawnPtyProcess(sandbox, 'cat')
    const reader = cat.stdout[Symbol.asyncIterator]()
    for (const msg of ['one', 'no-newline', 'crlf\r\n', '\x03ctrl-c']) {
      await cat.write(msg)
      let got = ''
      while (got.length < msg.length) got += Buffer.from((await reader.next()).value).toString('latin1')
      assert.equal(got, msg)
    }
    console.log('✓ pty (raw -echo): byte-exact both ways — no appended newline, no CR/LF translation, no signal chars')
    await cat.kill()

    await sandbox.fs.uploadFile(Buffer.from('test -t 0 && i=tty || i=pipe; test -t 1 && o=tty || o=pipe; echo "stdin=$i stdout=$o"\n'), '/tmp/isatty.sh')
    const firstLine = async (proc) => {
      const it = proc.stdout[Symbol.asyncIterator]()
      let s = ''
      while (!s.includes('\n')) s += Buffer.from((await it.next()).value).toString()
      return s.trim()
    }
    assert.equal(await firstLine(await spawnPtyProcess(sandbox, 'sh /tmp/isatty.sh')), 'stdin=tty stdout=tty')
    assert.equal(await firstLine(await spawnPtyProcess(sandbox, `sh -c 'cat | sh /tmp/isatty.sh | cat'`)), 'stdin=pipe stdout=pipe')
    console.log('✓ pty: the child sees a TTY; wrapping it as `cat | cmd | cat` gives it pipes')

    const raw = await sandbox.process.createPty({ id: 'probe-big', onData: () => {} })
    await raw.waitForConnection()
    await raw.sendInput(`stty raw -echo; exec cat > /dev/null\n`)
    await sleep(1000)
    await raw.sendInput(Buffer.alloc(64 * 1024, 0x61))
    await sleep(1000)
    assert.ok(raw.isConnected())
    await raw.sendInput(Buffer.alloc(256 * 1024, 0x61)).catch(() => undefined)
    for (let i = 0; i < 20 && raw.isConnected(); i++) await sleep(500)
    assert.ok(!raw.isConnected())
    console.log('✓ pty: a single 64 KiB message is delivered; a single 256 KiB message drops the connection (writes must be chunked)')
  }

  // --- sandbox restart ---
  {
    const survivor = await sessionCommand('cat')
    const pty = await spawnPtyProcess(sandbox, 'cat')
    await sandbox.stop()
    assert.ok(!pty.isConnected())
    await sandbox.start()
    await assert.rejects(survivor.send('x'), /session not found/)
    assert.deepEqual(await sandbox.process.listPtySessions(), [])
    console.log('✓ restart: session commands and PTYs are gone; the PTY handle reports disconnected immediately')
  }
} catch (err) {
  exitCode = 1
  console.error('FAIL:', err)
} finally {
  clearTimeout(watchdog)
  await sandbox.delete().catch(() => undefined)
}
console.log(exitCode ? '\nprocess API research FAILED' : '\nprocess API research passed.')
process.exit(exitCode)
