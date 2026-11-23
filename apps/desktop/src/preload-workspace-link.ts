/** Deliver native links to an existing workspace document. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/** Listen for workspace link fragments from the main process in this document. */
export function installWorkspaceLinkNavigation(): void {
  if (!process.isMainFrame) return
  ipcRenderer.on(DESKTOP_IPC.workspaceLinkNavigation, (_event, fragment: unknown) => {
    if (typeof fragment !== 'string' || !/^#\/(?:bots\/(?:prompt|open)|plugins\/add)\?/u.test(fragment)) return
    const oldURL = location.href
    const next = new URL(oldURL)
    next.hash = fragment
    history.replaceState(history.state, '', next.href)
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: next.href }))
  })
}
