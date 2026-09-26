/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A long-lived sandbox process as a bidirectional byte stream, over Daytona's
 * PTY API (the session API line-buffers output and appends "\n" to input, so it
 * can't carry arbitrary protocols). Protocol-agnostic.
 *
 * The PTY runs an interactive login shell. We put the terminal into raw mode
 * (no echo, no line discipline, no CR/LF translation, no signal chars) and then
 * `exec` the command, discarding everything printed before a sentinel.
 * stderr can't be separated on a PTY, so it goes to a file.
 * See docs/lsp-research.md §2 for the measurements behind each rule.
 */

import { randomBytes } from 'node:crypto'
import type { PtyHandle, Sandbox } from '@daytona/sdk'

export interface RemoteProcess {
  readonly id: string
  /** Bytes the process writes to stdout. Ends when the process exits, is killed, or the connection drops. */
  readonly stdout: AsyncIterable<Uint8Array>
  /** Writes are queued: concurrent calls never interleave. Rejects once the process is gone. */
  write(data: Uint8Array | string): Promise<void>
  /** Kill the process and release the connection (no timers or sockets are left behind). */
  kill(): Promise<void>
  isConnected(): boolean
}

export interface SpawnOptions {
  /** PTY session id; also how orphans are found again (see killRemoteProcesses). */
  id: string
  cwd?: string
  env?: Record<string, string>
  stderrPath?: string
  readyTimeoutMs?: number
}

// A single WebSocket message of 256 KiB drops the PTY connection; 64 KiB is delivered.
const WRITE_CHUNK = 64 * 1024

/** Spawn `command` (a shell command line) in the sandbox. */
export async function spawnRemoteProcess(sandbox: Sandbox, command: string, options: SpawnOptions): Promise<RemoteProcess> {
  const { id, cwd, env, stderrPath = '/dev/null', readyTimeoutMs = 30_000 } = options
  const sentinel = `__pi_ready_${randomBytes(6).toString('hex')}__`
  const stdout = byteQueue()
  let pending: Buffer = Buffer.alloc(0)
  let started = false
  const ready = Promise.withResolvers<void>()

  const pty = await sandbox.process.createPty({
    id,
    cwd,
    envs: env,
    onData: (data) => {
      const chunk = Buffer.from(data)
      if (started) return stdout.push(chunk)
      pending = Buffer.concat([pending, chunk])
      const at = pending.indexOf(sentinel)
      if (at < 0) return
      started = true
      ready.resolve()
      const rest = pending.subarray(at + sentinel.length)
      pending = Buffer.alloc(0)
      if (rest.length) stdout.push(rest)
    },
  })
  try {
    await pty.waitForConnection()
    // Printed from two halves: the shell echoes the typed line, which must not match.
    const half = sentinel.length >> 1
    await pty.sendInput(
      `stty raw -echo && printf '%s%s' '${sentinel.slice(0, half)}' '${sentinel.slice(half)}' && exec ${command} 2>${stderrPath}\n`,
    )
    await withTimeout(ready.promise, readyTimeoutMs, `remote process did not start within ${readyTimeoutMs}ms: ${command}`)
  } catch (err) {
    await pty.kill().catch(() => undefined)
    await pty.disconnect().catch(() => undefined)
    throw err
  }
  return wrap(pty, stdout, id)
}

/** Kill PTY sessions whose id starts with `prefix` (processes left behind by an earlier Pi run). */
export async function killRemoteProcesses(sandbox: Sandbox, prefix: string): Promise<void> {
  const sessions = await sandbox.process.listPtySessions()
  await Promise.allSettled(sessions.filter((s) => s.id.startsWith(prefix)).map((s) => sandbox.process.killPtySession(s.id)))
}

// The SDK's PtyHandle.wait() polls until an exit code arrives, which never happens when the
// connection just drops (sandbox stop), so it would keep a timer alive forever. Watch the
// connection instead.
const MONITOR_INTERVAL_MS = 250

function wrap(pty: PtyHandle, stdout: ByteQueue, id: string): RemoteProcess {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(monitor)
    stdout.end()
  }
  const monitor = setInterval(() => {
    if (!pty.isConnected()) close()
  }, MONITOR_INTERVAL_MS)
  monitor.unref()
  let queue: Promise<void> = Promise.resolve()
  return {
    id,
    stdout,
    write(data) {
      if (closed) return Promise.reject(new Error(`remote process ${id} is not connected`))
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      const sent = queue.then(async () => {
        for (let i = 0; i < bytes.length; i += WRITE_CHUNK) {
          if (closed) throw new Error(`remote process ${id} is not connected`)
          await pty.sendInput(bytes.subarray(i, i + WRITE_CHUNK))
        }
      })
      queue = sent.catch(() => undefined)
      return sent
    },
    async kill() {
      try {
        await pty.kill()
      } finally {
        close()
        await pty.disconnect().catch(() => undefined)
      }
    },
    isConnected: () => !closed && pty.isConnected(),
  }
}

interface ByteQueue extends AsyncIterable<Uint8Array> {
  push(chunk: Uint8Array): void
  end(): void
}

/** Single-consumer async queue of byte chunks. */
function byteQueue(): ByteQueue {
  const chunks: Uint8Array[] = []
  let wake: (() => void) | undefined
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
        while (chunks.length) yield chunks.shift()!
        if (ended) return
        const next = Promise.withResolvers<void>()
        wake = next.resolve
        await next.promise
        wake = undefined
      }
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(message)), ms)
  return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer))
}
