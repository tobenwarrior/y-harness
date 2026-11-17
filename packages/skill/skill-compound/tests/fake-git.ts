import { EventEmitter } from 'node:events'

export interface FakeGitFixture {
  readonly commit?: string
  readonly treeRecords?: readonly string[]
  readonly cloneOutputBytes?: number
}

export interface FakeGitCall {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv | undefined
}

interface FakeGitChild extends EventEmitter {
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
  killed: boolean
  kill(): boolean
}

/** Create an in-process Git child harness that works on every host platform. */
export function createFakeGitHarness(): {
  readonly calls: FakeGitCall[]
  readonly spawn: (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => FakeGitChild
  configure(fixture: FakeGitFixture): void
  reset(): void
} {
  const calls: FakeGitCall[] = []
  let fixture: FakeGitFixture = {}
  const spawn = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }): FakeGitChild => {
    calls.push({ command, args: [...args], env: options.env })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill(): boolean {
        child.killed = true
        return true
      },
    }) as FakeGitChild
    queueMicrotask(() => {
      if (args.includes('clone') && fixture.cloneOutputBytes !== undefined) {
        const output = Buffer.alloc(fixture.cloneOutputBytes)
        child.stdout.emit('data', output)
        child.stderr.emit('data', output)
      } else if (args.includes('rev-parse') || args.includes('ls-remote')) {
        child.stdout.emit('data', `${fixture.commit ?? ''}${args.includes('ls-remote') ? ' refs/heads/main' : ''}\n`)
      } else if (args.includes('ls-tree')) {
        child.stdout.emit('data', fixture.treeRecords?.map(record => `${record}\0`).join('') ?? '')
      }
      child.emit('close', 0)
    })
    return child
  }
  return {
    calls,
    spawn,
    configure(next: FakeGitFixture): void { fixture = next },
    reset(): void { calls.length = 0; fixture = {} },
  }
}
