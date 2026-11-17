import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isCloudTarget, openCloudConnection, openCloudForward, type CloudConnectionOptions } from '../src/cloud-connection.ts'
import { cloudVaultRequest } from '../src/cloud-vault.ts'

const TOKEN = 'a'.repeat(43)

const children: ChildProcess[] = []
let script = ''
const calls: Array<{ file: string; args: readonly string[]; environment: NodeJS.ProcessEnv }> = []

function options(overrides: Partial<CloudConnectionOptions> = {}): CloudConnectionOptions {
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
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPersist=no',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ForkAfterAuthentication=no',
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

  it('sends Vault reads through the active Cloud connection', async () => {
    script = `process.stdout.write('http://127.0.0.1:3080/?token=${TOKEN}\\n'); setInterval(() => {}, 1000)`
    const requests: Array<{ file: string; args: readonly string[] }> = []
    const signal = new AbortController().signal
    const connection = await openCloudConnection('fixture-host', signal, options({
      executeVault(file, args, execOptions, done) {
        requests.push({ file, args })
        const child = execFile(process.execPath, ['-e', `
          let input = '';
          process.stdin.on('data', chunk => { input += chunk; });
          process.stdin.on('end', () => {
            const operation = JSON.parse(input).action;
            const replies = { list: { services: [] }, 'list-logins': { logins: [] } };
            process.stdout.write(JSON.stringify(replies[operation]));
          });
        `], execOptions, done)
        children.push(child)
        return child
      },
    }))
    const master = calls[0]!
    const control = master.args[master.args.indexOf('-S') + 1]!
    try {
      expect(master.args).toContain('ControlMaster=yes')
      expect(master.args).toContain('ControlPersist=no')
      expect(dirname(control)).toBe(dirname(master.args[master.args.indexOf('-L') + 1]!))
      await expect(cloudVaultRequest(connection.sendVaultRequest, { action: 'list' }, signal))
        .resolves.toEqual({ ok: true, services: [] })
      await expect(cloudVaultRequest(connection.sendVaultRequest, { action: 'list-logins' }, signal))
        .resolves.toEqual({ ok: true, logins: [] })
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.file).toBe('/usr/bin/ssh')
        expect(request.args[request.args.indexOf('-S') + 1]).toBe(control)
        expect(request.args).toContain('ProxyCommand=/usr/bin/false')
        expect(request.args.slice(-3)).toEqual(['--', 'fixture-host', '/usr/local/sbin/yharness-vault desktop-client'])
      }
    } finally {
      connection.close()
      await connection.closed
    }
    await expect(access(dirname(control))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(cloudVaultRequest(connection.sendVaultRequest, { action: 'list' }, signal))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(requests).toHaveLength(2)
  })

  it('waits for the owned Vault command to exit when Cloud closes', async () => {
    script = `process.stdout.write('http://127.0.0.1:3080/?token=${TOKEN}\\n'); setInterval(() => {}, 1000)`
    let vaultChild: ChildProcess | undefined
    const signal = new AbortController().signal
    const connection = await openCloudConnection('fixture-host', signal, options({
      executeVault(_file, _args, execOptions, done) {
        vaultChild = execFile(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], execOptions, done)
        children.push(vaultChild)
        return vaultChild
      },
    }))
    try {
      const receipt = connection.sendVaultRequest('{"action":"list"}', signal)
      expect(vaultChild).toBeDefined()
      connection.close()
      await connection.closed
      expect(vaultChild?.signalCode).toBe('SIGKILL')
      await expect(receipt).resolves.toBeUndefined()
    } finally {
      connection.close()
      await connection.closed
    }
  })

  it('proxies loopback HTTP bytes through the owned Unix forward', async () => {
    script = `const net = require('node:net'); const server = net.createServer(socket => socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok')); server.listen(__SOCKET_PATH__, () => process.stdout.write('http://127.0.0.1:3080/?token=${TOKEN}\\n')); process.on('SIGTERM', () => server.close(() => process.exit(0)))`
    const connection = await openCloudConnection('fixture-host', new AbortController().signal, options())
    await expect(fetch(connection.loginUrl).then(response => response.text())).resolves.toBe('ok')
    connection.close()
    await connection.closed
  })

  it('keeps the loopback origin reserved across independently owned SSH attempts', async () => {
    const forward = await openCloudForward()
    const fakeResponse = (body: string): string => [
      "const net = require('node:net')",
      "const server = net.createServer(socket => socket.once('data', () => socket.end(" + JSON.stringify(
        'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ' + String(body.length) + '\r\n\r\n' + body,
      ) + ')))',
      'server.listen(__SOCKET_PATH__, () => process.stdout.write(' + JSON.stringify('http://127.0.0.1:3080/?token=' + TOKEN + '\n') + '))',
    ].join(';')
    const controller = new AbortController()
    try {
      script = fakeResponse('first')
      const first = await openCloudConnection('fixture-host', controller.signal, options({ forward }))
      expect(first.origin).toBe(forward.origin)
      await expect(fetch(first.loginUrl).then(response => response.text())).resolves.toBe('first')
      await expect(openCloudConnection('fixture-host', controller.signal, options({ forward }))).rejects.toThrow('Cloud connection failed')
      expect(calls).toHaveLength(1)
      first.close()
      await first.closed
      await expect(fetch(forward.origin, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()

      script = fakeResponse('second')
      const second = await openCloudConnection('fixture-host', controller.signal, options({ forward }))
      expect(second.origin).toBe(first.origin)
      await expect(fetch(second.loginUrl).then(response => response.text())).resolves.toBe('second')
      second.close()
      await second.closed
    } finally {
      controller.abort()
      forward.close()
      await forward.closed
    }
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
