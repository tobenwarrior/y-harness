/** Stateful multibyte decoding through the Worker builtin table. */
import { describe, expect, it } from 'vitest'
import { StringDecoder as NodeStringDecoder } from 'node:string_decoder'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { MODULE_PROXIES } from '../../src/module-proxies.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { isBuiltin } from '../../src/node/builtin_modules/implemented/module.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

describe('Worker string decoding', () => {
  describe.each(['node:string_decoder', 'string_decoder'])('%s compatibility', (specifier) => {
    it.each(['utf8', 'ascii', 'latin1', 'hex', 'utf16le', 'base64', 'base64url'] as const)('decodes typed byte views with %s', (encoding) => {
      const loader = new WorkerModuleLoader({ vfs: new MemoryVfs(), root: '/dsh', staticModules: createNodeBuiltins() })
      const namespace = loader.createRequire('/dsh/')(specifier) as typeof import('node:string_decoder')
      const decoder = new namespace.StringDecoder(encoding)
      const oracle = new NodeStringDecoder(encoding)
      const first = Uint8Array.from([97, 98])
      const final = new DataView(Uint8Array.from([99, 100]).buffer)
      expect(decoder.write(first)).toBe(oracle.write(first))
      expect(decoder.end(final)).toBe(oracle.end(final))
    })

    it('decodes split URL-safe base64 bytes while returning string input unchanged', () => {
      const loader = new WorkerModuleLoader({ vfs: new MemoryVfs(), root: '/dsh', staticModules: createNodeBuiltins() })
      const namespace = loader.createRequire('/dsh/')(specifier) as typeof import('node:string_decoder')
      const decoder = new namespace.StringDecoder('base64url')
      const oracle = new NodeStringDecoder('base64url')
      const first = Uint8Array.from([0xfb])
      const final = Uint8Array.from([0xff, 0xff])
      expect(decoder.write(first)).toBe(oracle.write(first))
      expect(decoder.write('+=/')).toBe(oracle.write('+=/'))
      expect(decoder.end(final)).toBe(oracle.end(final))
      expect(decoder.end(Uint8Array.from([0xfb]))).toBe(oracle.end(Uint8Array.from([0xfb])))
    })

    it('preserves pending bytes through string writes and resets after end', () => {
      const loader = new WorkerModuleLoader({ vfs: new MemoryVfs(), root: '/dsh', staticModules: createNodeBuiltins() })
      const namespace = loader.createRequire('/dsh/')(specifier) as typeof import('node:string_decoder')
      const decoder = new namespace.StringDecoder('utf8')
      const oracle = new NodeStringDecoder('utf8')
      const prefix = Uint8Array.from([0xe4, 0xb8])
      const final = Uint8Array.from([0xad])
      expect(decoder.write(prefix)).toBe(oracle.write(prefix))
      expect(decoder.write('ready')).toBe(oracle.write('ready'))
      expect(decoder.end(final)).toBe(oracle.end(final))
      const incomplete = Uint8Array.from([0xe4])
      expect(decoder.write(incomplete)).toBe(oracle.write(incomplete))
      expect(decoder.end('tail')).toBe(oracle.end('tail'))
      const trailing = Uint8Array.from([0xb8, 0xad])
      expect(decoder.write(trailing)).toBe(oracle.write(trailing))
      expect(decoder.end()).toBe(oracle.end())
    })
  })

  it.each(['node:string_decoder', 'string_decoder'])('accepts Node byte views through %s', (specifier) => {
    const loader = new WorkerModuleLoader({ vfs: new MemoryVfs(), root: '/dsh', staticModules: createNodeBuiltins() })
    const namespace = loader.createRequire('/dsh/')(specifier) as typeof import('node:string_decoder')
    const backing = Uint8Array.from([0, 0xe4, 0xb8, 0xad, 0])
    const inputs = [
      new Uint8Array(backing.buffer, 1, 3),
      new DataView(backing.buffer, 1, 3),
      new Uint16Array(Uint8Array.from([97, 98, 99, 100]).buffer),
    ]
    for (const input of inputs) {
      const decoder = new namespace.StringDecoder('utf8')
      const oracle = new NodeStringDecoder('utf8')
      expect(decoder.write(input)).toBe(oracle.write(input))
      expect(decoder.end()).toBe(oracle.end())
    }
    const decoder = new namespace.StringDecoder('utf8')
    const oracle = new NodeStringDecoder('utf8')
    const first = Uint8Array.from([0xe4, 0xb8])
    const final = new DataView(Uint8Array.from([0xad]).buffer)
    expect(decoder.write(first)).toBe(oracle.write(first))
    expect(decoder.end(final)).toBe(oracle.end(final))
    expect(decoder.write('ready')).toBe(oracle.write('ready'))
  })

  it.each(['node:string_decoder', 'string_decoder'])('decodes split multibyte input through %s', (specifier) => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
    const lowered = lowerModuleSource({ filename: '/dsh/probe.js', source: `
      import { StringDecoder } from '${specifier}';
      export function decode(chunks) {
        const decoder = new StringDecoder('utf8');
        return chunks.map(chunk => decoder.write(chunk)).join('') + decoder.end();
      }
    ` })
    expect(MODULE_PROXIES[specifier]).toBe('./node/builtin_modules/implemented/string_decoder.ts')
    expect(isBuiltin(specifier)).toBe(true)
    expect(loader.resolve(specifier, '/dsh')).toMatchObject({ kind: 'static' })
    vfs.writeFileSync('/dsh/probe.js', lowered.code)
    const probe = loader.createRequire('/dsh/')('./probe.js') as { decode: (chunks: Buffer[]) => string }
    const input = Buffer.from('a中文😀z')
    const chunks = Array.from(input, byte => Buffer.from([byte]))
    expect(probe.decode(chunks)).toBe('a中文😀z')
    const incomplete = Buffer.from([0xe4, 0xb8])
    const oracle = new NodeStringDecoder('utf8')
    expect(probe.decode([incomplete])).toBe(oracle.write(incomplete) + oracle.end())
  })
})
