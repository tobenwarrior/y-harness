/** Applies native window geometry to Cloud without exposing a renderer bridge. */

import { webFrame } from 'electron'
import { syncWindowFullscreen } from './preload-platform.ts'

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
