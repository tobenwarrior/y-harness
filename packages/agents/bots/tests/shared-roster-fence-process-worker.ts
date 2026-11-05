import { Context } from '@yharness/cordis'
import { credentialKey } from '@yharness/credentials'
import { LocalCredentialProvider } from '../../../credentials/credentials-local/src/index.ts'

const credentialsPath = process.argv[2]
const token = process.argv[3]
if (credentialsPath === undefined || token === undefined) throw new Error('missing roster-fence worker arguments')

const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
const credentials = ctx.get('credentials')
if (credentials === undefined) throw new Error('roster-fence worker credentials were not mounted')
await credentials.modifyRecord(credentialKey('agent-bots', 'profile-revisions-v3'), async () => ({
  kind: 'grant' as const,
  payload: {
    version: 3 as const,
    revisions: {},
    profiles: {},
    sharedRosterFence: { token },
  },
}))
process.stdout.write('FENCE_READY\n')
setInterval(() => {}, 1_000)
