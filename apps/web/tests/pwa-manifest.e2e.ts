import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WEB_DISPLAY_NAME } from './branding.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))
const PUBLIC_ROOT = fileURLToPath(new URL('../public', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  const sourceManifest: unknown = JSON.parse(await readFile(join(PUBLIC_ROOT, 'manifest.webmanifest'), 'utf8'))
  if (typeof sourceManifest !== 'object' || sourceManifest === null || Array.isArray(sourceManifest)) {
    throw new TypeError('source web manifest must be an object')
  }
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).not.toHaveProperty('id')
  expect(manifest).toEqual(WEB_DISPLAY_NAME === undefined
    ? sourceManifest
    : { ...sourceManifest, name: WEB_DISPLAY_NAME, short_name: WEB_DISPLAY_NAME })
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  for (const name of ['favicon.svg', 'favicon-dark.svg']) {
    const shipped = await readFile(join(DIST_ROOT, name), 'utf8')
    const source = await readFile(join(PUBLIC_ROOT, name), 'utf8')
    expect(shipped).toBe(source)
    expect(shipped).not.toContain('<style>')
  }
})
