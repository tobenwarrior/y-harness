/** Private Chromium DevTools pipe transport for one isolated saved-login browser. */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 12_000
const TERMINATION_GRACE_MS = 1_000
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const TEMP_PREFIX = '.yharness-browser-tmp-'

const ERROR_MESSAGES = Object.freeze({
  launch: 'Browser launch failed.',
  closed: 'Browser is closed.',
  disconnected: 'Browser disconnected.',
  timeout: 'Browser command timed out.',
  protocol: 'Browser protocol error.',
  command: 'Browser command failed.',
})

/** Fixed transport error that never includes child or browser diagnostics. */
export class BrowserPipeError extends Error {
  /**
   * @param {string} name - Fixed public error name.
   * @param {string} code - Fixed public error code.
   * @param {string} message - Fixed public error message.
   */
  constructor(name, code, message) {
    super(message)
    this.name = name
    this.code = code
  }
}

function error(name, code, message) {
  return new BrowserPipeError(name, code, message)
}

function launchError() {
  return error('BrowserLaunchError', 'BROWSER_LAUNCH_FAILED', ERROR_MESSAGES.launch)
}

function closedError() {
  return error('BrowserClosedError', 'BROWSER_CLOSED', ERROR_MESSAGES.closed)
}

function disconnectedError() {
  return error('BrowserDisconnectedError', 'BROWSER_DISCONNECTED', ERROR_MESSAGES.disconnected)
}

function timeoutError() {
  return error('BrowserTimeoutError', 'BROWSER_COMMAND_TIMEOUT', ERROR_MESSAGES.timeout)
}

function protocolError() {
  return error('BrowserProtocolError', 'BROWSER_PROTOCOL_ERROR', ERROR_MESSAGES.protocol)
}

function commandError() {
  return error('BrowserCommandError', 'BROWSER_COMMAND_FAILED', ERROR_MESSAGES.command)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function checkString(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function checkEnvironment(environment) {
  if (environment === undefined) return {}
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw launchError()
  }
  const selected = {}
  const allowed = [
    'PATH', 'HOME',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  ]
  for (const key of allowed) {
    if (!own(environment, key) || environment[key] === undefined) continue
    if (!checkString(environment[key])) throw launchError()
    selected[key] = environment[key]
  }
  return selected
}

async function privateProfile(profile) {
  if (!checkString(profile) || !isAbsolute(profile)) throw launchError()
  const path = resolve(profile)
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw launchError()
  } catch (cause) {
    if (cause instanceof BrowserPipeError) throw cause
    throw launchError()
  }
  return path
}

async function runtimeDirectory(profile) {
  try {
    const path = await mkdtemp(join(profile, TEMP_PREFIX))
    await Promise.all(['config', 'cache', 'data', 'state', 'runtime']
      .map(directory => mkdir(join(path, directory), { mode: 0o700 })))
    return path
  } catch {
    throw launchError()
  }
}

function browserEnvironment(overrides, profile, temporary) {
  return {
    PATH: overrides.PATH ?? DEFAULT_PATH,
    HOME: overrides.HOME ?? profile,
    XDG_CONFIG_HOME: overrides.XDG_CONFIG_HOME ?? join(temporary, 'config'),
    XDG_CACHE_HOME: overrides.XDG_CACHE_HOME ?? join(temporary, 'cache'),
    XDG_DATA_HOME: overrides.XDG_DATA_HOME ?? join(temporary, 'data'),
    XDG_STATE_HOME: overrides.XDG_STATE_HOME ?? join(temporary, 'state'),
    XDG_RUNTIME_DIR: overrides.XDG_RUNTIME_DIR ?? join(temporary, 'runtime'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: overrides.LANG ?? 'C',
    ...(overrides.LC_ALL === undefined ? {} : { LC_ALL: overrides.LC_ALL }),
    ...(overrides.LC_CTYPE === undefined ? {} : { LC_CTYPE: overrides.LC_CTYPE }),
    TZ: overrides.TZ ?? 'UTC',
  }
}

function browserArguments(profile) {
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-background-networking',
    '--disable-sync',
    '--no-proxy-server',
    '--password-store=basic',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-breakpad',
    '--window-size=1280,800',
    'about:blank',
  ]
}

