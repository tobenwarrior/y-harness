/** Map fixed Computer operations to a single Chromium tab. */

import { launchBrowser } from './pipe.mjs'

export const BROWSER_WIDTH = 1280
export const BROWSER_HEIGHT = 800

const KEY_VALUES = new Map([
  ['BackSpace', 'Backspace'], ['Return', 'Enter'], ['space', ' '], ['Left', 'ArrowLeft'], ['Right', 'ArrowRight'],
  ['Up', 'ArrowUp'], ['Down', 'ArrowDown'], ['Page_Up', 'PageUp'], ['Page_Down', 'PageDown'],
  ['minus', '-'], ['equal', '='], ['bracketleft', '['], ['bracketright', ']'], ['backslash', '\\'],
  ['semicolon', ';'], ['apostrophe', "'"], ['grave', '`'], ['comma', ','], ['period', '.'], ['slash', '/'],
  ['plus', '+'], ['quotedbl', '"'], ['braceleft', '{'], ['braceright', '}'],
])
const KEY_CODES = new Map([
  ['Backspace', 8], ['Tab', 9], ['Enter', 13], ['Escape', 27], [' ', 32], ['PageUp', 33], ['PageDown', 34],
  ['End', 35], ['Home', 36], ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40],
  ['Insert', 45], ['Delete', 46],
])
const MODIFIERS = new Map([['alt', 1], ['ctrl', 2], ['meta', 4], ['super', 4], ['shift', 8]])
const BUTTONS = ['none', 'left', 'middle', 'right']
const URL_CONTROL = /[\s\u0000-\u001f\u007f]/u
const KEY_CHAR = /^[A-Za-z0-9_!@#$%^&*()\-=\[\]\\;',./?:<>|~`]$/u

/** Allow ordinary network URLs and reject local or privileged URL schemes. */
export function parseWebsite(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4_096 || URL_CONTROL.test(value)) throw new Error('Invalid website')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new Error('Invalid website')
  return url.href
}

function integer(value, lower, upper) {
  if (!Number.isInteger(value) || value < lower || value > upper) throw new Error('Invalid Computer input')
  return value
}

function keyInput(value) {
  if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid Computer key')
  const parts = value.split('+')
  const raw = parts.pop()
  const key = KEY_VALUES.get(raw) ?? raw
  if (!KEY_CODES.has(key) && !KEY_CHAR.test(raw) && !KEY_VALUES.has(raw)) throw new Error('Invalid Computer key')
  let modifiers = 0
  for (const modifier of parts) {
    const bit = MODIFIERS.get(modifier.toLowerCase())
    if (bit === undefined || (modifiers & bit) !== 0) throw new Error('Invalid Computer key')
    modifiers |= bit
  }
  const virtual = KEY_CODES.get(key) ?? (/^[a-z0-9]$/iu.test(key) ? key.toUpperCase().charCodeAt(0) : 0)
  const text = key.length === 1 && (modifiers & 7) === 0 ? key : ''
  return { key, modifiers, windowsVirtualKeyCode: virtual, ...(text === '' ? {} : { text }) }
}

/** Validate pointer, keyboard, and text data at the browser service socket. */
export function browserInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Computer input')
  switch (value.kind) {
    case 'key':
      keyInput(value.key)
      return { kind: 'key', key: value.key }
    case 'text':
      if (typeof value.text !== 'string' || !value.text.isWellFormed() || value.text.includes('\0')
        || Buffer.byteLength(value.text) > 8192) throw new Error('Invalid Computer text')
      return { kind: 'text', text: value.text }
    case 'move':
    case 'click':
    case 'drag':
    case 'scroll': {
      const x = integer(value.x, 0, BROWSER_WIDTH - 1)
      const y = integer(value.y, 0, BROWSER_HEIGHT - 1)
      if (value.kind === 'move') return { kind: 'move', x, y }
      if (value.kind === 'click') return { kind: 'click', x, y, button: integer(value.button, 1, 3) }
      if (value.kind === 'scroll') return { kind: 'scroll', x, y, delta: integer(value.delta, -10, 10) }
      return { kind: 'drag', x, y, toX: integer(value.toX, 0, BROWSER_WIDTH - 1), toY: integer(value.toY, 0, BROWSER_HEIGHT - 1) }
    }
    default:
      throw new Error('Invalid Computer input')
  }
}

