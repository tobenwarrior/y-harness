import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_HEIGHT,
  COMPUTER_WIDTH,
  ComputerHost,
  ComputerInputError,
  ComputerLeaseError,
  containerComputer,
  type ComputerAction,
  type ComputerCommandRunner,
} from '../src/computer.ts'

const viewers = {
  alice: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bob: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  host: ComputerHost
  commands: Array<{ command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>
  setNow: (value: number) => void
  dispose: () => Promise<void>
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-computer-test-'))
  tempRoots.push(root)
  let now = 1_000
  const commands: Fixture['commands'] = []
  const runner: ComputerCommandRunner = async (command, args, env) => {
    commands.push({ command, args, env })
    if (command === 'scrot') {
      const outputPath = args.at(-1)
      if (outputPath === undefined) throw new Error('test scrot path missing')
      writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    }
  }
  const host = new ComputerHost({ display: ':99', authorityPath: '/run/user/1000/gdm/Xauthority' }, {
    now: () => now,
    run: runner,
  })
  return {
    host,
    commands,
    setNow: (value) => { now = value },
    dispose: () => host.dispose(),
  }
}

describe('private computer Host', () => {
  it('captures a fixed-size JPEG with the cursor through a private temp path and scrubbed env', async () => {
    process.env.DEEPSEEK_API_KEY = 'should-not-reach-x11'
    process.env.COMPUTER_TEST_VISIBLE = 'visible'
    try {
      const f = fixture()
      const frame = await f.host.observe()

      expect(frame).toEqual({
        jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        width: COMPUTER_WIDTH,
        height: COMPUTER_HEIGHT,
        mode: 'other',
        botActive: false,
      })
      const command = f.commands[0]
      expect(command?.command).toBe('scrot')
      expect(command?.args.slice(0, 3)).toEqual(['--pointer', '--quality', '85'])
      const outputPath = command?.args.at(-1) ?? ''
      expect(basename(outputPath)).toBe('frame.jpg')
      expect(basename(dirname(outputPath))).toMatch(/^dsh-computer-.+$/u)
      expect(command?.env.DISPLAY).toBe(':99')
      expect(command?.env.XAUTHORITY).toBe('/run/user/1000/gdm/Xauthority')
      expect(command?.env.DEEPSEEK_API_KEY).toBeUndefined()
      expect(command?.env.COMPUTER_TEST_VISIBLE).toBe('visible')
      await f.dispose()
      expect(() => readFileSync(outputPath)).toThrow()
    } finally {
      delete process.env.DEEPSEEK_API_KEY
      delete process.env.COMPUTER_TEST_VISIBLE
    }
  })

  it('captures container frames through returned bytes and sends input as argv', async () => {
    const calls: Array<readonly string[]> = []
    const host = containerComputer(async (argv) => {
      calls.push(argv)
      return argv[0] === '/usr/local/bin/yharness-vps-bot-capture' ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : Buffer.alloc(0)
    })

    await expect(host.observe()).resolves.toMatchObject({
      jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      width: COMPUTER_WIDTH,
      height: COMPUTER_HEIGHT,
      mode: 'other',
    })
    await host.botAction({ kind: 'click', x: 10, y: 20, button: 1 })
    expect(calls).toEqual([
      ['/usr/local/bin/yharness-vps-bot-capture'],
      ['xdotool', 'mousemove', '--sync', '10', '20'],
      ['xdotool', 'click', '1'],
    ])
    await host.dispose()
  })

  it('rejects container frames that are not JPEG data', async () => {
    const calls: Array<readonly string[]> = []
    const host = containerComputer(async (argv) => {
      calls.push(argv)
      return Buffer.from('not a jpeg')
    })
    try {
      await expect(host.observe()).rejects.toMatchObject({
        name: 'ComputerError',
        code: 'capture-failed',
        message: 'computer frame capture failed',
      })
      expect(calls).toEqual([['/usr/local/bin/yharness-vps-bot-capture']])
    } finally {
      await host.dispose()
    }
  })

  it('redacts container capture runner failures', async () => {
    const host = containerComputer(async () => {
      throw new Error('private capture runner diagnostic')
    })
    try {
      await expect(host.observe()).rejects.toMatchObject({
        name: 'ComputerError',
        code: 'capture-failed',
        message: 'computer frame capture failed',
      })
    } finally {
      await host.dispose()
    }
  })

  it('normalizes an aborted container capture after the runner observes cancellation', async () => {
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    const host = containerComputer(async (_argv, signal) => {
      startedResolve?.()
      return new Promise<Buffer>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('private capture cancelled')) }, { once: true })
      })
    })
    const controller = new AbortController()
    try {
      const observation = host.observe(controller.signal)
      await started
      controller.abort()
      await expect(observation).rejects.toMatchObject({
        name: 'ComputerError',
        code: 'aborted',
        message: 'computer operation aborted',
      })
    } finally {
      controller.abort()
      await host.dispose()
    }
  })

  it('serializes bot and human input, and waits for admitted bot work before taking control', async () => {
    const f = fixture()
    const entered: string[] = []
    let releaseBot: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseBot = resolve })
    const runner: ComputerCommandRunner = async (command, args, env) => {
      entered.push(`${command}:${args.join(' ')}`)
      if (command === 'xdotool' && args[0] === 'mousemove' && entered.length === 1) await gate
      if (command === 'scrot') {
        const outputPath = args.at(-1)
        if (outputPath === undefined) throw new Error('test scrot path missing')
        writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      }
      void env
    }
    await f.dispose()
    const host = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, { run: runner })
    const bot = host.botAction({ kind: 'click', x: 10, y: 20, button: 1 })
    const takeover = host.takeControl(viewers.alice)
    await Promise.resolve()
    expect(entered).toEqual(['xdotool:mousemove --sync 10 20'])
    let takeoverSettled = false
    void takeover.then(() => { takeoverSettled = true })
    await Promise.resolve()
    expect(takeoverSettled).toBe(false)
    releaseBot?.()
    await bot
    await expect(takeover).resolves.toEqual({ mode: 'controlling' })
    await expect(host.input(viewers.alice, { kind: 'key', key: 'ctrl+alt+Delete' })).resolves.toEqual({ mode: 'controlling' })
    expect(entered.slice(-3)).toEqual([
      'xdotool:mousemove --sync 10 20',
      'xdotool:click 1',
      'xdotool:key --clearmodifiers ctrl+alt+Delete',
    ])
    await host.dispose()
  })

  it('keeps control exclusive, refreshes the heartbeat, and ignores stale release', async () => {
    const f = fixture()
    await expect(f.host.takeControl(viewers.alice)).resolves.toEqual({ mode: 'controlling' })
    await expect(f.host.takeControl(viewers.bob)).rejects.toBeInstanceOf(ComputerLeaseError)
    await expect(f.host.frame(viewers.alice)).resolves.toMatchObject({ mode: 'controlling' })
    f.setNow(8_999)
    await expect(f.host.frame(viewers.alice)).resolves.toMatchObject({ mode: 'controlling' })
    f.setNow(17_000)
    await expect(f.host.takeControl(viewers.bob)).resolves.toEqual({ mode: 'controlling' })
    await expect(f.host.frame(viewers.alice)).resolves.toMatchObject({ mode: 'other' })
    await expect(f.host.releaseControl(viewers.alice)).resolves.toEqual({ mode: 'other' })
    await expect(f.host.frame(viewers.bob)).resolves.toMatchObject({ mode: 'controlling' })
    await expect(f.host.releaseControl(viewers.bob)).resolves.toEqual({ mode: 'watching' })
    await f.dispose()
  })

  it('expires an idle lease and lets a bot act after expiry', async () => {
    const f = fixture()
    await f.host.takeControl(viewers.alice)
    f.setNow(9_001)
    await expect(f.host.botAction({ kind: 'move', x: 4, y: 5 })).resolves.toBeUndefined()
    expect(f.commands.at(-1)?.args).toEqual(['mousemove', '--sync', '4', '5'])
    await f.dispose()
  })

  it('rejects invalid viewers and actions before they reach xdotool', async () => {
    const f = fixture()
    await expect(f.host.takeControl('not-a-uuid')).rejects.toBeInstanceOf(ComputerLeaseError)
    await expect(f.host.botAction({ kind: 'click', x: 1280, y: 0, button: 1 })).rejects.toBeInstanceOf(ComputerInputError)
    await expect(f.host.botAction({ kind: 'key', key: 'ctrl;rm' })).rejects.toBeInstanceOf(ComputerInputError)
    await expect(f.host.botAction({ kind: 'text', text: 'a'.repeat(20_000) })).rejects.toBeInstanceOf(ComputerInputError)
    expect(f.commands).toEqual([])
    await f.dispose()
  })

  it('rejects human input from a non-owner and does not let the bot interrupt a human lease', async () => {
    const f = fixture()
    await f.host.takeControl(viewers.alice)
    await expect(f.host.input(viewers.bob, { kind: 'click', x: 1, y: 1, button: 1 })).rejects.toBeInstanceOf(ComputerLeaseError)
    await expect(f.host.botAction({ kind: 'click', x: 2, y: 2, button: 1 })).rejects.toBeInstanceOf(ComputerLeaseError)
    expect(f.commands).toEqual([])
    await f.dispose()
  })

  it('supports all bounded input forms with argv-only xdotool calls', async () => {
    const f = fixture()
    const actions: ComputerAction[] = [
      { kind: 'move', x: 1, y: 2 },
      { kind: 'click', x: 3, y: 4, button: 2 },
      { kind: 'drag', x: 5, y: 6, toX: 7, toY: 8 },
      { kind: 'scroll', x: 9, y: 10, delta: -2 },
      { kind: 'key', key: 'ctrl+shift+Tab' },
      { kind: 'text', text: 'hello\nworld' },
    ]
    for (const action of actions) await f.host.botAction(action)
    expect(f.commands.map(command => [command.command, ...command.args])).toEqual([
      ['xdotool', 'mousemove', '--sync', '1', '2'],
      ['xdotool', 'mousemove', '--sync', '3', '4'],
      ['xdotool', 'click', '2'],
      ['xdotool', 'mousemove', '--sync', '5', '6'],
      ['xdotool', 'mousedown', '1'],
      ['xdotool', 'mousemove', '--sync', '7', '8'],
      ['xdotool', 'mouseup', '1'],
      ['xdotool', 'mousemove', '--sync', '9', '10'],
      ['xdotool', 'click', '--repeat', '2', '4'],
      ['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+Tab'],
      ['xdotool', 'type', '--clearmodifiers', '--delay', '0', '--', 'hello\nworld'],
    ])
    await f.dispose()
  })

  it('releases the drag button with a fresh signal when movement fails', async () => {
    const calls: Array<{ args: readonly string[]; aborted: boolean }> = []
    const runner: ComputerCommandRunner = async (_command, args, _env, signal) => {
      calls.push({ args, aborted: signal.aborted })
      if (args[0] === 'mousemove' && args[2] === '8') throw new Error('movement failed')
    }
    const host = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, { run: runner })
    await expect(host.botAction({ kind: 'drag', x: 1, y: 2, toX: 8, toY: 9 })).rejects.toThrow('movement failed')
    expect(calls.map(call => call.args)).toEqual([
      ['mousemove', '--sync', '1', '2'],
      ['mousedown', '1'],
      ['mousemove', '--sync', '8', '9'],
      ['mouseup', '1'],
    ])
    expect(calls.at(-1)?.aborted).toBe(false)
    await host.dispose()
  })

  it('disposes only after an admitted native action reaches quiescence', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const runner: ComputerCommandRunner = async () => { await gate }
    const host = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, { run: runner })
    const action = host.botAction({ kind: 'move', x: 1, y: 2 })
    await Promise.resolve()
    let disposed = false
    const disposing = host.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release?.()
    await action
    await disposing
    expect(disposed).toBe(true)
  })
})
