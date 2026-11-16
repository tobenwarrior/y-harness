import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig } from 'tsdown'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const workspaceModule = /^@yharness\/(?!node-addon-system)/u

function emittedModule(target: string): string | undefined {
  const source = /^(.*)\/src(?:\/([^*]+))?$/u.exec(target)
  if (source === null) return undefined
  const path = resolve(workspaceRoot, `${source[1]}/lib/types`, source[2] ?? 'index.ts')
  const compiled = path.replace(/\.([cm]?)tsx?$/u, '.$1js')
  const candidates = compiled === path ? [`${path}.js`, resolve(path, 'index.js')] : [compiled]
  return candidates.find(candidate => existsSync(candidate))
}

/** Resolve exact workspace aliases to JavaScript emitted before bundling starts. */
function workerModules(): Map<string, string> {
  const config = ts.readConfigFile(resolve(workspaceRoot, 'tsconfig.base.json'), ts.sys.readFile)
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    (config.config as { compilerOptions?: unknown }).compilerOptions, workspaceRoot,
  )
  if (errors.length > 0) {
    throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  }
  const modules = new Map<string, string>()
  for (const [specifier, targets] of Object.entries(options.paths ?? {})) {
    if (!workspaceModule.test(specifier) || specifier.includes('*')) continue
    const emitted = targets.map(emittedModule).find(candidate => candidate !== undefined)
    if (emitted !== undefined) modules.set(specifier, emitted)
  }
  return modules
}

function resolveWorkerModules() {
  const modules = workerModules()
  return {
    name: 'migration-worker-modules',
    resolveId: (specifier: string) => modules.get(specifier) ?? null,
  }
}

/** Build the backend and its path-loaded verifier as separate bundles. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/worker.js'],
    // Fresh verifiers need no host singleton identity. Inline their JavaScript
    // closure to avoid resolving and compiling workspace packages on every open.
    deps: { alwaysBundle: [workspaceModule] },
    // tsdown passes a falsy top-level tsconfig as its default. Override the
    // Rolldown input directly so this artifact never applies source aliases.
    tsconfig: false,
    inputOptions: { tsconfig: false },
    plugins: [resolveWorkerModules()],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