function createTransport(child, temporary) {
  const input = child.stdio?.[3]
  const output = child.stdio?.[4]
  if (input === null || input === undefined || output === null || output === undefined) {
    try { child.kill('SIGKILL') } catch { /* The fixed launch error is the public result. */ }
    throw launchError()
  }

  let state = 'starting'
  let spawned = false
  let closeRequested = false
  let terminalError
  let nextId = 1
  let incoming = Buffer.alloc(0)
  let closeTimer
  let closeCleanup
  let resolveClosed
  const pending = new Map()
  const listeners = new Set()
  const closed = new Promise((resolveClosedPromise) => {
    resolveClosed = resolveClosedPromise
  })
  const ready = new Promise((resolveReady, rejectReady) => {
    const onSpawn = () => {
      spawned = true
      if (state === 'starting') state = 'open'
      resolveReady()
    }
    const onError = () => {
      if (!spawned) rejectReady(launchError())
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })

  const rejectPending = (failure) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(failure)
    }
    pending.clear()
  }

  const finish = () => {
    if (closeCleanup !== undefined) return closeCleanup
    closeCleanup = (async () => {
      try {
        await rm(temporary, { recursive: true, force: true })
      } catch {
        // The browser temp directory is private and disposable; cleanup failure
        // must not expose a filesystem diagnostic or alter transport semantics.
      }
      resolveClosed()
    })()
    return closeCleanup
  }

  const requestTermination = () => {
    if (state === 'closed') return
    state = 'closing'
    input.destroy()
    output.destroy()
    try { child.kill('SIGTERM') } catch { /* The close event remains authoritative. */ }
    if (closeTimer === undefined) {
      closeTimer = setTimeout(() => {
        if (state === 'closed') return
        try { child.kill('SIGKILL') } catch { /* The close event remains authoritative. */ }
      }, TERMINATION_GRACE_MS)
      closeTimer.unref?.()
    }
  }

  const beginClose = (failure) => {
    if (state === 'closed') return
    if (terminalError === undefined) terminalError = failure
    if (state !== 'closing') {
      state = 'closing'
      rejectPending(terminalError)
      listeners.clear()
      incoming = Buffer.alloc(0)
    }
    requestTermination()
  }

  const onChildClose = () => {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    closeTimer = undefined
    if (state === 'closed') return
    if (terminalError === undefined) terminalError = closeRequested ? closedError() : disconnectedError()
    state = 'closed'
    rejectPending(terminalError)
    listeners.clear()
    incoming = Buffer.alloc(0)
    void finish()
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })

  const dispatch = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // A caller listener cannot interrupt protocol dispatch or teardown.
      }
    }
  }

  const handleMessage = (message) => {
    if (!isRecord(message)) throw protocolError()
    if (own(message, 'id')) {
      if (!Number.isSafeInteger(message.id) || message.id < 1) throw protocolError()
      if (own(message, 'result') && own(message, 'error')) throw protocolError()
      if (!own(message, 'result') && !own(message, 'error')) throw protocolError()
      if (own(message, 'result') && !isRecord(message.result)) throw protocolError()
      const entry = pending.get(message.id)
      if (entry === undefined) return
      if (own(message, 'error')) {
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.reject(commandError())
        return
      }
      pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string' || message.method.length === 0 || !isRecord(message.params)) {
      throw protocolError()
    }
    if (own(message, 'sessionId') && typeof message.sessionId !== 'string') throw protocolError()
    const event = { method: message.method, params: message.params }
    if (own(message, 'sessionId')) event.sessionId = message.sessionId
    dispatch(event)
  }

  const onData = (chunk) => {
    if (state === 'closed' || state === 'closing') return
    incoming = Buffer.concat([incoming, chunk])
    let offset = 0
    while (true) {
      const end = incoming.indexOf(0, offset)
      if (end < 0) break
      if (end - offset > MAX_MESSAGE_BYTES) {
        beginClose(protocolError())
        return
      }
      let message
      try {
        message = JSON.parse(decoder.decode(incoming.subarray(offset, end)))
      } catch {
        beginClose(protocolError())
        return
      }
      try {
        handleMessage(message)
      } catch (cause) {
        beginClose(cause instanceof BrowserPipeError ? cause : protocolError())
        return
      }
      if (state === 'closed' || state === 'closing') return
      offset = end + 1
    }
    incoming = incoming.subarray(offset)
    if (incoming.length > MAX_MESSAGE_BYTES) beginClose(protocolError())
  }

  const onStreamError = () => {
    if (state !== 'closed' && state !== 'closing') beginClose(disconnectedError())
  }

  input.on('error', onStreamError)
  output.on('data', onData)
  output.on('error', onStreamError)
  output.on('end', onStreamError)
  output.on('close', onStreamError)
  child.on('error', () => {
    if (!spawned) return
    if (state !== 'closed' && state !== 'closing') beginClose(disconnectedError())
  })
  child.on('close', onChildClose)

  const command = (method, params = {}, sessionId) => {
    if (state !== 'open') return Promise.reject(terminalError ?? closedError())
    if (!checkString(method) || !isRecord(params) || (sessionId !== undefined && !checkString(sessionId))) {
      return Promise.reject(protocolError())
    }
    const id = nextId
    nextId += 1
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    let serialized
    try {
      serialized = Buffer.from(`${JSON.stringify(message)}\0`, 'utf8')
    } catch {
      return Promise.reject(protocolError())
    }
    if (serialized.length - 1 > MAX_MESSAGE_BYTES) return Promise.reject(protocolError())
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        const entry = pending.get(id)
        if (entry === undefined) return
        pending.delete(id)
        rejectCommand(timeoutError())
      }, COMMAND_TIMEOUT_MS)
      timer.unref?.()
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer })
      try {
        input.write(serialized, (writeError) => {
          if (writeError != null && state !== 'closed' && state !== 'closing') {
            beginClose(disconnectedError())
          }
        })
      } catch {
        beginClose(disconnectedError())
      }
    })
  }

  const onEvent = (listener) => {
    if (typeof listener !== 'function') throw protocolError()
    if (state === 'open') listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const close = async () => {
    if (state === 'closed') {
      await closed
      return
    }
    closeRequested = true
    beginClose(terminalError ?? closedError())
    await closed
  }

  const api = { command, onEvent, close, closed, ready }
  return api
}

