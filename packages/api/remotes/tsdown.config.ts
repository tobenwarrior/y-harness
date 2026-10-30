import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/api-remotes',
  ['lib/types/index.js'],
  { hostPhase: true },
)
