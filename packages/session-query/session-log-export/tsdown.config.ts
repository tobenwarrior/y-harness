import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/session-log-export',
  ['lib/types/index.js'],
  { hostPhase: true },
)
