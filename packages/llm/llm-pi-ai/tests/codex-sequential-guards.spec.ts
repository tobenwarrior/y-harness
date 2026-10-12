/** Stable-profile guards use fixture config and public projected history only. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionSnapshot } from '@deepseek-ai/dsh-coding-session/types'
import { assertSavedPrefix, disabledServerMap, restrictionArguments, restrictedConfig, verifyRestrictedConfig, verifyManagedRequirements } from '../src/codex-sequential-guards.ts'

const config = { features: { apps: true, plugins: true }, notify: ['fixture-hook'], mcp_servers: {
  'literal.name': { command: 'fixture-server', enabled: true }, 'quote"name': { url: 'https://fixture.invalid' },
} }
const source: CodingSessionSnapshot['source'] = { provider: 'codex', profileId: brandString<CodingSessionSnapshot['source']['profileId']>('fixture-profile'), nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('fixture-original') }
const snapshot = (digests: string[]): CodingSessionSnapshot => ({ source, title: 'Fixture', cwd: '/fixture/project', writerState: 'idle', cursor: 'fixture-cursor',
  events: digests.map((digest, i) => ({ id: brandString<CodingSessionSnapshot['events'][number]['id']>(JSON.stringify(['fixture-turn', `item-${i}`])), role: 'assistant', text: `text-${i}`, digest })) })
describe('Codex stable-profile sequential guards', () => {
  it('enumerates literal server names and disables observed names without splitting dots', () => {
    const map = disabledServerMap(config, 10)
    expect(map).toEqual({ 'literal.name': { enabled: false }, 'quote"name': { enabled: false } })
    expect(restrictionArguments(map)).toContain('mcp_servers={"literal.name"={enabled=false},"quote\\"name"={enabled=false}}')
    const effective = restrictedConfig(config, map)
    expect(effective.mcp_servers).toEqual({ 'literal.name': { command: 'fixture-server', enabled: false }, 'quote"name': { url: 'https://fixture.invalid', enabled: false } })
    expect(() => { verifyRestrictedConfig(effective, effective) }).not.toThrow()
  })
  it('refuses new server names, changed settings and re-enabled hooks before turn admission', () => {
    const expected = restrictedConfig(config, disabledServerMap(config, 10))
    expect(() => {
      verifyRestrictedConfig(expected, { ...expected, mcp_servers: { ...config.mcp_servers, added: { enabled: false } } })
    }).toThrow(/changed/)
    expect(() => { verifyRestrictedConfig(expected, { ...expected, notify: ['new-hook'] }) }).toThrow(/changed/)
    expect(() => { verifyRestrictedConfig(expected, { ...expected, features: { ...config.features, hooks: true } }) }).toThrow(/changed/)
  })
  it('rejects malformed, too many and control-character server names', () => {
    expect(() => disabledServerMap({ mcp_servers: [] }, 10)).toThrow()
    expect(() => disabledServerMap(config, 1)).toThrow()
    expect(() => disabledServerMap({ mcp_servers: { 'bad\nname': {} } }, 10)).toThrow()
  })
  it('accepts an exact retained saved prefix and refuses source, item and digest divergence', () => {
    expect(() => { assertSavedPrefix(snapshot(['a']), snapshot(['a', 'b'])) }).not.toThrow()
    expect(() => { assertSavedPrefix(snapshot(['a']), snapshot(['different'])) }).toThrow(/prefix/)
    expect(() => { assertSavedPrefix(snapshot(['a']), snapshot([])) }).toThrow(/prefix/)
    expect(() => {
      assertSavedPrefix(snapshot(['a']), { ...snapshot(['a']), source: {
        ...source, nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('replacement'),
      } })
    }).toThrow(/source/)
  })
  it('accepts absent, null and false public feature requirements and refuses managed forced-on aliases', () => {
    expect(verifyManagedRequirements({}, 10, 10000)).toBeNull()
    expect(verifyManagedRequirements({ requirements: null }, 10, 10000)).toBeNull()
    expect(verifyManagedRequirements({ requirements: {} }, 10, 10000)).toEqual({})
    expect(verifyManagedRequirements({ requirements: { featureRequirements: { shell_tool: false } } }, 10, 10000))
      .toEqual({ featureRequirements: { shell_tool: false } })
    for (const name of ['shell_tool', 'code_mode_host', 'apps', 'plugins', 'hooks', 'multi_agent', 'imagegen', 'imagegenext', 'unknown_future_capability']) {
      expect(() => verifyManagedRequirements({ requirements: { featureRequirements: { [name]: true } } }, 10, 10000)).toThrow(/forced-on/)
    }
  })
  it('refuses malformed, wrong-case, unbounded managed requirement responses', () => {
    expect(() => verifyManagedRequirements({ requirements: { featureRequirements: { shell_tool: 'true' } } }, 10, 10000)).toThrow()
    expect(() => verifyManagedRequirements({ requirements: { feature_requirements: { shell_tool: true } } }, 10, 10000))
      .toThrow(/unsupported field/)
    expect(() => verifyManagedRequirements({ requirements: { featureRequirements: { a: false, b: false } } }, 1, 10000))
      .toThrow(/entry limit/)
    expect(() => verifyManagedRequirements({ requirements: { featureRequirements: { a: false } } }, 10, 1)).toThrow(/byte limit/)
  })

  it('excludes supported legacy aliases as well as their native canonical capabilities', () => {
    const aliases = { connectors: true, web_search: true, imagegenext: true, collab: true, memory_tool: true,
      telepathy: true, codex_hooks: true, request_permissions: true }
    const expected = restrictedConfig({ features: aliases }, {})
    expect(expected.features).toMatchObject(Object.fromEntries(Object.keys(aliases).map(name => [name, false])))
    expect(expected.features).toMatchObject({ apps: false, web_search_request: false, image_generation: false, multi_agent: false,
      memories: false, chronicle: false, hooks: false, exec_permission_approvals: false })
    for (const name of Object.keys(aliases)) expect(restrictionArguments({})).toContain(`features.${name}=false`)
  })

})
