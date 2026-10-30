/**
 * Gate for the invariant `FALLBACK_LOCALE` rests on: every shipped dictionary
 * declares an English key set.
 *
 * The locale runtime resolves a key through the active locale, then through
 * the single fallback locale (`en`), then surfaces the key itself. With
 * an English dictionary makes that middle step resolve, so a missing English
 * key would otherwise surface a bare key such as `list.aria` in the UI.
 *
 * Discovery is deliberately broad, because a gate that silently narrows is
 * worse than no gate. It sweeps every workspace package (not just
 * `packages/client`), reads dictionaries wherever they are declared —
 * `locales.ts`, a `locales/` directory, or inline in the plugin body. Retired
 * locale compatibility exports are aliases and are not dictionaries.
 */

import type { Dirent } from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Repo-relative path with `/` separators, so messages and suffix tests match on every OS. */
function relative(file: string): string {
  return file.slice(root.length).replaceAll('\\', '/')
}

/** Every `.ts` source file under each workspace package's `src`, excluding declarations. */
function sourceFiles(): string[] {
  const files: string[] = []
  const packagesRoot = resolve(root, 'packages')
  for (const group of directories(packagesRoot)) {
    for (const pkg of directories(resolve(packagesRoot, group))) {
      walk(resolve(packagesRoot, group, pkg, 'src'), files)
    }
  }
  return files.sort()
}

