import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/api-session-controller',
  ['lib/types/index.js'],
  { hostPhase: true },
)
