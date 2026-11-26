/** Reserve space for the macOS caption in the isolated Cloud Web document. */

import { syncWindowFullscreen } from './preload-platform.ts'

syncWindowFullscreen()

// The Cloud document uses Web shortcuts and has no native keyboard bridge.
const installCaption = (): void => {
  const style = document.createElement('style')
  style.textContent = `
    html { --yh-cloud-caption-height: 36px; --dsh-frame-overlay-top: calc(20px + var(--yh-cloud-caption-height)); }
    html[data-fullscreen] { --yh-cloud-caption-height: 0px; }
    html body {
      box-sizing: border-box;
      padding-block-start: var(--yh-cloud-caption-height);
      background-color: var(--yh-alias-bg-base, var(--dsh-boot-bg, Canvas));
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0 0 auto;
      height: var(--yh-cloud-caption-height);
      pointer-events: none;
      -webkit-app-region: drag;
    }
  `
  document.head.append(style)
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', installCaption, { once: true })
else installCaption()
