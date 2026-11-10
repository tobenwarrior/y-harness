/** Primary-display capture and input under Y Harness's own macOS permissions. */

import { desktopCapturer, dialog, screen, shell, systemPreferences, type BrowserWindow } from 'electron'
import koffi from 'koffi'
import { formatDesktopMessage, type DesktopMessages } from './locale.ts'
import type { MacDesktop } from './mac-computer.ts'

const CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'

const MAC_VERSION = Number(process.getSystemVersion().split('.')[0])

function privacySettings(permission: 'screenRecording' | 'accessibility'): string {
  const version = MAC_VERSION
  const pane = version >= 13 ? 'com.apple.settings.PrivacySecurity.extension' : 'com.apple.preference.security'
  const item = permission === 'accessibility' ? 'Accessibility' : version >= 26 ? 'AudioCapture' : 'ScreenCapture'
  return 'x-apple.systempreferences:' + pane + '?Privacy_' + item
}

// Carbon virtual key codes represent physical keys. Plain text uses Unicode.
const VIRTUAL_KEYS: Readonly<Record<string, number>> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13,
  e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23,
  '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33,
  i: 34, p: 35, return: 36, enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42,
  ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, ' ': 49, '\x60': 50,
  backspace: 51, escape: 53, home: 115, page_up: 116, delete: 117, end: 119, page_down: 121,
  left: 123, right: 124, down: 125, up: 126,
}
const MODIFIER_FLAGS = new Map<string, number>([
  ['shift', 1 << 17], ['ctrl', 1 << 18], ['control', 1 << 18],
  ['alt', 1 << 19], ['option', 1 << 19],
  ['cmd', 1 << 20], ['command', 1 << 20], ['super', 1 << 20], ['meta', 1 << 20],
])

function createInput(): MacDesktop['input'] {
  const graphics = koffi.load(CORE_GRAPHICS)
  const foundation = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const pointType = koffi.struct('YHarnessCGPoint', { x: 'double', y: 'double' })
  const mouse = graphics.func('CGEventCreateMouseEvent', 'void *', ['void *', 'uint32_t', pointType, 'uint32_t'])
  const keyboard = graphics.func('void * CGEventCreateKeyboardEvent(void *, uint16_t, bool)')
  const wheel = graphics.func('void * CGEventCreateScrollWheelEvent2(void *, uint32_t, uint32_t, int32_t, int32_t, int32_t)')
  const locate = graphics.func('CGEventSetLocation', 'void', ['void *', pointType])
  const setInteger = graphics.func('void CGEventSetIntegerValueField(void *, uint32_t, int64_t)')
  const flags = graphics.func('void CGEventSetFlags(void *, uint64_t)')
  const unicode = graphics.func('void CGEventKeyboardSetUnicodeString(void *, unsigned long, const uint16_t *)')
  const post = graphics.func('void CGEventPost(uint32_t, void *)')
  const release = foundation.func('void CFRelease(void *)')

  const send = (event: ReturnType<typeof keyboard>, configure?: () => void): void => {
    if (event === null) throw new Error('macOS could not create the input event.')
    try {
      configure?.()
      post(0, event) // kCGHIDEventTap
    } finally {
      release(event)
    }
  }

  const sendKey = (code: number, modifiers: number, characters?: string): void => {
    for (const down of [true, false]) {
      const event = keyboard(null, code, down)
      send(event, () => {
        flags(event, modifiers)
        if (characters !== undefined) {
          const units = Uint16Array.from({ length: characters.length }, (_, index) => characters.charCodeAt(index))
          unicode(event, units.length, units)
        }
      })
    }
  }

  const typeText = (value: string): void => {
    let chunk = ''
    for (const character of value) {
      if (chunk.length + character.length > 20) {
        sendKey(0, 0, chunk)
        chunk = ''
      }
      chunk += character
    }
    if (chunk !== '') sendKey(0, 0, chunk)
  }

  return (action, observed) => {
    const { bounds } = screen.getPrimaryDisplay()
    if (bounds.width !== observed.width || bounds.height !== observed.height) {
      throw new Error('The Mac display changed. Observe it again before sending input.')
    }
    if (action.kind === 'text') {
      typeText(action.text)
      return
    }
    if (action.kind === 'key') {
      const parts = action.key.split('+')
      const key = parts.pop() ?? ''
      if (parts.length === 0 && key.length === 1) {
        typeText(key)
        return
      }
      let modifiers = 0
      for (const part of parts) {
        const flag = MODIFIER_FLAGS.get(part.toLowerCase())
        if (flag === undefined) throw new Error('Unknown Mac keyboard modifier.')
        modifiers |= flag
      }
      const code = VIRTUAL_KEYS[key.toLowerCase()]
      if (code === undefined) throw new Error('Unknown Mac key.')
      sendKey(code, modifiers)
      return
    }
    const point = { x: bounds.x + action.x, y: bounds.y + action.y }
    if (action.kind === 'move') {
      send(mouse(null, 5, point, 0))
    } else if (action.kind === 'scroll') {
      const event = wheel(null, 1, 1, -action.delta, 0, 0)
      send(event, () => { locate(event, point) })
    } else if (action.kind === 'click') {
      const button = action.button === 1 ? 0 : action.button === 2 ? 2 : 1
      const down = button === 0 ? 1 : button === 1 ? 3 : 25
      for (const type of [down, down + 1]) {
        const event = mouse(null, type, point, button)
        send(event, () => { setInteger(event, 1, 1) }) // kCGMouseEventClickState
      }
    } else {
      const target = { x: bounds.x + action.toX, y: bounds.y + action.toY }
      send(mouse(null, 1, point, 0))
      try {
        send(mouse(null, 6, target, 0))
      } finally {
        send(mouse(null, 2, target, 0))
      }
    }
  }
}

