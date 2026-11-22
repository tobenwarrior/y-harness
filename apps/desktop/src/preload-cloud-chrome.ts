/** Applies native window geometry and prompt navigation to the Cloud workspace. */

import { installBotPromptNavigation } from './preload-bot-prompt.ts'
import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'

markDocumentPlatform()
syncWindowFullscreen()
if (location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.pathname === '/') {
  installBotPromptNavigation()
}