/** Immediate subdirectory names, or none when the path is not a directory. */
function directories(dir: string): string[] {
  return readEntries(dir).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/**
 * Directory entries, treating only a genuinely absent directory as empty.
 * Any other failure (`EACCES`, I/O) rethrows: silently reading it as "absent"
 * would narrow the sweep and let the gate pass while checking less.
 * @param dir - absolute directory path.
 * @returns entries, or none when the directory does not exist.
 */
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function walk(dir: string, out: string[]): void {
  for (const entry of readEntries(dir)) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
}

/** One discovered dictionary: which file and export name declared it. */
interface Dictionary {
  /** Repo-relative declaring file. */
  file: string
  /** Export name, or the registration site for an inline literal. */
  name: string
  /** Declared keys, sorted. */
  keys: string[]
}

/**
 * Keys of every top-level `export const <name> = { ... }` object literal whose
 * name identifies a locale dictionary, plus inline `register(ns, locale, {...})`
 * literals. Read from the AST so the gate never executes package code.
 * @param file - absolute path of a candidate module.
 * @returns discovered dictionaries, keyed by locale-bearing name.
 */
function dictionariesIn(file: string): Dictionary[] {
  const text = readFileSync(file, 'utf8')
  // Cheap pre-filter: parsing every package source is wasteful. The pattern
  // must admit every shape `localeOf` accepts, or a file would be skipped
  // before parsing — the silent narrowing this gate exists to prevent. A bare
  // `\ben\b` misses `enSettings`/`settingsEn`, because `\b` does not hold
  // between `n` and an uppercase letter.
  if (!/\ben\b|\ben[A-Z]|En\b/.test(text)) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const found: Dictionary[] = []
  const rel = relative(file)

  // Module-scope variable declarations, keyed by name. A 3-arg
  // `register(NS, 'en', dict)` whose third argument is an identifier —
  // e.g. a local dictionary variable rather than an inline literal — resolves
  // through here so the gate still verifies the English registration.
  const moduleConsts = new Map<string, ts.Expression>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
        moduleConsts.set(decl.name.text, decl.initializer)
      }
    }
  }

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) !== true) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const literal = unwrap(decl.initializer)
      if (literal === undefined || !ts.isObjectLiteralExpression(literal)) continue
      if (localeOf(decl.name.text) === undefined) continue
      found.push({ file: rel, name: decl.name.text, keys: keysOf(literal) })
    }
  }

  // A 3-arg `register(ns, 'en', dict)` call whose dictionary argument we
  // cannot turn into an object literal. We refuse instead of skipping: a
  // registration we cannot measure is exactly the silent narrowing this gate
  // exists to catch.
  const refuse = (ns: string, tag: string, why: string): never => {
    throw new Error(`cannot verify register('${ns}', '${tag}', ...) in ${rel}: ${why}`)
  }

  // Inline English registrations, two shapes. A `[['en', {...}]]` array
  // handed to a registration loop keys off the enclosing array; a direct
  // `register(NS, 'en', {...})` call keys off the namespace argument.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee) && callee.text === 'register' ? 'register' : undefined
      if (name === 'register' && node.arguments.length >= 3) {
        const [ns, tag, dict] = node.arguments
        if (ns === undefined || tag === undefined || !ts.isStringLiteral(tag)) return
        if (tag.text !== 'en') return
        const raw = unwrap(dict)
        const literal = raw !== undefined && ts.isIdentifier(raw)
          ? (() => {
            const resolved = moduleConsts.get(raw.text)
            return resolved === undefined ? undefined : unwrap(resolved)
          })()
          : raw
        const why = raw !== undefined && ts.isIdentifier(raw)
          ? `third argument ${raw.text} does not resolve to an inline or module-scope object literal`
          : 'third argument is neither an object literal nor a resolvable dictionary variable'
        if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
          // The dictionary argument must resolve to an object literal; the
          // gate refuses rather than skips, so the English coverage it verifies
          // never silently narrows.
          refuse(ns.getText(source), tag.text, why)
        }
        const dictionary: ts.ObjectLiteralExpression = literal as ts.ObjectLiteralExpression
        // The namespace expression's source text identifies the registration
        // site, so calls for different namespaces stay distinct.
        found.push({ file: rel, name: `${tag.text}@register:${ns.getText(source)}`, keys: keysOf(dictionary) })
      }
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 2) {
      const site = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      for (const element of node.elements) {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) continue
        const [tag, dict] = element.elements
        const literal = unwrap(dict)
        if (tag === undefined || !ts.isStringLiteral(tag)) continue
        if (literal === undefined || !ts.isObjectLiteralExpression(literal)) continue
        if (tag.text !== 'en') continue
        found.push({ file: rel, name: `${tag.text}@inline:${site}`, keys: keysOf(literal) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Declared property names of an object literal, sorted. */
function keysOf(literal: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = []
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text)
  }
  return keys.sort()
}

/** Look through `satisfies`/`as`/parenthesized wrappers to the literal. */
function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node
  while (
    current !== undefined
    && (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/**
 * The English dictionary a declaration names. `en`, `enSettings`, and
 * `settingsEn` are the shapes this repo uses. A name-prefix shape requires an
 * uppercase ASCII letter at the third position (`[A-Z]`), matching the
 * admission of the cheap pre-filter.
 * @param name - export name or synthetic inline name.
 * @returns the English namespace key, or undefined for another name.
 */
function localeOf(name: string): { locale: 'en'; pair: string } | undefined {
  if (name === 'en') return { locale: 'en', pair: '' }
  if (name.startsWith('en@')) return { locale: 'en', pair: name.slice(name.indexOf(':')) }
  if (name.startsWith('en') && name.length > 2 && /[A-Z]/.test(name[2] ?? '')) {
    return { locale: 'en', pair: name.slice(2) }
  }
  if (name.endsWith('En')) return { locale: 'en', pair: name.slice(0, -2) }
  return undefined
}

describe('shipped locale dictionaries', () => {
  it('declares English dictionaries and contains no CJK dictionary copy', () => {
    const files = sourceFiles()
    // Guard the discovery itself: an empty or narrowed sweep would pass every
    // assertion below while checking nothing.
    expect(files.length).toBeGreaterThan(500)

    const dictionaries = files.flatMap(file => dictionariesIn(file))
    const english = dictionaries.filter(dictionary => localeOf(dictionary.name) !== undefined)
    expect(english.length).toBeGreaterThan(25)

    const empty = english.filter(dictionary => dictionary.keys.length === 0)
    expect(empty).toEqual([])

    const dictionaryFiles = files.filter(file => {
      const rel = relative(file)
      return rel.startsWith('/packages/client/')
        && !rel.endsWith('/packages/client/web/src/boot-locales.ts')
        && (rel.includes('/locales/') || /(?:^|\/)locales?\.ts$/.test(rel)
          || rel.endsWith('/guide-locales.ts')
          || rel.endsWith('/ui-directory-picker-browse/src/client/index.ts'))
    })
    const cjk = dictionaryFiles.filter(file => /\p{sc=Han}/u.test(readFileSync(file, 'utf8')))
    expect(cjk).toEqual([])
  })
})
