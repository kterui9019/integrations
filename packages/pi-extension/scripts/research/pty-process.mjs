/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Research PoC: a long-lived sandbox process as a byte stream, built on the
 * Daytona PTY API. Knows nothing about LSP.
 *
 * The PTY runs an interactive login shell, so the terminal is put into raw
 * mode (no echo, no line discipline, no CR/LF translation, no signal chars)
 * before `exec`-ing the command. Everything the shell prints before that
 * (prompt, echoed command line) is discarded up to a sentinel.
 */

import { randomBytes } from 'node:crypto'

/** Minimal single-consumer async byte queue. */
function byteStream() {
  const chunks = []
  let wake
  let ended = false
  return {
    push(chunk) {
      chunks.push(chunk)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (chunks.length) yield chunks.shift()
        if (ended) return
        await new Promise((resolve) => (wake = resolve))
        wake = undefined
      }
    },
  }
}

/**
 * Spawn `command` (a shell command line) in the sandbox.
 * stderr cannot be separated on a PTY; it is redirected to `stderrPath`.
 */
export async function spawnPtyProcess(sandbox, command, { cwd, env, stderrPath = '/dev/null', readyTimeoutMs = 20000 } = {}) {
  const nonce = randomBytes(6).toString('hex')
  const sentinel = `__pi_ready_${nonce}__`
  const stdout = byteStream()
  let pending = Buffer.alloc(0)
  let started = false
  let markReady
  const ready = new Promise((resolve) => (markReady = resolve))

  const pty = await sandbox.process.createPty({
    id: `pi-rp-${nonce}`,
    cwd,
    envs: env,
    onData: (data) => {
      const chunk = Buffer.from(data)
      if (started) return stdout.push(chunk)
      pending = Buffer.concat([pending, chunk])
      const at = pending.indexOf(sentinel)
      if (at < 0) return
      started = true
      markReady()
      const rest = pending.subarray(at + sentinel.length)
      pending = Buffer.alloc(0)
      if (rest.length) stdout.push(rest)
    },
  })
  await pty.waitForConnection()
  // The sentinel is printed from two halves so the shell's echo of this line can't match it.
  const half = sentinel.length >> 1
  await pty.sendInput(
    `stty raw -echo && printf '%s%s' '${sentinel.slice(0, half)}' '${sentinel.slice(half)}' && exec ${command} 2>${stderrPath}\n`,
  )
  let timer
  await Promise.race([
    ready,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`remote process did not start: ${command}`)), readyTimeoutMs))),
  ]).finally(() => clearTimeout(timer))

  return wrap(pty, stdout, `pi-rp-${nonce}`)
}

/** Reattach to a process spawned by an earlier client (the PTY is already raw). */
export async function attachPtyProcess(sandbox, id) {
  const stdout = byteStream()
  const pty = await sandbox.process.connectPty(id, { onData: (data) => stdout.push(Buffer.from(data)) })
  await pty.waitForConnection()
  return wrap(pty, stdout, id)
}

// A single WebSocket message of 256 KiB drops the PTY connection; 64 KiB is delivered.
const WRITE_CHUNK = 64 * 1024

function wrap(pty, stdout, id) {
  const exited = pty.wait().finally(() => stdout.end())
  // Each write is chunked, so whole writes are queued to keep one write's chunks contiguous.
  let queue = Promise.resolve()
  return {
    id,
    stdout,
    write(data) {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      const sent = queue.then(async () => {
        for (let i = 0; i < bytes.length; i += WRITE_CHUNK) await pty.sendInput(bytes.subarray(i, i + WRITE_CHUNK))
      })
      queue = sent.catch(() => undefined)
      return sent
    },
    kill: () => pty.kill(),
    wait: async () => (await exited).exitCode,
    isConnected: () => pty.isConnected(),
    disconnect: () => pty.disconnect(),
  }
}
