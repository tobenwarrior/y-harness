import { clientBundle } from '../../client/tsdown.client.ts'

/** Build the Host service and generated Remote client descriptor together. */
export default clientBundle(
  '@deepseek-ai/dsh-bots',
  ['lib/types/index.js'],
  { hostPhase: true },
)
