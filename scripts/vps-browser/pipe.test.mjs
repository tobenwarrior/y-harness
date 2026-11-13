import assert from 'node:assert/strict'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { launchBrowser } from './pipe.mjs'

const TEST_FIXTURE_FLAG = '--yharness-pipe-fixture'
const TEST_FILE = fileURLToPath(import.meta.url)

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function fixtureFiles(t) {
  const root = await mkdtemp(join(tmpdir(), 'yharness-browser-pipe-'))
  const profile = join(root, 'profile')
  await mkdir(profile, { mode: 0o700 })
  const executable = join(root, 'fixture-launcher')
  await writeFile(executable, `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(TEST_FILE)} ${TEST_FIXTURE_FLAG} "$@"
`, { mode: 0o700 })
  await chmod(executable, 0o700)
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return { root, profile, executable }
}

function frame(value) {
  return Buffer.from(`${JSON.stringify(value)}\0`)
}

async function runFixture() {
  const input = createReadStream(null, { fd: 3, autoClose: false })
  const output = createWriteStream(null, { fd: 4, autoClose: false })
  let buffer = Buffer.alloc(0)

  const writeFrames = (frames, splitAt = 0) => {
    const payload = Buffer.concat(frames)
    if (splitAt <= 0 || splitAt >= payload.length) {
      output.write(payload)
      return
    }
    output.write(payload.subarray(0, splitAt))
    setImmediate(() => output.write(payload.subarray(splitAt)))
  }

  const handle = (message) => {
    const { id, method, params } = message
    if (method === 'fixture.inspect') {
      writeFrames([frame({
        id,
        result: {
          argv: process.argv.slice(2),
          env: Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
            'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'YH_PIPE_SECRET']
            .map((key) => [key, process.env[key]])),
        },
      })])
      return
    }
    if (method === 'fixture.echo') {
      writeFrames([
        frame({ method: 'fixture.event', params: { value: 'event' }, sessionId: 'fixture-session' }),
        frame({ id, result: { echoed: params ?? {}, sessionId: message.sessionId ?? null } }),
      ], 3)
      return
    }
    if (method === 'fixture.large') {
      writeFrames([frame({ id, result: { data: 'x'.repeat(8 * 1024 * 1024) } })], 7)
      return
    }
    if (method === 'fixture.never') return
    if (method === 'fixture.invalid') {
      writeFrames([Buffer.from('not-json\0')])
      return
    }
    if (method === 'fixture.exit') {
      process.exit(0)
    }
    writeFrames([frame({ id, result: {} })])
  }

  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const index = buffer.indexOf(0)
      if (index < 0) return
      const payload = buffer.subarray(0, index)
      buffer = buffer.subarray(index + 1)
      try {
        handle(JSON.parse(payload.toString('utf8')))
      } catch {
        process.exit(2)
      }
    }
  })
  input.on('error', () => process.exit(2))
  await new Promise(() => {})
}

