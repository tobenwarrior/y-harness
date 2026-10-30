import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/avatar-generation',
  ['lib/types/index.js'],
  { hostPhase: true },
)
