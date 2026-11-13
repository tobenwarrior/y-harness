/** Write-only VPS Vault management over the owner's existing SSH login. */
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { isCloudTarget } from './cloud-connection.ts'

const SSH = '/usr/bin/ssh'
const COMMAND = '/usr/local/sbin/yharness-vault desktop-client'
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/u
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const VALUE_LIMIT = 8192
const MAX_OUTPUT = 160 * 1024

/** Request from the dedicated Vault window. No operation reads a saved value. */
export type VaultRequest = { readonly action: 'list' } | {
  readonly action: 'revoke'
  readonly unit: string
  readonly name: string
} | {
  readonly action: 'add' | 'replace'
  readonly unit: string
  readonly name: string
  readonly value: string
}

/** Names for a single administrator-enabled Linux service. */
export interface VaultService {
  readonly unit: string
  readonly names: readonly string[]
}

/** Metadata, acknowledgment, or a fixed diagnostic. */
export type VaultReply = {
  readonly ok: true
  readonly services?: readonly VaultService[]
} | {
  readonly ok: false
  readonly reason: 'invalid' | 'unavailable'
}

/** SSH execution seam used by tests with a real local subprocess. */
export type VaultExec = (
  file: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf8' },
  complete: (error: Error | null, stdout: string) => void,
) => ChildProcess

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unitName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && UNIT.test(value) && !value.endsWith('@.service')
}

function keyName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && NAME.test(value)
}

function requestBody(value: unknown): VaultRequest | undefined {
  if (!record(value)) return undefined
  const { action, unit, name } = value
  const fields = Object.keys(value).length
  if (action === 'list' && fields === 1) return { action }
  if (!unitName(unit) || !keyName(name)) return undefined
  if (action === 'revoke' && fields === 3) return { action, unit, name }
  const secret = value.value
  if ((action === 'add' || action === 'replace') && fields === 4 && typeof secret === 'string'
    && secret.length > 0 && !secret.includes('\0') && secret.isWellFormed()
    && Buffer.byteLength(secret, 'utf8') <= VALUE_LIMIT) {
    return { action, unit, name, value: secret }
  }
}

function replyBody(action: VaultRequest['action'], stdout: string): VaultReply | undefined {
  const value: unknown = JSON.parse(stdout)
  if (!record(value) || Object.keys(value).length !== 1) return undefined
  if (action !== 'list') return value.ok === true ? { ok: true } : undefined
  if (!Array.isArray(value.services) || value.services.length > 16) return undefined
  const services: VaultService[] = []
  const units = new Set<string>()
  for (const service of value.services) {
    if (!record(service) || Object.keys(service).length !== 2 || !unitName(service.unit)
      || units.has(service.unit) || !Array.isArray(service.names) || service.names.length > 100
      || !service.names.every(keyName) || new Set(service.names).size !== service.names.length) return undefined
    units.add(service.unit)
    services.push({ unit: service.unit, names: service.names })
  }
  return { ok: true, services }
}

const unavailable: VaultReply = { ok: false, reason: 'unavailable' }

/**
 * Send one bounded request over SSH and return only validated metadata or a fixed failure.
 * @param target - Main-owned, previously connected Cloud SSH destination.
 * @param value - Untrusted IPC input from the Vault window.
 * @param signal - Cancel the SSH child when its window closes.
 * @param execute - Subprocess injection for tests.
 * @returns A safe response for the Vault window.
 */
export async function cloudVaultRequest(
  target: string, value: unknown, signal: AbortSignal, execute: VaultExec = execFile,
): Promise<VaultReply> {
  const request = requestBody(value)
  if (!isCloudTarget(target) || request === undefined) return { ok: false, reason: 'invalid' }
  if (signal.aborted) return unavailable
  return new Promise((resolve) => {
    try {
      const child = execute(SSH, [
        '-a', '-x', '-T',
        '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
        '-o', 'PermitLocalCommand=no', '-o', 'RequestTTY=no',
        '-o', 'StrictHostKeyChecking=yes', '--', target, COMMAND,
      ], {
        signal, encoding: 'utf8', timeout: 25_000, maxBuffer: MAX_OUTPUT,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key))),
      }, (error, stdout) => {
        if (error !== null || signal.aborted) { resolve(unavailable); return }
        try { resolve(replyBody(request.action, stdout) ?? unavailable) }
        catch { resolve(unavailable) }
      })
      // OpenSSH can exit before reading stdin, for example if the owner lost access.
      child.stdin?.on('error', () => { resolve(unavailable) })
      child.stdin?.end(JSON.stringify(request), 'utf8')
    } catch {
      resolve(unavailable)
    }
  })
}
