// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'

const { insertCSS, send } = vi.hoisted(() => ({
  insertCSS: vi.fn(async () => 'cloud-chrome'),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcRenderer: { on: vi.fn(), send },
  webFrame: { insertCSS },
}))

let externalClick: ((event: MouseEvent) => void) | undefined

beforeAll(async () => {
  const addEventListener = vi.spyOn(document, 'addEventListener')
  await import('../src/preload-cloud-chrome.ts')
  const listener = addEventListener.mock.calls.find(([type]) => type === 'click')?.[1]
  if (typeof listener !== 'function') throw new Error('Cloud external click listener was not installed')
  externalClick = (event) => { listener(event) }
  addEventListener.mockRestore()
})

it('reserves the window controls without requiring the desktop keyboard bridge in Cloud', () => {
  expect(document.documentElement.hasAttribute('data-platform')).toBe(false)
  expect(insertCSS).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[data-yh-part="sidebar-column"]'))
})

it('forwards only trusted marked primary clicks with bounded URLs', () => {
  send.mockClear()
  const unmarked = document.createElement('a')
  unmarked.href = 'https://docs.example.com/unmarked'
  unmarked.textContent = 'unmarked'
  const marked = document.createElement('a')
  marked.href = 'https://docs.example.com/release'
  marked.dataset.yhOpenExternal = ''
  marked.textContent = 'release'
  const oversized = document.createElement('a')
  oversized.href = `https://docs.example.com/${'x'.repeat(2_048)}`
  oversized.dataset.yhOpenExternal = ''
  document.body.append(unmarked, marked, oversized)

  const click = (element: HTMLAnchorElement, trusted: boolean, modifiers = {}): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers })
    const trustedEvent = new Proxy(event, {
      get(target, property) {
        if (property === 'isTrusted') return trusted
        if (property === 'target') return element
        if (property === 'preventDefault') return target.preventDefault.bind(target)
        return target[property as keyof MouseEvent]
      },
    })
    externalClick?.(trustedEvent)
    return event
  }
  const unmarkedClick = click(unmarked, true)
  expect(unmarkedClick.defaultPrevented).toBe(false)
  expect(click(marked, false).defaultPrevented).toBe(false)
  expect(click(marked, true).defaultPrevented).toBe(true)
  expect(send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.cloudOpenExternal, 'https://docs.example.com/release')
  expect(click(marked, true, { metaKey: true }).defaultPrevented).toBe(false)
  expect(click(oversized, true).defaultPrevented).toBe(true)
  expect(send).toHaveBeenCalledOnce()
})
