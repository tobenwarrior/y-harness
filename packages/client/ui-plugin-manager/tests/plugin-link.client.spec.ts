import { describe, expect, it } from 'vitest'
import { officialPluginLink, parseOfficialPluginLink } from '../src/client/plugin-link.ts'

const ORIGIN = 'https://harness.test'
const link = (query: string): URL => new URL(`${ORIGIN}/#/plugins/add?${query}`)

describe('official plugin links', () => {
  it('reads an exact catalog item or official bundle in the current app', () => {
    expect(parseOfficialPluginLink(link('id=codex'), ORIGIN)).toBe('codex')
    expect(parseOfficialPluginLink(link('id=%40yharness%2Fsubagent-codex'), ORIGIN)).toBe('@yharness/subagent-codex')
    expect(parseOfficialPluginLink(new URL('dsh-app://app/#/plugins/add?id=codex'), 'null')).toBe('codex')
  })

  it.each(['', 'id=', 'id=codex&id=claude', 'id=codex&enable=true', 'id=codex#next',
    'id=https%3A%2F%2Fother.test', 'id=../codex', 'id=@other/package'])('rejects invalid link fields: %s', (query) => {
    expect(parseOfficialPluginLink(link(query), ORIGIN)).toBeUndefined()
  })

  it('rejects another origin even when the path and id look valid', () => {
    expect(parseOfficialPluginLink(link('id=codex'), 'https://other.test')).toBeUndefined()
    expect(parseOfficialPluginLink(new URL('dsh-app://untrusted/#/plugins/add?id=codex'), 'null')).toBeUndefined()
  })

  it('copies the app path and id with no private URL fields', () => {
    const web = new URL('https://owner:secret@harness.test//mount/?token=private#current')
    expect(officialPluginLink(web, 'codex', false)).toBe(`${ORIGIN}//mount/#/plugins/add?id=codex`)
    expect(officialPluginLink(web, 'codex', true)).toBe('dsh://plugins/add?id=codex')
  })
})
