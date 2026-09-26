/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory stand-in for `@daytona/sdk`, aliased in by the offline tests (scripts/no-sync.mjs, scripts/secrets.mjs).
 * Every sandbox call is appended to `globalThis.__daytonaCalls`.
 */

const log = (...entry) => globalThis.__daytonaCalls.push(entry)

export class DaytonaNotFoundError extends Error {}

class FakeSandbox {
  constructor(id) {
    this.id = id
    this.state = 'started'
    this.public = false
    this.labels = {}
    this.process = {
      executeCommand: async (command) => {
        log('exec', command)
        return { exitCode: 0, result: '' }
      },
    }
    this.git = {
      clone: async (url, path, branch, _commit, username, token) => log('git.clone', { url, path, branch, username, token }),
      // Always report local commits so any push attempt actually reaches git.push.
      status: async () => ({ ahead: 2, fileStatus: [] }),
      push: async (path) => log('git.push', path),
    }
  }
  async refreshData() {}
  async start() {
    log('start', this.id)
  }
  async getUserHomeDir() {
    return '/home/daytona'
  }
  async delete() {
    log('delete', this.id)
  }
}

export class Daytona {
  async create(params) {
    log('create', params)
    return new FakeSandbox('sb-new')
  }
  async get(id) {
    log('get', id)
    return new FakeSandbox(id)
  }
  async *list() {}
}
