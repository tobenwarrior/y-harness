import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnerPrivateDirectoryWin32 } from '@yharness/fs-local'

/**
 * Create a synthetic overlay root with the platform's owner-private policy.
 * @param prefix - temporary-directory prefix.
 * @returns an existing private directory whose contents may be populated.
 */
export async function privateOverlayRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  if (process.platform === 'win32') {
    await rm(root, { recursive: true, force: true })
    createOwnerPrivateDirectoryWin32(root)
  } else {
    await chmod(root, 0o700)
  }
  return root
}
