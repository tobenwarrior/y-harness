/** Applies native window geometry to Cloud without exposing a renderer bridge. */

import { ipcRenderer, webFrame } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { CLOUD_EXTERNAL_URL_MAX_LENGTH } from './cloud-workspace-document.ts'
import { syncWindowFullscreen } from './preload-platform.ts'

/** Forward only trusted primary clicks on links explicitly marked by the product UI. */
function installExternalLinkHandler(): void {
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest<HTMLAnchorElement>('a[data-yh-open-external]')
    if (anchor === null) return
    event.preventDefault()
    const url = anchor.href
    if (url.length === 0 || url.length > CLOUD_EXTERNAL_URL_MAX_LENGTH) return
    ipcRenderer.send(DESKTOP_IPC.cloudOpenExternal, url)
  }, true)
}

// Cloud keeps the Web keyboard adapter. Reserve the local traffic lights
// without the platform marker that would require the native keyboard bridge.
void webFrame.insertCSS(`
  html:not([data-fullscreen]) {
    --yh-cloud-window-inset: 36px;
    --dsh-frame-overlay-top: calc(var(--yh-cloud-window-inset) + 20px);
  }
  html:not([data-fullscreen]) [data-yh-part="sidebar-column"],
  html:not([data-fullscreen]) [data-sidebar-collapsed] > [data-yh-part="center-column"] {
    padding-block-start: var(--yh-cloud-window-inset);
  }
  html:not([data-fullscreen]) [data-yh-part="sidebar-column"] {
    position: relative;
  }
  html:not([data-fullscreen]) [data-yh-part="sidebar-column"]::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    height: var(--yh-cloud-window-inset);
    -webkit-app-region: drag;
  }
`)
syncWindowFullscreen()
installExternalLinkHandler()
