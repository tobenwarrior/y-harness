import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from 'vite'
import { expect, it, onTestFinished } from 'vitest'
import { clientDocumentTitle } from '../app-branding.ts'

const html = '<head><title>Y Harness Local Build</title></head>'
const manifest = {
  name: 'Y Harness',
  short_name: 'Y Harness',
  start_url: './',
  scope: './',
  display: 'fullscreen',
  icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}

it('retains the existing document title and manifest when no name is configured', async () => {
  const plugin = clientDocumentTitle({})
  expect(plugin.transformIndexHtml(html)).toBe(html)
  await expect(plugin.writeBundle()).resolves.toBeUndefined()
})

it('escapes custom title text and changes only manifest display labels', async () => {
  const displayName = 'Atlas $& <Co.>'
  const plugin = clientDocumentTitle({ DSH_CLIENT_TITLE: displayName, DSH_CLIENT_DISPLAY_NAME: displayName })
  expect(plugin.transformIndexHtml(html)).toBe('<head><title>Atlas $&amp; &lt;Co.&gt;</title></head>')
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-branding-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'dist'))
  const path = join(root, 'dist/manifest.webmanifest')
  writeFileSync(path, JSON.stringify(manifest))
  plugin.configResolved(await resolveConfig({ root, configFile: false, build: { outDir: 'dist' } }, 'build'))
  await plugin.writeBundle()
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...manifest, name: displayName, short_name: displayName })
})

it('leaves the manifest alone when bundle output is disabled', async () => {
  const plugin = clientDocumentTitle({ DSH_CLIENT_TITLE: 'Atlas', DSH_CLIENT_DISPLAY_NAME: 'Atlas' })
  plugin.configResolved(await resolveConfig({ configFile: false, build: { write: false } }, 'build'))
  await expect(plugin.writeBundle()).resolves.toBeUndefined()
})
