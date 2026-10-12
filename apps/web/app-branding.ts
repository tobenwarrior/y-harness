/** Project build-time display text without changing browser URLs or application identity. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const DEFAULT_CLIENT_TITLE = 'Y Harness Local Build'

/** Escape build-time text before placing it in the HTML title element. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Set the initial document title and optional installed-web-app display labels.
 * @param environment - Public values supplied to the same browser build.
 * @returns Vite plugin preserving manifest URLs, icons, and other fields.
 */
export function clientDocumentTitle(environment: NodeJS.ProcessEnv) {
  const title = escapeHtmlText(environment.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE)
  const displayName = environment.DSH_CLIENT_DISPLAY_NAME
  let outputDirectory = ''
  let write = false
  return {
    name: 'dsh-client-document-title',
    configResolved(config) {
      write = config.build.write
      outputDirectory = resolve(config.root, config.build.outDir)
    },
    transformIndexHtml(html: string) {
      return html.replace('<title>Y Harness Local Build</title>', () => `<title>${title}</title>`)
    },
    async writeBundle() {
      if (!write || displayName === undefined) return
      const path = resolve(outputDirectory, 'manifest.webmanifest')
      const manifest: Record<string, unknown> = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, `${JSON.stringify({ ...manifest, name: displayName, short_name: displayName }, null, 2)}\n`)
    },
  } satisfies Plugin
}
