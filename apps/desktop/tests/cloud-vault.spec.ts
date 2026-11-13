import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudVaultRequest, isVaultRequestId, vaultRequestAllowed, type VaultExec } from '../src/cloud-vault.ts'

const unit = 'fixture-worker.service'
const value = 'a synthetic value with spaces, quotes and \n a second line'
const signal = new AbortController().signal
const children = new Set<ReturnType<typeof execFile>>()

function fixture(script: string): VaultExec {
  return (_file, _args, options, callback) => {
    const child = execFile(process.execPath, ['-e', script], options, callback)
    children.add(child)
    child.once('close', () => { children.delete(child) })
    return child
  }
}

afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>((resolve) => {
    child.once('close', () => { resolve() })
    child.kill()
  })))
})

describe('Desktop Vault SSH transport', () => {
  it('inspects a request and returns only its validated metadata', async () => {
    const id = 'a'.repeat(32)
    const execute: VaultExec = (_file, _args, options, callback) => fixture(`
      let body = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { body += chunk });
      process.stdin.on('end', () => {
        const request = JSON.parse(body);
        if (request.action !== 'inspect-request' || request.id !== ${JSON.stringify(id)}) process.exit(2);
        process.stdout.write(JSON.stringify({ request: {
          id: ${JSON.stringify(id)}, unit: ${JSON.stringify(unit)}, name: 'FIXTURE_KEY', state: 'pending'
        } }));
      });
    `)(_file, _args, options, callback)
    await expect(cloudVaultRequest('fixture-vps', { action: 'inspect-request', id }, signal, execute))
      .resolves.toEqual({ request: { id, unit, name: 'FIXTURE_KEY', state: 'pending' } })
  })

  it('accepts a save acknowledgment', async () => {
    const id = 'b'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'save-request', id, value }, signal,
      fixture('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true })));')))
      .resolves.toEqual({ ok: true })
  })

  it.each(['saved', 'cancelled'] as const)('returns the broker’s %s result after dismissal', async (state) => {
    const id = 'b'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'dismiss-request', id }, signal,
      fixture(`process.stdout.write(${JSON.stringify(JSON.stringify({ state }))});`))).resolves.toEqual({ state })
  })

  it('binds the Vault form to its exact request and keeps management operations separate', () => {
    const id = 'c'.repeat(32)
    if (!isVaultRequestId(id)) throw new Error('Fixture id is invalid.')
    expect(vaultRequestAllowed({ action: 'save-request', id, value }, id)).toBe(true)
    expect(vaultRequestAllowed({ action: 'save-request', id: 'd'.repeat(32), value }, id)).toBe(false)
    expect(vaultRequestAllowed({ action: 'add', unit, name: 'FIXTURE_KEY', value }, id)).toBe(false)
    expect(vaultRequestAllowed({ action: 'inspect-request', id }, undefined)).toBe(false)
    expect(vaultRequestAllowed({ action: 'list' }, undefined)).toBe(true)
  })

  it('sends secret bytes on stdin to the fixed command and returns an acknowledgment', async () => {
    const execute: VaultExec = (file, args, options, callback) => {
      expect(file).toBe('/usr/bin/ssh')
      expect(args.slice(-3)).toEqual(['--', 'fixture-vps', '/usr/local/sbin/yharness-vault desktop-client'])
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args).toContain('ClearAllForwardings=yes')
      expect(args).toContain('ForwardAgent=no')
      expect(JSON.stringify(args)).not.toContain('synthetic value')
      expect(Object.keys(options.env ?? {}).every(name => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))).toBe(true)
      return fixture(`
        let body = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { body += chunk });
        process.stdin.on('end', () => {
          const request = JSON.parse(body);
          if (request.action !== 'add' || request.unit !== ${JSON.stringify(unit)}
              || request.name !== 'FIXTURE_KEY' || request.value !== ${JSON.stringify(value)}) process.exit(2);
          process.stdout.write(JSON.stringify({ ok: true }));
        });
      `)(file, args, options, callback)
    }
    await expect(cloudVaultRequest('fixture-vps', { action: 'add', unit, name: 'FIXTURE_KEY', value }, signal, execute))
      .resolves.toEqual({ ok: true })
  })

  it('lists only validated service names and secret names', async () => {
    const response = JSON.stringify({ services: [{ unit, names: ['FIXTURE_KEY'] }] })
    await expect(cloudVaultRequest('fixture-vps', { action: 'list' }, signal,
      fixture(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(response)}));`)))
      .resolves.toEqual({ ok: true, services: [{ unit, names: ['FIXTURE_KEY'] }] })
  })

  it('keeps remote output and errors out of the renderer', async () => {
    const result = { ok: false, reason: 'unavailable' }
    for (const script of [
      `process.stdout.write(JSON.stringify({ services: [], unexpected: ${JSON.stringify(value)} }));`,
      `process.stderr.write(${JSON.stringify(value)}); process.exitCode = 2;`,
      'process.stdout.write("x".repeat(300000));',
    ]) {
      await expect(cloudVaultRequest('fixture-vps', { action: 'list' }, signal, fixture(script))).resolves.toEqual(result)
    }
  })

  it('rejects malformed requests before opening SSH', async () => {
    const mustNotOpen: VaultExec = () => { throw new Error('SSH was started') }
    for (const request of [
      { action: 'revoke', unit: '../../worker.service', name: 'FIXTURE_KEY' },
      { action: 'add', unit, name: 'FIXTURE_KEY', value: 'x'.repeat(8193) },
      { action: 'add', unit, name: 'FIXTURE_KEY', value: '\0' },
      { action: 'add', unit, name: 'FIXTURE_KEY', value: '\uD800' },
      { action: 'list', value },
      { action: 'get', unit, name: 'FIXTURE_KEY' },
      { action: 'inspect-request', id: 'A'.repeat(32) },
      { action: 'inspect-request', id: 'a'.repeat(31) },
      { action: 'save-request', id: 'a'.repeat(32), value: '' },
      { action: 'dismiss-request', id: 'a'.repeat(32), value },
    ]) {
      await expect(cloudVaultRequest('fixture-vps', request, signal, mustNotOpen)).resolves.toEqual({ ok: false, reason: 'invalid' })
    }
    await expect(cloudVaultRequest('-oUntrusted', { action: 'list' }, signal, mustNotOpen)).resolves.toEqual({ ok: false, reason: 'invalid' })
    await expect(cloudVaultRequest('fixture-vps', { action: 'list' }, AbortSignal.abort(), mustNotOpen))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('rejects an inspection reply for a different request', async () => {
    const id = 'a'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'inspect-request', id }, signal,
      fixture(`process.stdout.write(JSON.stringify({ request: {
        id: ${JSON.stringify('b'.repeat(32))}, unit: ${JSON.stringify(unit)}, name: 'FIXTURE_KEY', state: 'pending'
      } }));`))).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})
