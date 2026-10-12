/** Public settings-cascade data only; no SDK import, policy helper, profile read or native query. */
import { expect, it } from 'vitest'
import { claudeSequentialPolicyReceipt } from '../src/claude-source-worker.ts'

it('returns only a bounded fingerprint for an observed empty cascade, without certifying future remote policy', () => {
  const receipt = claudeSequentialPolicyReceipt({ effective: {}, provenance: {}, sources: [] })
  expect(receipt.noManagedSettingsObserved).toBe(true)
  expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.keys(receipt).sort()).toEqual(['fingerprint', 'noManagedSettingsObserved'])
})
it.each(['helper', 'remote', 'file', 'parent', 'plist', 'hklm', 'hkcu'])('refuses reported %s managed startup policy', (policyOrigin) => {
  const settings = { policyHelper: { path: '/fixture/policy-helper' }, enabledPlugins: { 'fixture@managed': true }, fastMode: true }
  expect(() => claudeSequentialPolicyReceipt({ effective: settings, provenance: { fastMode: { source: 'managed', policyOrigin } },
    sources: [{ source: 'managed', settings, policyOrigin }] })).toThrow()
})
it.each([
  { effective: {}, provenance: {}, sources: [{ source: 'managed', settings: {}, policyOrigin: 'remote' }] },
  { effective: { fastMode: true }, provenance: {}, sources: [] },
  { effective: {}, provenance: { fastMode: { source: 'managed' } }, sources: [] },
  { effective: {}, provenance: {}, sources: [{ source: 'future-policy', settings: {} }] },
  { effective: {}, provenance: {}, sources: [], errors: ['Fixture unresolved managed policy'] },
  { effective: {}, sources: [] }, undefined,
])('refuses unknown or incomplete settings observation %j', (value) => {
  expect(() => claudeSequentialPolicyReceipt(value)).toThrow()
})
