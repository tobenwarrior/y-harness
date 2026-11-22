// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { webFrame } from 'electron'

vi.mock('electron', () => ({
  ipcRenderer: { on: vi.fn() },
  webFrame: { insertCSS: vi.fn(async () => 'cloud-chrome') },
}))

it('reserves the window controls without requiring the desktop keyboard bridge in Cloud', async () => {
  await import('../src/preload-cloud-chrome.ts')
  expect(document.documentElement.hasAttribute('data-platform')).toBe(false)
  expect(webFrame.insertCSS).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[data-yh-part="sidebar-column"]'))
})
