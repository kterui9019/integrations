/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Minimal LSP JSON-RPC client over any byte stream. Transport-agnostic. */

export interface ByteStream {
  stdout: AsyncIterable<Uint8Array>
  write(data: Uint8Array): Promise<void>
}

export interface LspNotification {
  method: string
  params: unknown
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

export class LspConnectionClosedError extends Error {}

export class LspClient {
  private nextId = 1
  private pending = new Map<number | string, Pending>()
  private listeners = new Set<(n: LspNotification) => void>()
  private closedError: Error | undefined

  constructor(
    private readonly stream: ByteStream,
    private readonly requestTimeoutMs = 60_000,
  ) {
    void this.readLoop()
  }

  get closed(): boolean {
    return this.closedError !== undefined
  }

  request<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`${method}: no response within ${timeoutMs}ms`))
    }, timeoutMs)
    // The server's result shape is the caller's contract for `method`.
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

  onNotification(listener: (n: LspNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private send(msg: Message): Promise<void> {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8')
    return this.stream.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  private dispatch(msg: Message): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const req = this.pending.get(msg.id)
      if (!req) return
      this.pending.delete(msg.id)
      clearTimeout(req.timer)
      if (msg.error) req.reject(new Error(`${req.method}: ${msg.error.message}`))
      else req.resolve(msg.result)
      return
    }
    if (msg.id !== undefined) {
      // Server → client request: answer so the server never waits on us.
      const items = msg.method === 'workspace/configuration' && isObject(msg.params) && Array.isArray(msg.params.items) ? msg.params.items : undefined
      const result = items ? items.map(() => null) : null
      void this.send({ id: msg.id, result }).catch(() => undefined)
      return
    }
    for (const listener of this.listeners) listener({ method: msg.method!, params: msg.params })
  }

  private async readLoop(): Promise<void> {
    let buf: Buffer = Buffer.alloc(0)
    try {
      for await (const chunk of this.stream.stdout) {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          const headerEnd = buf.indexOf('\r\n\r\n')
          if (headerEnd < 0) break
          const header = buf.subarray(0, headerEnd).toString('ascii')
          const match = /Content-Length: *(\d+)/i.exec(header)
          if (!match) throw new Error(`invalid LSP header: ${JSON.stringify(header)}`)
          const start = headerEnd + 4
          const end = start + Number(match[1])
          if (buf.length < end) break
          this.dispatch(JSON.parse(buf.subarray(start, end).toString('utf8')) as Message)
          buf = buf.subarray(end)
        }
      }
      this.closedError = new LspConnectionClosedError('language server connection closed')
    } catch (err) {
      this.closedError = new LspConnectionClosedError(`language server stream failed: ${err instanceof Error ? err.message : err}`)
    }
    for (const req of this.pending.values()) {
      clearTimeout(req.timer)
      req.reject(this.closedError)
    }
    this.pending.clear()
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
