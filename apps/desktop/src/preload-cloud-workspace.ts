/** Expose native window geometry to the isolated Cloud document through DOM attributes. */

import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'

markDocumentPlatform()
syncWindowFullscreen()

// The Cloud view sits over the local renderer. Its background must cover that view in both palettes.
const paintBackground = (): void => {
  document.body.style.backgroundColor = 'var(--yh-alias-bg-base, var(--dsh-boot-bg, Canvas))'
}
if (document.body === null) window.addEventListener('DOMContentLoaded', paintBackground, { once: true })
else paintBackground()
