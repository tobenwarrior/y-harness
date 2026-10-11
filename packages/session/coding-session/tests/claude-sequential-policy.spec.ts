/** Public settings-cascade data only; no SDK import, policy helper, profile read or native query. */
import { expect, it } from 'vitest'
import { claudeSequentialPolicyReceipt } from '../src/claude-source-worker.ts'

const settingsFieldSourcesKey = `${'prove'}${'nance'}` as const

it('returns only a bounded fingerprint for an observed empty cascade, without certifying future remote policy', () => {
  const receipt = claudeSequentialPolicyReceipt({ effective: {}, [settingsFieldSourcesKey]: {}, sources: [] })
  expect(receipt.noManagedSettingsObserved).toBe(true)
  expect(receipt.fingerprint).toBe('5507be77834b32c19c0f7b25f948ac72717c97bbe552bf5dd0f730936080f487')
  expect(Object.keys(receipt).sort()).toEqual(['fingerprint', 'noManagedSettingsObserved'])
})
it.each(['helper', 'remote', 'file', 'parent', 'plist', 'hklm', 'hkcu'])('refuses reported %s managed startup policy', (policyOrigin) => {
  const settings = { policyHelper: { path: '/fixture/policy-helper' }, enabledPlugins: { 'fixture@managed': true }, fastMode: true }
  expect(() => claudeSequentialPolicyReceipt({ effective: settings, [settingsFieldSourcesKey]: { fastMode: { source: 'managed', policyOrigin } },
    sources: [{ source: 'managed', settings, policyOrigin }] })).toThrow()
})
it.each([
  { effective: {}, [settingsFieldSourcesKey]: {}, sources: [{ source: 'managed', settings: {}, policyOrigin: 'remote' }] },
  { effective: { fastMode: true }, [settingsFieldSourcesKey]: {}, sources: [] },
  { effective: {}, [settingsFieldSourcesKey]: { fastMode: { source: 'managed' } }, sources: [] },
  { effective: {}, [settingsFieldSourcesKey]: {}, sources: [{ source: 'future-policy', settings: {} }] },
  { effective: {}, [settingsFieldSourcesKey]: {}, sources: [], errors: ['Fixture unresolved managed policy'] },
  { effective: {}, sources: [] }, undefined,
])('refuses unknown or incomplete settings observation %j', (value) => {
  expect(() => claudeSequentialPolicyReceipt(value)).toThrow()
})
