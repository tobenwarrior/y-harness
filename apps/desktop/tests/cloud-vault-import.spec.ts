import { createHash } from 'node:crypto'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CloudVaultLoginImport, readVaultLoginCsv } from '../src/cloud-vault-import.ts'
import { vaultRequestAllowed } from '../src/cloud-vault.ts'

const origin = 'https://example.test'
const username = 'fixture@example.test'
const password = ' leading "quoted", password '
const signal = new AbortController().signal

it.each([
  ['Chrome and Edge', 'name,url,username,password,note', 'Example,https://example.test/sign-in,fixture@example.test," leading ""quoted"", password ","a note\nwith a line break"'],
  ['Safari and 1Password', 'Title,URL,Username,Password,Notes,OTPAuth', 'Example,https://example.test/sign-in,fixture@example.test," leading ""quoted"", password ",,'],
  ['Firefox', 'url,username,password,httpRealm,formActionOrigin,guid', 'https://example.test/sign-in,fixture@example.test," leading ""quoted"", password ",,,'],
  ['LastPass', 'url,username,password,extra,name,grouping,fav', 'https://example.test/sign-in,fixture@example.test," leading ""quoted"", password ",,Example,Work,0'],
  ['Bitwarden', 'folder,favorite,type,name,login_uri,login_username,login_password', ',,login,Example,https://example.test/sign-in,fixture@example.test," leading ""quoted"", password "'],
])('reviews a %s export and saves the exact login only after confirmation', async (_format, header, line) => {
  const send = vi.fn(async (payload: string) => {
    const request: unknown = JSON.parse(payload)
    if (request && typeof request === 'object' && 'action' in request && request.action === 'inspect-login-import') {
      const validSalt: unknown = expect.stringMatching(/^[a-f0-9]{64}$/u)
      expect(request).toEqual({ action: 'inspect-login-import', salt: validSalt })
      return JSON.stringify({ importIndex: { fingerprints: [], remaining: 64 } })
    }
    expect(request).toEqual({ action: 'import-login', origin, label: header.startsWith('url,username,password,httpRealm') ? 'example.test' : 'Example', username, password })
    return JSON.stringify({ outcome: 'imported' })
  })
  const importer = new CloudVaultLoginImport(send)
  onTestFinished(() => { importer.clear() })
  const bytes = Buffer.from(`\uFEFF${header}\r\n${line}\r\n`)
  const ready = await importer.prepare(bytes, signal)
  expect(ready.state).toBe('ready')
  if (ready.state !== 'ready') throw new Error('Expected a CSV review.')
  expect(ready.logins).toEqual([{ origin, label: header.includes('httpRealm') ? 'example.test' : 'Example', username }])
  expect(JSON.stringify(ready)).not.toContain('password')
  expect(bytes.every(byte => byte === 0)).toBe(true)
  expect(send).toHaveBeenCalledTimes(1)
  await expect(importer.confirm('another-review', signal)).resolves.toEqual({ state: 'unavailable' })
  await expect(importer.confirm(ready.id, signal)).resolves.toEqual({
    state: 'finished', imported: 1, duplicates: 0, full: 0, unconfirmed: 0,
  })
  await expect(importer.confirm(ready.id, signal)).resolves.toEqual({ state: 'unavailable' })
  expect(send).toHaveBeenCalledTimes(2)
})

it('skips duplicate accounts and invalid rows before deciding which imports fit', async () => {
  const send = vi.fn(async (payload: string) => {
    const request: unknown = JSON.parse(payload)
    if (!request || typeof request !== 'object' || !('salt' in request) || typeof request.salt !== 'string') {
      throw new Error('Unexpected import write.')
    }
    const fingerprint = createHash('sha256').update(request.salt, 'hex').update(origin).update('\0').update(username).digest('hex')
    return JSON.stringify({ importIndex: { fingerprints: [fingerprint], remaining: 1 } })
  })
  const importer = new CloudVaultLoginImport(send)
  onTestFinished(() => { importer.clear() })
  const ready = await importer.prepare(Buffer.from([
    'Title,URL,Username,Password',
    `Duplicate,${origin}/path,${username},old-value`,
    'HTTP,http://example.test,fixture,example',
    'Empty,https://example.test,fixture,',
    'HTTP auth,https://fixture@example.test,fixture,example',
    'Private,https://127.0.0.1,fixture,example',
    'Fresh,https://OTHER.test:443/signin?filter=1,fresh,example',
    'Repeat,https://other.test,fresh,example',
    'Full,https://other.test,another,example',
  ].join('\n')), signal)
  expect(ready).toMatchObject({
    state: 'ready', logins: [{ label: 'Fresh', origin: 'https://other.test', username: 'fresh' }],
    duplicates: 2, invalid: 4, full: 1,
  })
  if (ready.state !== 'ready') throw new Error('Expected a CSV review.')
  importer.clear()
  await expect(importer.confirm(ready.id, signal)).resolves.toEqual({ state: 'unavailable' })
  expect(send).toHaveBeenCalledTimes(1)
})

