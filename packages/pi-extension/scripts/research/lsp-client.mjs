/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Research PoC: minimal LSP JSON-RPC client over any byte stream
 * (`{ stdout: AsyncIterable<Uint8Array>, write(bytes) }`). Knows nothing about Daytona.
 */

export function createLspClient(proc, { requestTimeoutMs = 30000 } = {}) {
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()
  let closedError

  const send = (msg) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8')
    return proc.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  const dispatch = (msg) => {
    if (msg.id !== undefined && msg.method === undefined) {
      const req = pending.get(msg.id)
      if (!req) return
      pending.delete(msg.id)
      clearTimeout(req.timer)
      if (msg.error) req.reject(new Error(`${req.method}: ${msg.error.message}`))
      else req.resolve(msg.result)
      return
    }
    if (msg.id !== undefined) {
      // Server → client request. Answer so the server never blocks on us.
      const result = msg.method === 'workspace/configuration' ? msg.params.items.map(() => null) : null
      void send({ id: msg.id, result })
      return
    }
    for (const listener of listeners) listener(msg)
  }

  void (async () => {
    let buf = Buffer.alloc(0)
    try {
      for await (const chunk of proc.stdout) {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          const headerEnd = buf.indexOf('\r\n\r\n')
          if (headerEnd < 0) break
          const match = /Content-Length: *(\d+)/i.exec(buf.subarray(0, headerEnd).toString('ascii'))
          if (!match) throw new Error(`bad LSP header: ${JSON.stringify(buf.subarray(0, headerEnd).toString('latin1'))}`)
          const start = headerEnd + 4
          const end = start + Number(match[1])
          if (buf.length < end) break
          dispatch(JSON.parse(buf.subarray(start, end).toString('utf8')))
          buf = buf.subarray(end)
        }
      }
      closedError = new Error('language server stream ended')
    } catch (err) {
      closedError = err
    }
    for (const req of pending.values()) {
      clearTimeout(req.timer)
      req.reject(closedError)
    }
    pending.clear()
  })()

  return {
    request(method, params, timeoutMs = requestTimeoutMs) {
      if (closedError) return Promise.reject(closedError)
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method}: timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { method, resolve, reject, timer })
        send({ id, method, params }).catch((err) => {
          pending.delete(id)
          clearTimeout(timer)
          reject(err)
        })
      })
    },
    notify: (method, params) => send({ method, params }),
    /** Resolve with the first notification matching `method` and `predicate`. */
    waitForNotification(method, predicate = () => true, timeoutMs = requestTimeoutMs) {
      return new Promise((resolve, reject) => {
        const listener = (msg) => {
          if (msg.method !== method || !predicate(msg.params)) return
          listeners.delete(listener)
          clearTimeout(timer)
          resolve(msg.params)
        }
        const timer = setTimeout(() => {
          listeners.delete(listener)
          reject(new Error(`no ${method} notification within ${timeoutMs}ms`))
        }, timeoutMs)
        listeners.add(listener)
      })
    },
  }
}