if (process.argv.includes(TEST_FIXTURE_FLAG)) {
  await runFixture()
} else {
  test('uses private pipe framing, scrubbed environment, and event dispatch', async (t) => {
    const fixture = await fixtureFiles(t)
    const browser = await launchBrowser(fixture.executable, fixture.profile, {
      env: {
        PATH: '/safe/bin',
        HOME: join(fixture.root, 'home'),
        XDG_CONFIG_HOME: join(fixture.root, 'config'),
        XDG_CACHE_HOME: join(fixture.root, 'cache'),
        XDG_DATA_HOME: join(fixture.root, 'data'),
        XDG_STATE_HOME: join(fixture.root, 'state'),
        LANG: 'C',
        TZ: 'UTC',
        YH_PIPE_SECRET: 'must-not-cross-the-process-boundary',
      },
    })
    t.after(() => browser.close())

    const events = []
    const disposer = browser.onEvent((event) => {
      events.push(event)
      throw new Error('listener failures stay local')
    })
    const secondDisposer = browser.onEvent((event) => {
      events.push({ ...event, second: true })
    })

    const inspection = await browser.command('fixture.inspect')
    assert.deepEqual(inspection.env, {
      PATH: '/safe/bin',
      HOME: join(fixture.root, 'home'),
      XDG_CONFIG_HOME: join(fixture.root, 'config'),
      XDG_CACHE_HOME: join(fixture.root, 'cache'),
      XDG_DATA_HOME: join(fixture.root, 'data'),
      XDG_STATE_HOME: join(fixture.root, 'state'),
      XDG_RUNTIME_DIR: inspection.env.XDG_RUNTIME_DIR,
      TMPDIR: inspection.env.TMPDIR,
      TMP: inspection.env.TMP,
      TEMP: inspection.env.TEMP,
      LANG: 'C',
      TZ: 'UTC',
    })
    assert.equal(inspection.env.LC_ALL, undefined)
    assert.equal(inspection.env.YH_PIPE_SECRET, undefined)
    assert.equal(typeof inspection.env.TMPDIR, 'string')
    assert.ok(inspection.env.TMPDIR.startsWith(join(tmpdir(), 'yh-browser-')))
    assert.equal((await lstat(inspection.env.TMPDIR)).mode & 0o777, 0o700)
    assert.equal(inspection.env.XDG_RUNTIME_DIR.startsWith(inspection.env.TMPDIR), true)
    assert.equal(inspection.env.TMP, inspection.env.TMPDIR)
    assert.equal(inspection.env.TEMP, inspection.env.TMPDIR)
    assert.ok(inspection.argv.includes('--headless=new'))
    assert.ok(inspection.argv.includes('--remote-debugging-pipe'))
    assert.ok(inspection.argv.includes(`--user-data-dir=${fixture.profile}`))
    assert.ok(inspection.argv.includes('--no-first-run'))
    assert.ok(inspection.argv.includes('--no-default-browser-check'))
    assert.ok(inspection.argv.includes('--disable-crash-reporter'))
    assert.ok(inspection.argv.includes('--disable-background-networking'))
    assert.ok(inspection.argv.includes('--disable-sync'))
    assert.ok(inspection.argv.includes('--no-proxy-server'))
    assert.ok(inspection.argv.includes('--password-store=basic'))
    assert.ok(inspection.argv.includes('--disable-extensions'))
    assert.ok(inspection.argv.includes('--disable-default-apps'))
    assert.ok(inspection.argv.includes('--disable-component-update'))
    assert.ok(inspection.argv.includes('--disable-breakpad'))
    assert.ok(inspection.argv.includes('--window-size=1280,800'))
    assert.ok(inspection.argv.includes('about:blank'))
    assert.equal(inspection.argv.some((value) => value.startsWith('--remote-debugging-port')), false)
    assert.equal(inspection.argv.includes('--no-sandbox'), false)

    const result = await browser.command('fixture.echo', { answer: 42 }, 'target-session')
    assert.deepEqual(result, { echoed: { answer: 42 }, sessionId: 'target-session' })
    assert.deepEqual(events, [
      { method: 'fixture.event', params: { value: 'event' }, sessionId: 'fixture-session' },
      { method: 'fixture.event', params: { value: 'event' }, sessionId: 'fixture-session', second: true },
    ])
    disposer()
    secondDisposer()
  }, { timeout: 10_000 })

  test('accepts an 8 MiB response and preserves result objects', async (t) => {
    const fixture = await fixtureFiles(t)
    const browser = await launchBrowser(fixture.executable, fixture.profile)
    t.after(() => browser.close())
    const result = await browser.command('fixture.large')
    assert.equal(result.data.length, 8 * 1024 * 1024)
  }, { timeout: 10_000 })

  test('rejects a command at its deadline without retaining it', async (t) => {
    const fixture = await fixtureFiles(t)
    const browser = await launchBrowser(fixture.executable, fixture.profile)
    t.after(() => browser.close())
    await assert.rejects(browser.command('fixture.never'), (error) => {
      assert.equal(error.name, 'BrowserTimeoutError')
      assert.equal(error.code, 'BROWSER_COMMAND_TIMEOUT')
      assert.equal(error.message, 'Browser command timed out.')
      return true
    })
    await assert.rejects(browser.command('fixture.never'), (error) => {
      assert.equal(error.name, 'BrowserTimeoutError')
      return true
    })
    assert.deepEqual(await browser.command('fixture.echo'), { echoed: {}, sessionId: null })
  }, { timeout: 30_000 })

  test('closes the child and rejects pending work on an invalid frame', async (t) => {
    const fixture = await fixtureFiles(t)
    const browser = await launchBrowser(fixture.executable, fixture.profile)
    const pending = browser.command('fixture.invalid')
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'BrowserProtocolError')
      assert.equal(error.code, 'BROWSER_PROTOCOL_ERROR')
      assert.equal(error.message, 'Browser protocol error.')
      return true
    })
    await browser.closed
    await browser.close()
    await assert.rejects(browser.command('fixture.echo'), (error) => {
      assert.equal(error.name, 'BrowserProtocolError')
      return true
    })
  }, { timeout: 10_000 })

  test('rejects pending work when the browser exits and closes cleanly', async (t) => {
    const fixture = await fixtureFiles(t)
    const browser = await launchBrowser(fixture.executable, fixture.profile)
    const pending = browser.command('fixture.exit')
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'BrowserDisconnectedError')
      assert.equal(error.code, 'BROWSER_DISCONNECTED')
      assert.equal(error.message, 'Browser disconnected.')
      return true
    })
    await browser.closed
    await browser.close()
  }, { timeout: 10_000 })
}