it('lists each HTTPS website from a multiple-site Bitwarden login', async () => {
  const send = vi.fn(async () => JSON.stringify({ importIndex: { fingerprints: [], remaining: 64 } }))
  const importer = new CloudVaultLoginImport(send)
  onTestFinished(() => { importer.clear() })
  const ready = await importer.prepare(Buffer.from([
    'type,name,login_uri,login_username,login_password',
    'login,Example,"https://one.example.test/login,https://two.example.test/,http://insecure.example.test",fixture,synthetic-value',
  ].join('\n')), signal)
  expect(ready).toMatchObject({ state: 'ready', invalid: 1, logins: [
    { origin: 'https://one.example.test', label: 'Example', username: 'fixture' },
    { origin: 'https://two.example.test', label: 'Example', username: 'fixture' },
  ] })
  expect(send).toHaveBeenCalledTimes(1)
})

it('reports a stopped import and keeps the exact acknowledged count', async () => {
  const send = vi.fn<(payload: string, signal: AbortSignal) => Promise<string | undefined>>()
    .mockResolvedValueOnce(JSON.stringify({ importIndex: { fingerprints: [], remaining: 64 } }))
    .mockResolvedValueOnce(JSON.stringify({ outcome: 'imported' }))
    .mockResolvedValueOnce(JSON.stringify({ outcome: 'duplicate' }))
    .mockResolvedValueOnce(undefined)
  const importer = new CloudVaultLoginImport(send)
  onTestFinished(() => { importer.clear() })
  const ready = await importer.prepare(Buffer.from('url,username,password\nhttps://a.test,a,fixture\nhttps://b.test,b,fixture\nhttps://c.test,c,fixture\nhttps://d.test,d,fixture'), signal)
  if (ready.state !== 'ready') throw new Error('Expected a CSV review.')
  await expect(importer.confirm(ready.id, signal)).resolves.toEqual({
    state: 'finished', imported: 1, duplicates: 1, full: 0, unconfirmed: 2,
  })
  expect(send).toHaveBeenCalledTimes(4)
})

it('rejects import operations through the generic Vault renderer request channel', () => {
  for (const request of [
    { action: 'inspect-login-import', salt: 'a'.repeat(64) },
    { action: 'import-login', origin, label: 'Example', username, password },
  ]) {
    expect(vaultRequestAllowed(request, { kind: 'manage' })).toBe(false)
  }
})

it('bounds local files before reading and uses UTF-8 for the picker contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yh-vault-csv-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const path = join(root, 'example.csv')
  const csv = 'Url,Username,Password\nhttps://example.test,fixture,example'
  await writeFile(path, csv, { mode: 0o600 })
  const bytes = await readVaultLoginCsv(path)
  expect(bytes?.toString('utf8')).toBe(csv)
  bytes?.fill(0)
  await truncate(path, 5_000_000)
  await expect(readVaultLoginCsv(path)).resolves.toBeUndefined()
  await expect(readVaultLoginCsv(root)).resolves.toBeUndefined()

  const send = vi.fn(async () => JSON.stringify({ importIndex: { fingerprints: [], remaining: 1 } }))
  const importer = new CloudVaultLoginImport(send)
  onTestFinished(() => { importer.clear() })
  await expect(importer.prepare(Buffer.from([0x80]), signal)).resolves.toEqual({ state: 'invalid-file' })
  expect(send).not.toHaveBeenCalled()
  await expect(importer.prepare(Buffer.from('wrong,header\nyes,none'), signal)).resolves.toEqual({ state: 'invalid-file' })
})
