/** Operator-only signed packaging; default checks do not launch children, sign, install, or publish. */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { InstalledUpdateSigningHoldError, packageInstalledUpdate } from './installed-update-packaging.ts'

async function main(): Promise<void> {
  const [manifest, version, mode, ...extra] = process.argv.slice(2)
  if (!manifest || !version || extra.length !== 0 || (mode !== undefined && mode !== '--check' && mode !== '--execute')) {
    throw new Error('invalid invocation')
  }
  const result = await packageInstalledUpdate(manifest, version, { execute: mode === '--execute',
    confirm: async (id, selectedVersion) => {
      if (!stdin.isTTY || !stdout.isTTY) return false
      const terminal = createInterface({ input: stdin, output: stdout })
      try {
        console.log('Continue only after an administrator has reviewed the package and restored signing protection. Confirm that the token is logged out, 5/5 attempts remain, the PIN is correct, and no other signing job is active.')
        console.log('This package requires several signing operations. Do not retry failures because the driver cannot guarantee its internal authentication count. Cancel any password prompt instead of entering another password.')
        console.log('The PIN is read only from .env.windows and is briefly passed to SignTool as required by the signing service. Nothing will be installed or uploaded.')
        const expected = `PACKAGE ${selectedVersion} ${id}`
        return (await terminal.question(`Authorize only this version by entering ${expected}: `)) === expected
      } finally { terminal.close() }
    } })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof InstalledUpdateSigningHoldError ? error.message
    : 'installed update packaging stopped. Check prepared files and the retained record; do not retry or remove protection automatically.')
  process.exitCode = 1
})
