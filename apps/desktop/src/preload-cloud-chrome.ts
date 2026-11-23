/** Applies native window geometry and workspace-link navigation to the Cloud workspace. */

import { installWorkspaceLinkNavigation } from './preload-workspace-link.ts'
import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'

markDocumentPlatform()
syncWindowFullscreen()
if (location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.pathname === '/') {
  installWorkspaceLinkNavigation()
}
