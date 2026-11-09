import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { isCloudTarget, openCloudConnection, type CloudConnectionTestOptions } from '../src/cloud-connection.ts'

const TOKEN = 'a'.repeat(43)

const children: ChildProcess[] = []
let script = ''
const calls: Array<{ file: string; args: readonly string[]; environment: NodeJS.ProcessEnv }> = []

function options(overrides: Partial<CloudConnectionTestOptions> = {}): CloudConnectionTestOptions {
  return {
    spawnProcess: (file, args, spawnOptions) => {
      calls.push({ file, args: [...args], environment: { ...spawnOptions.env } })
      const forward = args[args.indexOf('-L') + 1]!
      const socketPath = forward.slice(0, -':127.0.0.1:3080'.length)
      const child = spawn(process.execPath, ['-e', script.replace('__SOCKET_PATH__', JSON.stringify(socketPath))], spawnOptions)
      children.push(child)
      return child
    },
    ...overrides,
  }
}

async function settleChildren(): Promise<void> {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.once('close', () => { resolve() }))
  }))
}

afterEach(async () => {
  calls.splice(0)
  script = ''
  await settleChildren()
})

describe('cloud connection', () => {
  it('accepts only a bounded OpenSSH destination name', () => {
    expect(isCloudTarget('fixture-host')).toBe(true)
    expect(isCloudTarget('operator@fixture-host')).toBe(true)
    expect(isCloudTarget('')).toBe(false)
    expect(isCloudTarget(' fixture-host')).toBe(false)
    expect(isCloudTarget('fixture host')).toBe(false)
    expect(isCloudTarget('-oProxyCommand=touch /tmp/pwned')).toBe(false)
    expect(isCloudTarget('../fixture-host')).toBe(false)
    expect(isCloudTarget('fixture-host:22')).toBe(false)
    expect(isCloudTarget(`a${'b'.repeat(128)}`)).toBe(false)
  })

  it('starts an isolated Unix-socket forward and rewrites the authenticated URL to its bound loopback port', async () => {
    script = `process.stdout.write('http://127.0.0.1:3080/?token=${TOKEN}\\n'); setInterval(() => {}, 1000)`
    const connection = await openCloudConnection('fixture-host', new AbortController().signal, options())
    const call = calls[0]!
    const forwardIndex = call.args.indexOf('-L')
    const forward = call.args[forwardIndex + 1]!

    expect(call.file).toBe('/usr/bin/ssh')
    expect(forward).toMatch(/127\.0\.0\.1:3080$/u)
    expect(forward).not.toContain('127.0.0.1:0')
    expect(connection.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(connection.loginUrl).toBe(`${connection.origin}/?token=${TOKEN}`)
    expect(call.args).toContain('fixture-host')
    expect(call.args).toContain('python3 ~/.local/bin/yharness-vps url && exec sleep infinity')
    expect(call.args).toEqual(expect.arrayContaining([
      '-a', '-x', '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ForwardAgent=no',
      '-o', 'ForwardX11=no',
      '-o', 'PermitLocalCommand=no',
      '-o', 'RequestTTY=no',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'StreamLocalBindUnlink=yes',
    ]))
    expect(Object.keys(call.environment).every(name => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))).toBe(true)

    connection.close()
    await connection.closed
    await expect(connection.closed).resolves.toBeUndefined()
  })

  it('proxies loopback HTTP bytes through the owned Unix forward', async () => {
    script = `const net = require('node:net'); const server = net.createServer(socket => socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok')); server.listen(__SOCKET_PATH__, () => process.stdout.write('http://127.0.0.1:3080/?token=${TOKEN}\\n')); process.on('SIGTERM', () => server.close(() => process.exit(0)))`
    const connection = await openCloudConnection('fixture-host', new AbortController().signal, options())
    await expect(fetch(connection.loginUrl).then(response => response.text())).resolves.toBe('ok')
    connection.close()
    await connection.closed
  })

  it('rejects before spawning when already aborted', async () => {
    const signal = AbortSignal.abort()
    await expect(openCloudConnection('fixture-host', signal, options())).rejects.toThrow('aborted')
    expect(calls).toHaveLength(0)
  })

  it('sanitizes a synchronous spawn failure without leaving startup rejection unobserved', async () => {
    await expect(openCloudConnection('fixture-host', new AbortController().signal, {
      spawnProcess: () => { throw new Error('target=private-host') },
    })).rejects.toThrow('Cloud connection failed')
  })

  it('does not expose target names or SSH output in startup failures', async () => {
    script = "process.stderr.write('target=private-host token=private-secret\\n'); process.stdout.write('not a URL\\n'); process.exit(7)"
    let error: Error | undefined
    try {
      await openCloudConnection('private-host', new AbortController().signal, options())
    } catch (failure: unknown) {
      if (failure instanceof Error) error = failure
    }
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('Cloud connection failed')
    expect(error?.message).not.toContain('private-host')
    expect(error?.message).not.toContain('private-secret')
  })

  it('settles the closed promise when the tunnel exits after readiness', async () => {
    script = `process.stdout.write('http://127.0.0.1:3080/?token=${TOKEN}\\n'); setTimeout(() => process.exit(0), 100)`
    const connection = await openCloudConnection('fixture-host', new AbortController().signal, options())
    await connection.closed
    expect(connection.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
  })

  it('bounds startup and terminates the owned child', async () => {
    script = 'setInterval(() => {}, 1000)'
    await expect(openCloudConnection('fixture-host', new AbortController().signal, options({
      startupTimeoutMs: 40,
      terminateTimeoutMs: 200,
    }))).rejects.toThrow('timed out')
    await settleChildren()
  })

  it('aborts startup and terminates only the owned child', async () => {
    script = 'setInterval(() => {}, 1000)'
    const controller = new AbortController()
    const opening = openCloudConnection('fixture-host', controller.signal, options({ terminateTimeoutMs: 200 }))
    setTimeout(() => { controller.abort() }, 20)
    await expect(opening).rejects.toThrow('aborted')
    await settleChildren()
  })
})
