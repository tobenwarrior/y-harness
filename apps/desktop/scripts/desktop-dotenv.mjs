/** Write release settings in a format that Node's dotenv parser reads literally. */

import { writeFile } from 'node:fs/promises'

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Serialize one dotenv value without exposing comment, quote, or newline delimiters.
 *
 * Node's built-in dotenv parser does not interpret escaped quote delimiters. A
 * value therefore uses the quote style it does not contain; values containing
 * both quote styles are kept bare only when the bare syntax is lossless.
 * @param {string} value - Value to serialize.
 * @returns {string} A dotenv value literal.
 */
export function serializeDesktopDotenvValue(value) {
  if (value.includes('\u0000') || value.includes('\r')) {
    throw new Error('desktop dotenv: values cannot contain NUL or carriage-return characters')
  }
  if (!value.includes("'") && !value.includes('\\n')) return `'${value}'`
  if (!value.includes('"') && !value.includes('#') && !value.includes('\n') && !/^\s|\s$/u.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`
  if (!value.includes('#') && !value.includes('\n') && !/^\s|\s$/u.test(value)) return value
  throw new Error('desktop dotenv: value contains unsupported quote or escape delimiters')
}

/**
 * Write selected process settings without printing their values.
 * @param {string} path - Destination dotenv file.
 * @param {readonly string[]} names - Environment variable names to write.
 * @param {NodeJS.ProcessEnv} environment - Source environment.
 * @returns {Promise<void>} Resolves after the file is written.
 */
export async function writeDesktopDotenvFile(path, names, environment = process.env) {
  const lines = names.map(name => {
    if (!VARIABLE_NAME.test(name)) throw new Error(`desktop dotenv: invalid variable name ${name}`)
    const value = environment[name]
    if (value === undefined) throw new Error(`desktop dotenv: required setting ${name} is missing`)
    return `${name}=${serializeDesktopDotenvValue(value)}`
  })
  await writeFile(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const outputIndex = process.argv.indexOf('--output')
  const path = outputIndex === -1 ? undefined : process.argv[outputIndex + 1]
  const names = outputIndex === -1 ? [] : process.argv.slice(outputIndex + 2)
  if (path === undefined || path.startsWith('--') || names.length === 0) {
    throw new Error('desktop dotenv: --output requires a path and at least one setting name')
  }
  await writeDesktopDotenvFile(path, names)
}
