import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/api-workspace-files',
  ['lib/types/index.js'],
  { hostPhase: true },
)
