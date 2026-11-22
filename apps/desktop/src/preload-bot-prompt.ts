/** Deliver native Bot links to an existing workspace document. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/** Listen for prompt fragments from the main process in this workspace document. */
export function installBotPromptNavigation(): void {
  if (!process.isMainFrame) return
  ipcRenderer.on(DESKTOP_IPC.botPromptNavigation, (_event, fragment: unknown) => {
    if (typeof fragment !== 'string' || !fragment.startsWith('#/bots/prompt?')) return
    const oldURL = location.href
    const next = new URL(oldURL)
    next.hash = fragment
    history.replaceState(history.state, '', next.href)
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: next.href }))
  })
}
