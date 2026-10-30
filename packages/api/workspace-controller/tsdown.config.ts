import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/api-workspace-controller',
  ['lib/types/index.js'],
  { hostPhase: true },
)