function performInput(command, action) {
  const key = (type, data) => command('Input.dispatchKeyEvent', { type, ...data })
  const mouse = (type, x, y, data) => command('Input.dispatchMouseEvent', { type, x, y, ...data })
  switch (action.kind) {
    case 'text':
      return command('Input.insertText', { text: action.text })
    case 'key': {
      const input = keyInput(action.key)
      const { text, ...released } = input
      return key(text === undefined ? 'rawKeyDown' : 'keyDown', input).then(() => key('keyUp', released))
    }
    case 'move':
      return mouse('mouseMoved', action.x, action.y)
    case 'scroll':
      return mouse('mouseWheel', action.x, action.y, { deltaX: 0, deltaY: action.delta * 120 })
    case 'click': {
      const button = BUTTONS[action.button]
      const click = { button, clickCount: 1 }
      return mouse('mousePressed', action.x, action.y, click).then(() => mouse('mouseReleased', action.x, action.y, click))
    }
    case 'drag': {
      const click = { button: 'left', clickCount: 1 }
      return mouse('mousePressed', action.x, action.y, click).then(async () => {
        try { await mouse('mouseMoved', action.toX, action.toY, { buttons: 1 }) }
        finally { await mouse('mouseReleased', action.toX, action.toY, click) }
      })
    }
    default:
      throw new Error('Invalid Computer input')
  }
}

/** Start a single viewport with no address bar, downloads, or browser chrome. */
export async function createBrowserPage(executable, profile) {
  const browser = await launchBrowser(executable, profile)
  try {
    const { targetInfos } = await browser.command('Target.getTargets')
    const page = targetInfos.find(target => target.type === 'page' && target.url === 'about:blank')
    const { targetId } = page ?? await browser.command('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true })
    const command = (method, parameters) => browser.command(method, parameters, sessionId)
    const navigations = new Map()
    let waitingForNavigation
    await browser.command('Browser.setDownloadBehavior', { behavior: 'deny' })
    await command('Emulation.setDeviceMetricsOverride', {
      width: BROWSER_WIDTH, height: BROWSER_HEIGHT, deviceScaleFactor: 1, mobile: false,
    })
    await command('Emulation.setFocusEmulationEnabled', { enabled: true })
    await command('Page.enable')
    await command('Page.setLifecycleEventsEnabled', { enabled: true })
    await command('Page.bringToFront')
    browser.onEvent(event => {
      if (event.method === 'Page.lifecycleEvent' && event.sessionId === sessionId && event.params.name === 'DOMContentLoaded') {
        const { frameId, loaderId } = event.params
        if (waitingForNavigation?.frameId === frameId && waitingForNavigation.loaderId === loaderId) {
          waitingForNavigation.finish()
        } else {
          if (navigations.size >= 64) navigations.clear()
          navigations.set(loaderId, frameId)
        }
      }
      if (event.method === 'Page.javascriptDialogOpening' && event.sessionId === sessionId) {
        void command('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
      }
      if (event.method === 'Target.targetCreated' && event.params.targetInfo?.type === 'page'
        && event.params.targetInfo.targetId !== targetId && event.params.targetInfo.openerId === targetId) {
        void browser.command('Target.closeTarget', { targetId: event.params.targetInfo.targetId }).catch(() => undefined)
      }
    })
    await browser.command('Target.setDiscoverTargets', { discover: true })
    return {
      input: action => performInput(command, action),
      async frame() {
        const { data } = await command('Page.captureScreenshot', {
          format: 'jpeg', quality: 80, fromSurface: true, captureBeyondViewport: false,
        })
        if (typeof data !== 'string' || data.length > 2_800_000 || !data.startsWith('/9j/')) throw new Error('Frame unavailable')
        return data
      },
      async navigate(url) {
        const result = await command('Page.navigate', { url })
        if (result.errorText !== undefined || result.isDownload === true) throw new Error('Page unavailable')
        if (result.loaderId === undefined || navigations.get(result.loaderId) === result.frameId) return
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            waitingForNavigation = undefined
            reject(new Error('Page did not finish loading'))
          }, 10_000)
          waitingForNavigation = {
            frameId: result.frameId, loaderId: result.loaderId,
            finish: () => { clearTimeout(timeout); waitingForNavigation = undefined; resolve() },
          }
        })
      },
      close: () => browser.close(),
      closed: browser.closed,
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}
