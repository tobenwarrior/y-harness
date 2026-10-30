import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@yharness/api-job-controller',
  ['lib/types/index.js'],
  { hostPhase: true },
)
