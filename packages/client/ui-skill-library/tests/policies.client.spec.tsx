// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId, SkillLibraryItem, SkillLearningPolicyId, SkillLearningStatus } from '@deepseek-ai/dsh-skill-library/types'
import { SkillLearningPolicyControls, type SkillLearningPolicyControlsProps } from '../src/client/SkillLearningPolicyControls.tsx'
import { createLearningState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const id = 'filesystem:/work/project/.agents/skills/release/SKILL.md' as SkillLibraryId
const policyId = 'release-policy' as SkillLearningPolicyId
const item: SkillLibraryItem = { id, name: 'Release workflow', description: 'Ship verified releases', provider: 'filesystem', source: 'project', path: '/work/project/.agents/skills/release/SKILL.md', scope: 'project', projectIds: ['project'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'current-hash', bodyBytes: 560, usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }
const dictionary = { ...commonEn, ...en }
const t: SkillLearningPolicyControlsProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
const providers: SkillLearningStatus = { availability: [], generators: ['suggestions'], validators: [{ id: 'trusted-checker', trusted: true }, { id: 'untrusted-checker', trusted: false }], policies: [{ id: policyId, approvedAt: '2026-10-09T00:00:00Z', validatorId: 'trusted-checker', operations: ['update', 'compress'] }], optIns: [], evidence: [] }
const ineligibleCases: readonly [string, Partial<SkillLibraryItem>][] = [
  ['protected', { ownership: 'protected' }], ['pinned', { pinned: true }], ['shadowed', { shadowed: true }],
  ['disabled', { status: 'disabled' }], ['archived', { status: 'archived' }], ['unknown instructions', { contentHash: '' }],
  ['native', { capabilities: { ...item.capabilities, native: true } }],
]

function fixture(patch: Partial<SkillLearningPolicyControlsProps> = {}) {
  const approvePolicy = vi.fn<SkillLearningPolicyControlsProps['approvePolicy']>()
  const setLearningAutomatic = vi.fn<SkillLearningPolicyControlsProps['setLearningAutomatic']>()
  const props: SkillLearningPolicyControlsProps = { item, state: { ...createLearningState(), status: 'ready', providers }, busy: false, t, approvePolicy, setLearningAutomatic, ...patch }
  const rendered = render(<SkillLearningPolicyControls {...props} />)
  return { props, approvePolicy, setLearningAutomatic, ...rendered }
}

describe('semantic skill policy controls', () => {
  it('requires a deliberate validator and operations, and approves policy without enabling a skill', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Approve a policy' }))
    const dialog = screen.getByRole('dialog', { name: 'Approve automatic maintenance policy' })
    const submit = within(dialog).getByRole('button', { name: 'Approve policy' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getAllByRole('checkbox').every(checkbox => checkbox instanceof HTMLInputElement && !checkbox.checked)).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Validator' }))
    expect(screen.queryByRole('menuitem', { name: 'untrusted-checker' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'trusted-checker' }))
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Update' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Compress' }))
    fireEvent.click(submit)
    expect(state.approvePolicy).toHaveBeenCalledExactlyOnceWith({ validatorId: 'trusted-checker', operations: ['update', 'compress'] })
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
  })

  it('requires selection of an approved policy before enabling consent for the observed skill', () => {
    const state = fixture()
    const toggle = screen.getByRole('switch', { name: 'Automatic learning' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'trusted-checker · Update, Compress' }))
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(state.setLearningAutomatic).toHaveBeenCalledExactlyOnceWith(item, policyId, true)
  })

  it('shows unavailable validation and prevents enablement when only untrusted validators remain', () => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: { ...providers, validators: [{ id: 'trusted-checker', trusted: false }] } } })
    expect(screen.getByText(en.validatorUnavailable)).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: 'Automatic learning' })
    expect(toggle.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Approve a policy' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }))
    expect(screen.queryByRole('menuitem', { name: 'trusted-checker · Update, Compress' })).toBeNull()
  })

  it('shows stale consent as off and permits its explicit revocation with the current source', () => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: { ...providers, optIns: [{ id, policyId, contentHash: 'old-hash', enabled: true }] } } })
    expect(screen.getByRole('switch', { name: 'Automatic learning' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.consentStale)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Disable automatic learning' }))
    expect(state.setLearningAutomatic).toHaveBeenCalledExactlyOnceWith(item, policyId, false)
  })

  it.each(ineligibleCases)('offers no semantic enablement controls for %s skills', (_name, patch) => {
    fixture({ item: { ...item, ...patch } })
    expect(screen.queryByRole('switch', { name: 'Automatic learning' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve a policy' })).toBeNull()
    expect(screen.getByText(patch.capabilities?.native ? en.nativeLearningUnavailable : en.semanticProtected)).toBeTruthy()
  })

  it('keeps revocation available after a skill becomes pinned', () => {
    const pinned = { ...item, pinned: true }
    const state = fixture({ item: pinned, state: { ...createLearningState(), status: 'ready', providers: { ...providers, optIns: [{ id, policyId, contentHash: 'current-hash', enabled: true }] } } })
    expect(screen.queryByRole('switch', { name: 'Automatic learning' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disable automatic learning' }))
    expect(state.setLearningAutomatic).toHaveBeenCalledExactlyOnceWith(pinned, policyId, false)
  })

  it('rejects a selected policy when its registered validator loses trust', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'trusted-checker · Update, Compress' }))
    state.rerender(<SkillLearningPolicyControls {...state.props}
      state={{ ...state.props.state, providers: { ...providers, validators: [] } }} />)
    const toggle = screen.getByRole('switch', { name: 'Automatic learning' })
    expect(toggle.hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
  })

  it('turns off valid current consent using its stored policy without approving another policy', () => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: { ...providers, optIns: [{ id, policyId, contentHash: 'current-hash', enabled: true }] } } })
    const toggle = screen.getByRole('switch', { name: 'Automatic learning' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: 'Policy' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(state.setLearningAutomatic).toHaveBeenCalledExactlyOnceWith(item, policyId, false)
    expect(state.approvePolicy).not.toHaveBeenCalled()
  })

  it('does not carry an uncommitted policy selection to a different skill', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'trusted-checker · Update, Compress' }))
    state.rerender(<SkillLearningPolicyControls {...state.props} item={{ ...item, id: 'other-skill' as SkillLibraryId }} />)
    const toggle = screen.getByRole('switch', { name: 'Automatic learning' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
  })
})
