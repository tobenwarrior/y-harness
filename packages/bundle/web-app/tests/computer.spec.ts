import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_HEIGHT,
  COMPUTER_WIDTH,
  ComputerHost,
  ComputerInputError,
  ComputerLeaseError,
  containerComputer,
  validateComputerAction,
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
  commands: Array<{ command: string; args: readonly string[]; env: Readonly<Record<string, string>>; stdin?: string }>
  setNow: (value: number) => void
  dispose: () => Promise<void>
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-computer-test-'))
  tempRoots.push(root)
  let now = 1_000
  const commands: Fixture['commands'] = []
  const runner: ComputerCommandRunner = async (command, args, env, _signal, stdin) => {
    commands.push({ command, args, env, ...(stdin === undefined ? {} : { stdin }) })
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
  it('rejects malformed configuration and untrusted action values before execution', () => {
    expect(() => new ComputerHost({ display: '', authorityPath: '/xauthority' })).toThrow('invalid computer display')
    expect(() => new ComputerHost({ display: 'fixture\u0000display', authorityPath: '/xauthority' })).toThrow('invalid computer display')
    expect(() => new ComputerHost({ display: ':99', authorityPath: 'relative' })).toThrow('invalid computer authority path')
    expect(() => new ComputerHost({ display: ':99', authorityPath: '/xauthority\u0000' })).toThrow('invalid computer authority path')
    const invalid: unknown[] = [null, [], {}, { kind: 'unknown' }, { kind: 'move', x: -1, y: 0 },
      { kind: 'click', x: 0, y: 0, button: 4 }, { kind: 'drag', x: 0, y: 0, toX: 1280, toY: 0 },
      { kind: 'scroll', x: 0, y: 0, delta: 11 }, { kind: 'key', key: '' }, { kind: 'key', key: 'ctrl+' },
      { kind: 'key', key: 'invalid-key' }, { kind: 'key', key: 'ctrl+🙂' }, { kind: 'key', key: '\t' }, { kind: 'text', text: 'bad\u0000text' },
      { kind: 'text', text: 'x'.repeat(8193) }]
    for (const action of invalid) expect(() => validateComputerAction(action), JSON.stringify(action)).toThrow(ComputerInputError)
    expect(validateComputerAction({ kind: 'key', key: 'CTRL+F1' })).toEqual({ kind: 'key', key: 'ctrl+F1' })
    expect(validateComputerAction({ kind: 'scroll', x: 0, y: 0, delta: 0 })).toEqual({ kind: 'scroll', x: 0, y: 0, delta: 0 })
  })

  it('admits a browser request only while the Bot controls the Computer', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    let calls = 0
    const operation = async () => { calls++; return { pending: true } }
    try {
      await f.host.takeControl(viewers.alice)
      await expect(f.host.runWhileBotControls(operation, signal)).rejects.toBeInstanceOf(ComputerLeaseError)
      expect(calls).toBe(0)
      await f.host.releaseControl(viewers.alice)
      await expect(f.host.runWhileBotControls(operation, signal)).resolves.toEqual({ pending: true })
      expect(calls).toBe(1)
    } finally {
      await f.dispose()
    }
  })

  it('gives the owner an exclusive sign-in handoff and resumes only after that viewer finishes', async () => {
    const f = fixture()
    try {
      await f.host.takeControl(viewers.alice)
      const waiting = f.host.requestSignIn(new AbortController().signal)
      await expect.poll(() => f.host.signInRequest()?.id).toBeTypeOf('string')
      const request = f.host.signInRequest()!
      const destinations: string[] = []
      const navigate = async (url: string): Promise<void> => { destinations.push(url) }
      const signal = new AbortController().signal
      const url = 'https://login.example.test'
      await expect(f.host.input(viewers.alice, { kind: 'key', key: 'a' })).rejects.toMatchObject({ code: 'lease' })
      await expect(f.host.observe()).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.takeControl(viewers.alice)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.navigateAsViewer(viewers.alice, url, signal, navigate)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.answerSignIn(request.id, 'take', viewers.alice)).resolves.toEqual({ mode: 'controlling' })
      const bobFrame = await f.host.frame(viewers.bob)
      expect(bobFrame).toMatchObject({ jpeg: '', mode: 'other', signIn: request.id })
      const aliceFrame = await f.host.frame(viewers.alice)
      expect(aliceFrame.jpeg).not.toBe('')
      expect(aliceFrame.mode).toBe('controlling')
      await expect(f.host.navigateAsBot(url, signal, navigate)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.navigateAsViewer(viewers.bob, url, signal, navigate)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.navigateAsViewer(viewers.alice, url, signal, navigate)).resolves.toEqual({ mode: 'controlling' })
      expect(destinations).toEqual([url])
      await f.host.input(viewers.alice, { kind: 'key', key: '$' })
      await f.host.input(viewers.alice, { kind: 'text', text: 'fixture-$value' })
      expect(f.commands.slice(-2).map(({ args, stdin }) => [args, stdin])).toEqual([
        [['-'], 'key --clearmodifiers dollar\n'],
        [['type', '--clearmodifiers', '--delay', '12', '--file', '-'], 'fixture-$value'],
      ])
      await expect(f.host.answerSignIn(request.id, 'cancel')).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.answerSignIn(request.id, 'complete', viewers.bob)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.answerSignIn(request.id, 'complete', viewers.alice)).resolves.toEqual({ mode: 'watching' })
      await expect(waiting).resolves.toBe('completed')
      expect(f.host.signInRequest()).toBeUndefined()
      await expect(f.host.observe()).resolves.toMatchObject({ mode: 'other' })
    } finally {
      await f.dispose()
    }
  })

  it('keeps sign-in private after the turn stops and lets the owner reclaim the Computer', async () => {
    const f = fixture()
    try {
      const controller = new AbortController()
      const waiting = f.host.requestSignIn(controller.signal)
      await expect.poll(() => f.host.signInRequest()).toBeDefined()
      const { id } = f.host.signInRequest()!
      await f.host.answerSignIn(id, 'take', viewers.alice)
      controller.abort()
      await expect(waiting).resolves.toBe('interrupted')
      await expect(f.host.releaseControl(viewers.alice)).resolves.toEqual({ mode: 'watching' })
      await expect(f.host.botAction({ kind: 'click', x: 0, y: 0, button: 1 })).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(f.host.frame(viewers.bob)).resolves.toMatchObject({ jpeg: '', signIn: id })
      await f.host.answerSignIn(id, 'take', viewers.bob)
      await expect(f.host.answerSignIn(id, 'complete', viewers.alice)).rejects.toBeInstanceOf(ComputerLeaseError)
      await f.host.answerSignIn(id, 'complete', viewers.bob)
      expect(f.host.signInRequest()).toBeUndefined()
    } finally {
      await f.dispose()
    }
  })

  it('drops a frame that started before a private handoff', async () => {
    const capture = Promise.withResolvers<Buffer>()
    const host = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, { capture: () => capture.promise })
    try {
      const watching = host.frame(viewers.bob)
      const waiting = host.requestSignIn(new AbortController().signal)
      await expect.poll(() => host.signInRequest()).toBeDefined()
      const { id } = host.signInRequest()!
      await host.answerSignIn(id, 'take', viewers.alice)
      capture.resolve(Buffer.from([0xff, 0xd8]))
      await expect(watching).resolves.toMatchObject({ jpeg: '', signIn: id })
      await host.answerSignIn(id, 'cancel', viewers.alice)
      await expect(waiting).resolves.toBe('cancelled')
    } finally {
      capture.resolve(Buffer.from([0xff, 0xd8]))
      await host.dispose()
    }
  })

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
      expect(command?.args.at(-1)).toMatch(/dsh-computer-[^/\\]+[/\\]frame\.jpg$/u)
      expect(command?.env.DISPLAY).toBe(':99')
      expect(command?.env.XAUTHORITY).toBe('/run/user/1000/gdm/Xauthority')
      expect(command?.env.DEEPSEEK_API_KEY).toBeUndefined()
      expect(command?.env.COMPUTER_TEST_VISIBLE).toBe('visible')
      await f.dispose()
      expect(() => readFileSync(command?.args.at(-1) ?? '')).toThrow()
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

  it('records only safe owner actions after explicit teaching starts', async () => {
    const f = fixture()
    const navigate = async (): Promise<void> => {}
    const signal = new AbortController().signal
    try {
      await expect(f.host.startTeaching(viewers.alice)).rejects.toBeInstanceOf(ComputerLeaseError)
      await f.host.takeControl(viewers.alice)
      await expect(f.host.stopTeaching(viewers.alice)).rejects.toBeInstanceOf(ComputerLeaseError)
      await f.host.input(viewers.alice, { kind: 'click', x: 1, y: 2, button: 1 })
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: 0, maxActions: 128 })

      const started = await f.host.startTeaching(viewers.alice)
      await expect(f.host.startTeaching(viewers.alice)).resolves.toEqual(started)
      expect(f.host.teachingStatus(viewers.bob)).toMatchObject({ active: false, actionCount: 0 })
      await expect(f.host.stopTeaching(viewers.bob)).rejects.toBeInstanceOf(ComputerLeaseError)
      await f.host.input(viewers.alice, { kind: 'click', x: 3, y: 4, button: 2 })
      await f.host.input(viewers.alice, { kind: 'key', key: 'ctrl+L' })
      await f.host.input(viewers.alice, { kind: 'text', text: 'secret text that must not enter the trace' })
      await f.host.navigateAsViewer(viewers.alice, 'https://example.test/private?token=secret#fragment', signal, navigate)
      await f.host.navigateAsViewer(viewers.alice, 'https://example.test:secret@example.test/path', signal, navigate)
      await f.host.navigateAsViewer(viewers.alice, 'https://:secret@example.test/path', signal, navigate)
      await f.host.navigateAsViewer(viewers.alice, 'file:///example', signal, navigate)
      await f.host.navigateAsViewer(viewers.alice, 'invalid', signal, navigate)
      await f.host.input(viewers.alice, { kind: 'drag', x: 5, y: 6, toX: 7, toY: 8 })
      await f.host.input(viewers.alice, { kind: 'scroll', x: 5, y: 6, delta: 2 })
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: true, actionCount: 4, maxActions: 128 })

      const trace = await f.host.stopTeaching(viewers.alice)
      expect(trace).toMatchObject({ status: 'review', reviewable: true, truncated: false, actions: [
        { kind: 'click', x: 3, y: 4, button: 2 },
        { kind: 'navigate', origin: 'https://example.test' },
        { kind: 'drag', x: 5, y: 6, toX: 7, toY: 8 },
        { kind: 'scroll', x: 5, y: 6, delta: 2 },
      ] })
      expect(JSON.stringify(trace)).not.toContain('secret')
      await f.host.input(viewers.alice, { kind: 'click', x: 9, y: 10, button: 1 })
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: 4, traceId: trace.id })
      await expect(f.host.stopTeaching(viewers.alice)).resolves.toEqual(trace)
    } finally {
      await f.dispose()
    }
  })

  it('interrupts teaching when the owner lease ends and never records afterward', async () => {
    const f = fixture()
    try {
      await f.host.takeControl(viewers.alice)
      await f.host.startTeaching(viewers.alice)
      await f.host.input(viewers.alice, { kind: 'click', x: 1, y: 2, button: 1 })
      await f.host.releaseControl(viewers.alice)
      const interrupted = f.host.teachingStatus(viewers.alice)
      expect(interrupted).toMatchObject({ active: false, actionCount: 0 })
      await f.host.takeControl(viewers.alice)
      await f.host.input(viewers.alice, { kind: 'click', x: 3, y: 4, button: 1 })
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: 0 })

      await f.host.startTeaching(viewers.alice)
      await f.host.input(viewers.alice, { kind: 'click', x: 5, y: 6, button: 1 })
      f.setNow(9_001)
      await expect(f.host.input(viewers.alice, { kind: 'click', x: 7, y: 8, button: 1 })).rejects.toBeInstanceOf(ComputerLeaseError)
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: 0 })
    } finally {
      await f.dispose()
    }
  })

  it('discards any saved demonstration when private sign-in begins', async () => {
    const f = fixture()
    const controller = new AbortController()
    try {
      await f.host.takeControl(viewers.alice)
      await f.host.startTeaching(viewers.alice)
      await f.host.stopTeaching(viewers.alice)
      const signIn = f.host.requestSignIn(controller.signal)
      await expect.poll(() => f.host.signInRequest()).toBeDefined()
      await expect(f.host.startTeaching(viewers.alice)).rejects.toThrow('unavailable during sign-in')
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: 0 })
      await expect(f.host.stopTeaching(viewers.alice)).rejects.toBeInstanceOf(ComputerLeaseError)
      controller.abort()
      await expect(signIn).resolves.toBe('interrupted')
    } finally {
      controller.abort()
      await f.dispose()
    }
  })

  it('caps demonstrations by action count and duration', async () => {
    const f = fixture()
    try {
      await f.host.takeControl(viewers.alice)
      const started = await f.host.startTeaching(viewers.alice)
      const maximum = f.host.teachingStatus(viewers.alice).maxActions
      for (let index = 0; index < maximum; index++) {
        await f.host.input(viewers.alice, { kind: 'click', x: index % 10, y: index % 10, button: 1 })
      }
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: maximum })
      await expect(f.host.startTeaching(viewers.alice)).resolves.toMatchObject({ active: false, traceId: started.traceId })
      await f.host.input(viewers.alice, { kind: 'click', x: 1, y: 1, button: 1 })
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: maximum })
      await expect(f.host.stopTeaching(viewers.alice)).resolves.toMatchObject({
        status: 'limit', reviewable: true, truncated: true, actions: { length: maximum },
      })

      await f.host.releaseControl(viewers.alice)
      await f.host.takeControl(viewers.alice)
      await f.host.startTeaching(viewers.alice)
      for (let elapsed = 5_000; elapsed < 600_000; elapsed += 5_000) {
        f.setNow(elapsed)
        await f.host.takeControl(viewers.alice)
      }
      f.setNow(601_001)
      await expect(f.host.stopTeaching(viewers.alice)).resolves.toMatchObject({
        status: 'limit', reviewable: true, truncated: true, actions: [],
      })
    } finally {
      await f.dispose()
    }
  })

  it('stops an idle demonstration at its duration bound', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      await f.host.takeControl(viewers.alice)
      await f.host.startTeaching(viewers.alice)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(f.host.teachingStatus(viewers.alice)).toMatchObject({ active: false, actionCount: 0 })
      await expect(f.host.stopTeaching(viewers.alice)).resolves.toMatchObject({
        status: 'limit', reviewable: true, truncated: true, actions: [],
      })
    } finally {
      await f.dispose()
      vi.useRealTimers()
    }
  })

  it('retains the reviewed steps when an admitted navigation crosses the teaching deadline', async () => {
    vi.useFakeTimers({ now: 0 })
    const host = new ComputerHost({ display: ':teach-deadline', authorityPath: '/dev/null' }, { run: async () => {} })
    const navigating = Promise.withResolvers<undefined>()
    const navigationAccepted = Promise.withResolvers<undefined>()
    const click = { kind: 'click', x: 1, y: 2, button: 1 } as const
    try {
      await host.takeControl(viewers.alice)
      await host.startTeaching(viewers.alice)
      await host.input(viewers.alice, click)
      for (let elapsed = 0; elapsed < 590_000; elapsed += 5_000) {
        await vi.advanceTimersByTimeAsync(5_000)
        await host.takeControl(viewers.alice)
      }
      await vi.advanceTimersByTimeAsync(6_000)
      const navigation = host.navigateAsViewer(viewers.alice, 'https://example.test', new AbortController().signal, () => {
        navigationAccepted.resolve(undefined)
        return navigating.promise
      })
      await navigationAccepted.promise
      await vi.advanceTimersByTimeAsync(5_000)
      navigating.resolve(undefined)
      await expect(navigation).resolves.toEqual({ mode: 'controlling' })
      await expect(host.stopTeaching(viewers.alice)).resolves.toMatchObject({
        status: 'limit', truncated: true, actions: [click],
      })
    } finally {
      navigating.resolve(undefined)
      await host.dispose()
      vi.useRealTimers()
    }
  })

  it('drains a queued teaching deadline when the Browser is disposed during navigation', async () => {
    vi.useFakeTimers({ now: 0 })
    const host = new ComputerHost({ display: ':teach-disposal', authorityPath: '/dev/null' }, { run: async () => {} })
    const navigating = Promise.withResolvers<undefined>()
    const navigationAccepted = Promise.withResolvers<undefined>()
    try {
      await host.takeControl(viewers.alice)
      await host.startTeaching(viewers.alice)
      const navigation = host.navigateAsViewer(viewers.alice, 'https://example.test', new AbortController().signal, () => {
        navigationAccepted.resolve(undefined)
        return navigating.promise
      })
      await navigationAccepted.promise
      await vi.advanceTimersByTimeAsync(600_000)
      const disposal = host.dispose()
      navigating.resolve(undefined)
      await navigation
      await expect(disposal).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      navigating.resolve(undefined)
      await host.dispose()
      vi.useRealTimers()
    }
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
    await expect(f.host.observe()).rejects.toBeInstanceOf(ComputerLeaseError)
    expect(f.commands).toEqual([])
    await expect(f.host.frame(viewers.alice)).resolves.toMatchObject({ mode: 'controlling' })
    await f.host.releaseControl(viewers.alice)
    await expect(f.host.observe()).resolves.toMatchObject({ mode: 'other' })
    await f.dispose()
  })

  it('handles sign-in cancellation, duplicate requests, and aborted admissions', async () => {
    const f = fixture()
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(f.host.requestSignIn(controller.signal)).rejects.toThrow('aborted')
      const waiting = f.host.requestSignIn(new AbortController().signal)
      await expect.poll(() => f.host.signInRequest()).toBeDefined()
      await expect(f.host.requestSignIn(new AbortController().signal)).rejects.toBeInstanceOf(ComputerLeaseError)
      const request = f.host.signInRequest()
      if (request === undefined) throw new Error('sign-in request missing')
      await expect(f.host.input(viewers.alice, { kind: 'key', key: 'a' })).rejects.toMatchObject({ code: 'lease' })
      await expect(f.host.answerSignIn(request.id, 'take')).rejects.toMatchObject({ code: 'lease' })
      const cancelled = new AbortController()
      cancelled.abort()
      await expect(f.host.answerSignIn(request.id, 'cancel', undefined, cancelled.signal)).rejects.toThrow('aborted')
      await expect(f.host.answerSignIn(request.id, 'cancel')).resolves.toEqual({ mode: 'watching' })
      await expect(waiting).resolves.toBe('cancelled')
      const requestController = new AbortController()
      const interrupted = f.host.requestSignIn(requestController.signal)
      await expect.poll(() => f.host.signInRequest()).toBeDefined()
      requestController.abort()
      await expect(interrupted).resolves.toBe('interrupted')
      const aborter = new AbortController()
      aborter.abort()
      await expect(f.host.takeControl(viewers.alice, aborter.signal)).rejects.toThrow('aborted')
    } finally {
      await f.dispose()
    }
  })

  it('maps capture failures, object captures, and closed-host operations', async () => {
    const invalid = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      capture: async () => Buffer.from([0x00, 0x01]),
    })
    await expect(invalid.observe()).rejects.toMatchObject({ code: 'capture-failed' })
    await invalid.dispose()
    await expect(invalid.observe()).rejects.toMatchObject({ code: 'disposed' })

    const failure = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      capture: async () => { throw new Error('capture fixture detail') },
    })
    await expect(failure.observe()).rejects.toMatchObject({ code: 'capture-failed' })
    await failure.dispose()

    const aborted = new AbortController()
    const captureStarted = Promise.withResolvers<undefined>()
    const abortedCapture = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      capture: async () => { captureStarted.resolve(undefined); aborted.abort(); throw new Error('capture fixture detail') },
    })
    const pendingCapture = abortedCapture.observe(aborted.signal)
    await captureStarted.promise
    await expect(pendingCapture).rejects.toMatchObject({ code: 'aborted' })
    await abortedCapture.dispose()

    const origin = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      capture: async () => ({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), browserOrigin: 'https://example.test' }),
    })
    await expect(origin.observe()).resolves.toMatchObject({ browserOrigin: 'https://example.test' })
    await origin.dispose()
    await expect(origin.botAction({ kind: 'move', x: 0, y: 0 })).rejects.toMatchObject({ code: 'disposed' })

    const invalidFile = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      run: async (command, args) => {
        if (command === 'scrot') {
          const output = args.at(-1)
          if (output === undefined) throw new Error('missing output')
          writeFileSync(output, Buffer.from([0x00, 0x01]))
        }
      },
    })
    await expect(invalidFile.observe()).rejects.toMatchObject({ code: 'capture-failed' })
    await invalidFile.dispose()
    const failedFile = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      run: async () => { throw new Error('scrot fixture detail') },
    })
    await expect(failedFile.observe()).rejects.toMatchObject({ code: 'capture-failed' })
    await failedFile.dispose()
  })

  it('preserves cleanup when drag release fails and handles zero-scroll and lease navigation errors', async () => {
    const calls: string[][] = []
    const runner: ComputerCommandRunner = async (_command, args) => {
      calls.push([...args])
      if (args[0] === 'mouseup') throw new Error('release failed')
    }
    const host = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, { run: runner })
    await expect(host.botAction({ kind: 'drag', x: 1, y: 2, toX: 3, toY: 4 })).rejects.toThrow('release failed')
    await host.botAction({ kind: 'scroll', x: 0, y: 0, delta: 0 })
    const signal = new AbortController().signal
    await expect(host.navigateAsBot('https://example.test', signal, async () => { throw new Error('navigate failed') })).rejects.toThrow('navigate failed')
    await host.takeControl(viewers.alice)
    await expect(host.navigateAsViewer(viewers.alice, 'https://example.test', signal, async () => { throw new Error('viewer navigate failed') })).rejects.toThrow('viewer navigate failed')
    await host.dispose()
    expect(calls.at(-1)?.[0]).toBe('mousemove')
  })

  it('finishes an admitted bot observation before handing the display to a viewer', async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const host = containerComputer(async () => {
      started.resolve(undefined)
      await release.promise
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    })
    const frame = host.observe()
    await started.promise
    const events: string[] = []
    const takeover = host.takeControl(viewers.alice).then(() => { events.push('control') })
    const observed = frame.then(() => { events.push('frame') })
    try {
      await Promise.resolve()
      release.resolve(undefined)
      await Promise.all([observed, takeover])
      expect(events).toEqual(['frame', 'control'])
    } finally {
      release.resolve(undefined)
      await host.dispose()
    }
  })

  it('uses a typed browser input provider only for the current controller', async () => {
    const actions: ComputerAction[] = []
    const host = new ComputerHost({ display: ':browser', authorityPath: '/dev/null' }, {
      input: async (action) => { actions.push(action) },
      run: async () => { throw new Error('The browser does not run desktop commands.') },
    })
    try {
      const action = { kind: 'click', x: 7, y: 8, button: 1 }
      await host.botAction(action)
      await host.takeControl(viewers.alice)
      await expect(host.botAction(action)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(host.input(viewers.bob, action)).rejects.toBeInstanceOf(ComputerLeaseError)
      await expect(host.input(viewers.alice, { ...action, x: -1 })).rejects.toBeInstanceOf(ComputerInputError)
      await host.input(viewers.alice, { kind: 'text', text: 'Browser fixture' })
      expect(actions).toEqual([action, { kind: 'text', text: 'Browser fixture' }])
    } finally {
      await host.dispose()
    }
  })

  it('queues browser navigation behind the Computer lease', async () => {
    const f = fixture()
    const visited: string[] = []
    const signal = new AbortController().signal
    const navigate = async (url: string) => { visited.push(url) }
    try {
      await f.host.takeControl(viewers.alice)
      await expect(f.host.navigateAsBot('https://example.test', signal, navigate)).rejects.toBeInstanceOf(ComputerLeaseError)
      await f.host.releaseControl(viewers.alice)
      await f.host.navigateAsBot('https://example.test', signal, navigate)
      expect(visited).toEqual(['https://example.test'])
    } finally {
      await f.dispose()
    }
  })

  it('supports all bounded input forms with argv-only xdotool calls', async () => {
    const f = fixture()
    const actions: ComputerAction[] = [
      { kind: 'move', x: 1, y: 2 },
      { kind: 'click', x: 3, y: 4, button: 2 },
      { kind: 'drag', x: 5, y: 6, toX: 7, toY: 8 },
      { kind: 'scroll', x: 9, y: 10, delta: -2 },
      { kind: 'scroll', x: 11, y: 12, delta: 2 },
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
      ['xdotool', 'mousemove', '--sync', '11', '12'],
      ['xdotool', 'click', '--repeat', '2', '5'],
      ['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+Tab'],
      ['xdotool', 'type', '--clearmodifiers', '--delay', '12', '--', 'hello\nworld'],
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

    const preserved = new ComputerHost({ display: ':99', authorityPath: '/xauthority' }, {
      run: async (_command, args) => {
        if (args[0] === 'mousedown') throw new Error('movement failed')
        if (args[0] === 'mouseup') throw new Error('release failed')
      },
    })
    await expect(preserved.botAction({ kind: 'drag', x: 1, y: 2, toX: 8, toY: 9 })).rejects.toThrow('movement failed')
    await preserved.dispose()
  })

  it('ignores a queued sign-in interrupt after disposal', async () => {
    const f = fixture()
    const controller = new AbortController()
    try {
      const waiting = f.host.requestSignIn(controller.signal)
      await expect.poll(() => f.host.signInRequest()).toBeDefined()
      controller.abort()
      const disposing = f.host.dispose()
      await expect(waiting).resolves.toBe('interrupted')
      await disposing
    } finally {
      await f.dispose()
    }
  })

  it('ignores an interrupt queued after an owner answers the same request', async () => {
    const f = fixture()
    const controller = new AbortController()
    let answering: ReturnType<ComputerHost['answerSignIn']> | undefined
    const answerBeforeInterrupt = (): void => {
      const request = f.host.signInRequest()
      if (request !== undefined) answering = f.host.answerSignIn(request.id, 'cancel')
    }
    controller.signal.addEventListener('abort', answerBeforeInterrupt)
    try {
      const waiting = f.host.requestSignIn(controller.signal)
      await expect.poll(() => f.host.signInRequest()).toBeDefined()
      controller.abort()
      if (answering === undefined) throw new Error('sign-in answer was not queued')
      await expect(answering).resolves.toEqual({ mode: 'watching' })
      await expect(waiting).resolves.toBe('cancelled')
    } finally {
      controller.signal.removeEventListener('abort', answerBeforeInterrupt)
      await f.dispose()
    }
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
