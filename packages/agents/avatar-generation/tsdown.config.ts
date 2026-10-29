import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-avatar-generation',
  ['lib/types/index.js'],
  { hostPhase: true },
)