/**
 * Create the native desktop adapter. The main process owns capture, input and permission prompts.
 * @param parent - primary application window for the sharing confirmation.
 * @param messages - current native messages.
 * @param botName - resolve an active Bot from the local Host roster for the native prompt.
 * @returns local desktop facilities with lazy input bindings.
 */
export function macDesktop(parent: () => BrowserWindow | undefined, messages: () => DesktopMessages,
  botName: (sessionId: string, signal: AbortSignal) => Promise<string | undefined>): MacDesktop {
  let input: MacDesktop['input'] | undefined
  const graphics = koffi.load(CORE_GRAPHICS)
  const canPostEvents = graphics.func('bool CGPreflightPostEventAccess()')
  const requestPostEvents = graphics.func('bool CGRequestPostEventAccess()')
  const requestScreen = graphics.func('bool CGRequestScreenCaptureAccess()')
  return {
    permissions: () => ({
      screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      accessibility: Boolean(canPostEvents()),
      deviceControlLabel: MAC_VERSION >= 27,
    }),
    openSettings: async (permission) => {
      if (permission === 'accessibility') {
        if (requestPostEvents()) return
      } else if (requestScreen()) return
      await shell.openExternal(privacySettings(permission))
    },
    confirm: async (sessionId, signal) => {
      const name = await botName(sessionId, signal)
      const owner = parent()
      if (signal.aborted || name === undefined || owner === undefined || owner.isDestroyed() || !owner.isVisible()) return false
      const t = messages()
      const answer = await dialog.showMessageBox(owner, {
        type: 'question', message: formatDesktopMessage(t.macComputerConsent, { name }), detail: t.macComputerConsentDetail,
        buttons: [t.cancel, t.macComputerShare], defaultId: 0, cancelId: 0, signal,
      })
      return answer.response === 1
    },
    capture: async () => {
      const display = screen.getPrimaryDisplay()
      const { width, height } = display.bounds
      const scale = Math.min(1, 1440 / Math.max(width, height))
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
      })
      const source = sources.find(value => value.display_id === String(display.id))
      if (source === undefined || source.thumbnail.isEmpty()) throw new Error('macOS could not capture the primary display.')
      return { jpeg: source.thumbnail.toJPEG(76).toString('base64'), width, height }
    },
    input: (action, size) => { (input ??= createInput())(action, size) },
  }
}
