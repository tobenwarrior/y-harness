import { describe, expect, it } from 'vitest'
import { projectProvider, parseProvider, schemaFingerprint, canonicalJson, hasExcludedModelFields } from '../src/profile.ts'

describe('ordinary provider configuration projection', () => {
  it('keeps catalog choices and excludes local access and unknown fields recursively', () => {
    const ordinary = { displayName: 'Example', models: [{ id: 'same', name: 'Same', input: ['text'], reasoningEfforts: { high: 'high' } }] }
    expect(projectProvider({ ...ordinary, apiKeyEnv: 'SOURCE_PRIVATE_REF', headers: { Authorization: 'fabricated-token' }, token: 'fabricated',
      models: [{ ...ordinary.models[0], apiKey: 'fabricated', headers: { Cookie: 'fabricated' } }] })).toEqual(ordinary)
  })

  it.each(['https://user:password@example.test/v1', 'https://example.test/v1?key=fabricated', 'https://example.test/#fabricated', 'file:///tmp/fixture'])('refuses credential-bearing or unsupported endpoints without echoing them (%s)', (baseURL) => {
    expect(() => projectProvider({ baseURL })).toThrow('Provider endpoint is not safe to synchronize')
  })

  it('refuses unrecognized fields in a shared payload instead of accepting credentials', () => {
    expect(() => parseProvider({ models: [{ id: 'model', headers: { token: 'fabricated' } }] })).toThrow('Unsupported shared provider configuration')
    expect(() => parseProvider({ apiKeyEnv: 'SOURCE_REF' })).toThrow('Unsupported shared provider configuration')
  })

  it('compares schemas independent of property insertion order', () => {
    expect(schemaFingerprint({ type: 'object', dict: { a: { type: 'string' }, b: { type: 'number' } } }))
      .toBe(schemaFingerprint({ dict: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' }))
    expect(schemaFingerprint({ type: 'string' })).not.toBe(schemaFingerprint({ type: 'number' }))
  })

  it('normalizes Schemastery process-local node identities while retaining schema differences', () => {
    const a = { uid: 9, refs: { 9: { type: 'object', dict: { field: 10 } }, 10: { type: 'string', meta: {} } } }
    const b = { uid: 99, refs: { 101: { meta: {}, type: 'string' }, 99: { dict: { field: 101 }, type: 'object' } } }
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b))
    expect(schemaFingerprint(a)).not.toBe(schemaFingerprint({ uid: 99, refs: { 99: { type: 'object', dict: { field: 101 } }, 101: { type: 'number', meta: {} } } }))
  })

  it('keeps the adapter-supported Max effort without blocking other providers', () => {
    const profile = { models: [{ id: 'model', reasoningEfforts: { max: 'max' }, defaultReasoning: 'max' }] }
    expect(projectProvider(profile)).toEqual(profile)
    expect(parseProvider(profile)).toEqual(profile)
  })

  it('rejects malformed local ordinary fields and endpoints without quoting their contents', () => {
    expect(() => projectProvider({ models: 'malformed' })).toThrow('Unsupported local provider configuration')
    expect(() => projectProvider({ baseURL: 'not-a-url' })).toThrow('Provider endpoint is not safe to synchronize')
    expect(canonicalJson(undefined)).toBe('null')
    expect(hasExcludedModelFields(null)).toBe(true)
    expect(hasExcludedModelFields('malformed')).toBe(true)
  })

  it('normalizes shared, cyclic, list and keyed schema references while rejecting broken references', () => {
    const graph = { uid: 1, refs: { 1: { type: 'union', list: [2, 3] }, 2: { type: 'dict', inner: 4, sKey: 5 },
      3: { type: 'object', dict: { again: 4, self: 3 } }, 4: { type: 'string' }, 5: { type: 'string' } } }
    expect(schemaFingerprint(graph)).toMatch(/^[a-f0-9]{64}$/)
    expect(() => schemaFingerprint({ uid: 1, refs: {} })).toThrow('Unsupported provider configuration schema')
  })
})
