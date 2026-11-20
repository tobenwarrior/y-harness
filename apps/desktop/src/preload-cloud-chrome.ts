/** Applies native window geometry to Cloud without exposing a renderer bridge. */

import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'

markDocumentPlatform()
syncWindowFullscreen()
