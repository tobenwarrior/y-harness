/** Read the optional public display-name override without changing application identity. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Read the display name used by browser and native build projections.
 * @param {string} root - Repository containing app-branding.json.
 * @returns {string | undefined} Configured display name, or undefined to retain current labels.
 * @throws {Error} If the public configuration cannot be read or its name is invalid.
 */
export function readAppDisplayName(root = fileURLToPath(new URL('..', import.meta.url))) {
  const path = resolve(root, 'app-branding.json')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('app-branding.json must contain a displayName string or null')
  }
  if (value.displayName === null) return undefined
  if (typeof value.displayName !== 'string' || value.displayName.trim() === ''
    || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value.displayName)) {
    throw new Error('app-branding.json displayName must be a non-empty single-line string or null')
  }
  return value.displayName.trim()
}
