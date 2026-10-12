// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId, SkillLibraryItem, SkillLearningPolicyId, SkillLearningStatus } from '@deepseek-ai/dsh-skill-library/types'
import { SkillLearningPolicyControls, SkillProjectLearningControls, type SkillLearningPolicyControlsProps, type SkillProjectLearningControlsProps } from '../src/client/SkillLearningPolicyControls.tsx'
import { createLearningState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const id = 'filesystem:/work/project/.agents/skills/release/SKILL.md' as SkillLibraryId
const policyId = 'release-policy' as SkillLearningPolicyId
const item: SkillLibraryItem = { id, name: 'Release workflow', description: 'Ship verified releases', provider: 'filesystem', source: 'project', path: '/work/project/.agents/skills/release/SKILL.md', scope: 'project', projectIds: ['project'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'current-hash', bodyBytes: 560, usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }
const dictionary = { ...commonEn, ...en }
const t: SkillLearningPolicyControlsProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
const providers: SkillLearningStatus = { availability: [], generators: ['suggestions'], validators: [{ id: 'trusted-checker', trusted: true }, { id: 'untrusted-checker', trusted: false }], policies: [{ id: policyId, approvedAt: '2026-10-09T00:00:00Z', validatorId: 'trusted-checker', operations: ['update', 'compress'] }], optIns: [], evidence: [] }
const maintenanceProviders: SkillLearningStatus = { ...providers, validators: [{ id: 'instruction-redundancy-validator', trusted: true }], policies: [{ ...providers.policies[0]!, validatorId: 'instruction-redundancy-validator' }] }
const ineligibleCases: readonly [string, Partial<SkillLibraryItem>][] = [
  ['protected', { ownership: 'protected' }], ['pinned', { pinned: true }], ['shadowed', { shadowed: true }],
  ['disabled', { status: 'disabled' }], ['archived', { status: 'archived' }], ['unknown instructions', { contentHash: '' }],
  ['native', { capabilities: { ...item.capabilities, native: true } }],
]

function fixture(patch: Partial<SkillLearningPolicyControlsProps> = {}) {
  const approvePolicy = vi.fn<SkillLearningPolicyControlsProps['approvePolicy']>()
  const setLearningAutomatic = vi.fn<SkillLearningPolicyControlsProps['setLearningAutomatic']>()
  const cleanupSemantic = vi.fn<SkillLearningPolicyControlsProps['cleanupSemantic']>()
  const revokePolicy = vi.fn<SkillLearningPolicyControlsProps['revokePolicy']>()
  const props: SkillLearningPolicyControlsProps = { item, state: { ...createLearningState(), status: 'ready', providers }, busy: false, t, approvePolicy, setLearningAutomatic, cleanupSemantic, revokePolicy, ...patch }
  const rendered = render(<SkillLearningPolicyControls {...props} />)
  return { props, approvePolicy, setLearningAutomatic, cleanupSemantic, revokePolicy, ...rendered }
}

function projectFixture(patch: Partial<SkillProjectLearningControlsProps> = {}) {
  const approvePolicy = vi.fn<SkillProjectLearningControlsProps['approvePolicy']>()
  const revokePolicy = vi.fn<SkillProjectLearningControlsProps['revokePolicy']>()
  const props: SkillProjectLearningControlsProps = { projects: [{ id: 'project', title: 'Y Harness', path: '/work/project' }],
    selectedProjectId: 'project', state: { ...createLearningState(), status: 'ready', providers }, busy: false,
    t, approvePolicy, revokePolicy, ...patch }
  const rendered = render(<SkillProjectLearningControls {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Project learning' }))
  return { props, approvePolicy, revokePolicy, ...rendered }
}

describe('semantic skill policy controls', () => {
  it('requires separate project consent before approving native skill creation', () => {
    const state = projectFixture({ state: { ...createLearningState(), status: 'ready', providers: {
      ...providers, generators: ['native-observation'], validators: [{ id: 'native-observation-validator', trusted: true }],
    } } })
    const consent = screen.getByRole('checkbox', { name: 'Allow new skills from native work' })
    const approve = screen.getByRole('button', { name: 'Approve project learning' })
    expect(consent instanceof HTMLInputElement && consent.checked).toBe(false)
    expect(approve.hasAttribute('disabled')).toBe(true)
    fireEvent.click(approve)
    expect(state.approvePolicy).not.toHaveBeenCalled()
    fireEvent.click(consent)
    expect(state.approvePolicy).not.toHaveBeenCalled()
    expect(screen.getByText(/recorded outcomes remain unverified/)).toBeTruthy()
    fireEvent.click(approve)
    expect(state.approvePolicy).toHaveBeenCalledWith({ validatorId: 'native-observation-validator', generatorId: 'native-observation', projectId: 'project', operations: ['create', 'update'] })
  })

  it('requires project selection when the current filter has no project identity', () => {
    projectFixture({ selectedProjectId: 'shared' })
    expect(screen.getByRole('checkbox', { name: 'Allow new skills from native work' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Approve project learning' }).hasAttribute('disabled')).toBe(true)
  })

  it.each(['untrusted validator', 'no generator', 'busy'] as const)('keeps native project creation approval disabled with %s', (reason) => {
    const state = projectFixture({ state: { ...createLearningState(), status: 'ready', providers: {
      ...providers, validators: [{ id: 'native-observation-validator', trusted: reason !== 'untrusted validator' }],
      generators: reason === 'no generator' ? [] : ['native-observation'],
    } } })
    if (reason === 'busy') state.rerender(<SkillProjectLearningControls {...state.props} busy />)
    const approve = screen.getByRole('button', { name: 'Approve project learning' })
    expect(approve.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow new skills from native work' }))
    fireEvent.click(approve)
    expect(state.approvePolicy).not.toHaveBeenCalled()
  })

  it('revokes a selected file policy independently of its per-file consent', () => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: {
      ...providers, optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke policy' }))
    expect(state.revokePolicy).toHaveBeenCalledWith(policyId)
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
  })

  it.each(['pinned source', 'untrusted validator'] as const)('keeps policy revocation available with %s', (reason) => {
    const state = fixture({ item: { ...item, pinned: reason === 'pinned source' }, state: {
      ...createLearningState(), status: 'ready', providers: { ...providers,
        validators: [{ id: 'trusted-checker', trusted: reason !== 'untrusted validator' }],
        optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
      },
    } })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke policy' }))
    expect(state.revokePolicy).toHaveBeenCalledWith(policyId)
    expect(state.cleanupSemantic).not.toHaveBeenCalled()
  })

  it('shows approved project creation consent and revokes its project policy', () => {
    const state = projectFixture({ state: { ...createLearningState(), status: 'ready', providers: {
      ...providers, generators: ['native-observation'], validators: [{ id: 'native-observation-validator', trusted: true }],
      policies: [{ id: policyId, approvedAt: '2026-10-09T00:00:00Z', validatorId: 'native-observation-validator', generatorId: 'native-observation', projectId: 'project', operations: ['create', 'update'], enabled: true }],
    } } })
    const consent = screen.getByRole('checkbox', { name: 'Allow new skills from native work' })
    expect(consent instanceof HTMLInputElement && consent.checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Approve project learning' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke project learning' }))
    expect(state.revokePolicy).toHaveBeenCalledWith(policyId)
  })

  it.each(['generic validator', 'different generator', 'different project'] as const)('keeps cleanup disabled for %s policy authority', (reason) => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: { ...maintenanceProviders,
      validators: [...maintenanceProviders.validators, { id: 'trusted-checker', trusted: true }],
      optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
      policies: [{ ...maintenanceProviders.policies[0]!, ...reason === 'generic validator' ? { validatorId: 'trusted-checker' } : reason === 'different generator' ? { generatorId: 'other' } : { projectId: 'other' } }],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Force cleanup' }))
    expect(state.cleanupSemantic).not.toHaveBeenCalled()
  })
  it('permits cleanup under an archive-only consented maintenance policy', () => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: { ...maintenanceProviders,
      optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }], policies: [{ ...maintenanceProviders.policies[0]!, operations: ['archive'] }],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Force cleanup' }))
    expect(state.cleanupSemantic).toHaveBeenCalledWith({ projectId: 'project', ids: [id], force: true })
  })
  it('runs normal and force cleanup only for a current consented compression policy', () => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: {
      ...maintenanceProviders, availability: [{ projectId: 'project', state: 'available', reason: 'Available' }],
      optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Clean up this skill' }))
    expect(state.cleanupSemantic).toHaveBeenCalledWith({ projectId: 'project', ids: [id], force: false })
    fireEvent.click(screen.getByRole('button', { name: 'Force cleanup' }))
    expect(state.cleanupSemantic).toHaveBeenLastCalledWith({ projectId: 'project', ids: [id], force: true })
    expect(state.setLearningAutomatic).not.toHaveBeenCalled()
  })

  it.each([
    ['no consent', []],
    ['disabled consent', [{ id, contentHash: item.contentHash, policyId, enabled: false }]],
    ['stale consent', [{ id, contentHash: 'old-hash', policyId, enabled: true }]],
  ] as const)('disables normal and force cleanup with %s', (_label, optIns) => {
    const state = fixture({ state: { ...createLearningState(), status: 'ready', providers: { ...maintenanceProviders,
      availability: [{ projectId: 'project', state: 'available', reason: 'Available' }], optIns,
    } } })
    const normal = screen.getByRole('button', { name: 'Clean up this skill' })
    const force = screen.getByRole('button', { name: 'Force cleanup' })
    expect(normal.hasAttribute('disabled')).toBe(true)
    expect(force.hasAttribute('disabled')).toBe(true)
    fireEvent.click(force)
    expect(state.cleanupSemantic).not.toHaveBeenCalled()
  })

  it.each(ineligibleCases)('keeps force cleanup disabled for %s skills', (_label, patch) => {
    const state = fixture({ item: { ...item, ...patch }, state: { ...createLearningState(), status: 'ready', providers: {
      ...maintenanceProviders, optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
      availability: [{ projectId: 'project', state: 'available', reason: 'Available' }],
    } } })
    const force = screen.getByRole('button', { name: 'Force cleanup' })
    expect(force.hasAttribute('disabled')).toBe(true)
    fireEvent.click(force)
    expect(state.cleanupSemantic).not.toHaveBeenCalled()
  })

  it.each(['untrusted validator', 'revoked policy', 'policy without compression', 'busy'] as const)('disables force cleanup with %s', (reason) => {
    const state = fixture({ busy: reason === 'busy', state: { ...createLearningState(), status: 'ready', providers: {
      ...maintenanceProviders, optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
      validators: [{ id: 'instruction-redundancy-validator', trusted: reason !== 'untrusted validator' }],
      policies: [{ ...maintenanceProviders.policies[0]!, enabled: reason !== 'revoked policy', operations: reason === 'policy without compression' ? ['update'] : ['compress'] }],
      availability: [], generators: [],
    } } })
    const force = screen.getByRole('button', { name: 'Force cleanup' })
    expect(force.hasAttribute('disabled')).toBe(true)
    fireEvent.click(force)
    expect(state.cleanupSemantic).not.toHaveBeenCalled()
  })

  it('cleans up a consented shared skill without inventing a project scope', () => {
    const state = fixture({ item: { ...item, scope: 'shared', projectIds: [] }, state: {
      ...createLearningState(), status: 'ready', providers: { ...maintenanceProviders,
        availability: [], generators: [], optIns: [{ id, contentHash: item.contentHash, policyId, enabled: true }],
      },
    } })
    fireEvent.click(screen.getByRole('button', { name: 'Force cleanup' }))
    expect(state.cleanupSemantic).toHaveBeenCalledWith({ ids: [id], force: true })
  })

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
