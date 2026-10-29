import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { clientBundle } from '../tsdown.client.ts'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-bots', ['lib/types/index.js'])
const portraits = fileURLToPath(new URL('./src/client/bot-portraits.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'bot-portrait-asset',
    resolveId(source: string) {
      return source === './bot-portraits.png' ? portraits : null
    },
    async load(id: string) {
      if (id !== portraits) return null
      this.addWatchFile(portraits)
      const image = await readFile(portraits)
      return `export default ${JSON.stringify(`data:image/png;base64,${image.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
