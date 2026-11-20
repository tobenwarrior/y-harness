/** Completion of an owned VPS worker process. */

import type { ChildProcess } from 'node:child_process'

/**
 * Retain an execFile result until its owned child and pipes have closed.
 * @param command - The running command and its owned child process.
 * @returns The command result or error after the child's close event.
 */
export async function settleVpsCommand<T>(command: Promise<T> & { readonly child: ChildProcess }): Promise<T> {
  const closed = new Promise<void>((resolve) => { command.child.once('close', () => { resolve() }) })
  try {
    return await command
  } finally {
    await closed
  }
}
