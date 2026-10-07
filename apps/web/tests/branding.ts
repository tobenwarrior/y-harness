/** Product display text for Host-side browser tests, without browser package imports. */
import { fileURLToPath } from 'node:url'
import { readAppDisplayName } from '../../../scripts/app-branding.mjs'

/** Canonical display name consumed by a complete build of this checkout. */
export const WEB_DISPLAY_NAME = readAppDisplayName(fileURLToPath(new URL('../../..', import.meta.url)))

/**
 * Project a locale-owned product label into its browser-test expectation.
 * @param text - Copy containing the shipped Y Harness product name.
 * @returns Configured product copy, or the original value when no name is configured.
 */
export function webProductCopy(text: string): string {
  return WEB_DISPLAY_NAME === undefined ? text : text.replace(/Y Harness/g, () => WEB_DISPLAY_NAME)
}