/**
 * Launch one isolated Chromium process connected through its fd 3/fd 4 pipe.
 *
 * @param {string} executable - Absolute Chromium executable path.
 * @param {string} profile - Owner-controlled private Chromium profile directory.
 * @param {{env?: Record<string, string|undefined>}} [options] - Safe environment overrides.
 * @returns {Promise<{command: Function, onEvent: Function, close: Function, closed: Promise<void>}>} Browser transport.
 */
export async function launchBrowser(executable, profile, options = {}) {
  let profilePath
  let temporary
  let browser
  try {
    if (!checkString(executable)) throw launchError()
    profilePath = await privateProfile(profile)
    const overrides = checkEnvironment(options?.env)
    temporary = await runtimeDirectory(profilePath)
    const environment = browserEnvironment(overrides, profilePath, temporary)
    const child = spawn(executable, browserArguments(profilePath), {
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    browser = createTransport(child, temporary)
    await browser.ready
    return {
      command: browser.command,
      onEvent: browser.onEvent,
      close: browser.close,
      closed: browser.closed,
    }
  } catch (cause) {
    if (browser !== undefined) await browser.close()
    else if (temporary !== undefined) {
      try { await rm(temporary, { recursive: true, force: true }) } catch { /* Fixed launch error below. */ }
    }
    if (cause instanceof BrowserPipeError && cause.code === 'BROWSER_LAUNCH_FAILED') throw cause
    throw launchError()
  }
}
