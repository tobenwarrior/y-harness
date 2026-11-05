import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, Modal, StateDot,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type {
  BotSkillManagerActions,
  BotSkillPolicy,
  BotSkillSummary,
  BotSummary,
  BotWorkspaceProps,
} from './types.ts'
import { BotSkillPolicyConflictError } from './types.ts'

type Translate = PropsLocale<'bots'>['t']

/** Props for the selected Bot's host-local skill manager. */
export interface BotSkillsManagerProps {
  /** Selected Bot whose host-local skill policy is shown. */
  readonly bot: BotSummary
  /** Host-backed skill catalog and policy actions. */
  readonly actions: BotSkillManagerActions
  /** Optional Bot-owned image loader for the manager identity chip. */
  readonly loadAvatar?: BotWorkspaceProps['loadAvatar']
  /** Whether the manager modal is visible. */
  readonly open: boolean
  /** Close the manager without changing the selected Bot. */
  readonly onClose: () => void
  /** Locale-owned Bot workspace translator. */
  readonly t: Translate
}

function sortedNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function hasSkill(policy: BotSkillPolicy, name: string): boolean {
  if (policy.disabled.includes(name)) return false
  return policy.mode === 'all' || policy.enabled.includes(name)
}

function toggleSkill(policy: BotSkillPolicy, name: string): BotSkillPolicy {
  if (policy.mode === 'all') {
    const disabled = policy.disabled.includes(name)
      ? policy.disabled.filter(candidate => candidate !== name)
      : [...policy.disabled, name]
    return { ...policy, disabled: sortedNames(disabled) }
  }
  if (policy.disabled.includes(name)) {
    return {
      ...policy,
      enabled: sortedNames([...policy.enabled, name]),
      disabled: policy.disabled.filter(candidate => candidate !== name),
    }
  }
  const enabled = policy.enabled.includes(name)
    ? policy.enabled.filter(candidate => candidate !== name)
    : [...policy.enabled, name]
  return { ...policy, enabled: sortedNames(enabled) }
}

function skillLabel(skill: BotSkillSummary, t: Translate): string {
  return skill.name.trim() === '' ? t('skillFallbackName') : skill.name
}

/** Render a Bot-scoped host-local skill policy editor. */
export function BotSkillsManager({ bot, actions, loadAvatar, open, onClose, t }: BotSkillsManagerProps): ReactNode {
  const [skills, setSkills] = useState<readonly BotSkillSummary[]>([])
  const [policy, setPolicy] = useState<BotSkillPolicy>({ mode: 'all', enabled: [], disabled: [] })
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState<'load' | 'save' | 'conflict' | null>(null)
  const targetBotIdRef = useRef<string | undefined>()
  const targetGenerationRef = useRef(0)
  const botIdRef = useRef(bot.id)
  botIdRef.current = bot.id
  const openRef = useRef(open)
  openRef.current = open
  if (!open) targetBotIdRef.current = undefined
  else if (targetBotIdRef.current === undefined) {
    targetBotIdRef.current = bot.id
    targetGenerationRef.current += 1
  }
  const visible = open && targetBotIdRef.current === bot.id

  useEffect(() => {
    if (open && targetBotIdRef.current !== bot.id) onClose()
  }, [bot.id, onClose, open])

  useEffect(() => {
    if (!visible) return
    let live = true
    setLoading(true)
    setError(null)
    void actions.list(bot.id).then((value) => {
      if (!live) return
      setSkills(value.skills)
      setPolicy(value.policy)
      setRevision(value.revision)
    }).catch(() => {
      if (live) setError('load')
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [actions, bot.id, loadAttempt, visible])

  const save = async (): Promise<void> => {
    if (!visible || working || loading) return
    const requestedBotId = bot.id
    const requestedGeneration = targetGenerationRef.current
    const isCurrentTarget = (): boolean => openRef.current
      && botIdRef.current === requestedBotId
      && targetBotIdRef.current === requestedBotId
      && targetGenerationRef.current === requestedGeneration
    setWorking(true)
    setError(null)
    try {
      const value = await actions.update(bot.id, policy, revision)
      if (!isCurrentTarget()) return
      setPolicy(value.policy)
      onClose()
    } catch (error: unknown) {
      if (isCurrentTarget()) setError(error instanceof BotSkillPolicyConflictError ? 'conflict' : 'save')
    } finally {
      setWorking(false)
    }
  }

  const errorText = error === 'load'
    ? t('skillsLoadFailed')
    : error === 'save'
      ? t('skillsSaveFailed')
      : error === 'conflict'
        ? t('skillsConflict')
        : undefined

  return (
    <Modal
      open={visible}
      onClose={() => { if (!working) onClose() }}
      title={t('skillsManagerTitle')}
      description={t('skillsManagerDescription')}
      closeLabel={t('close')}
      className={css.skillsModal as string}
      contentClassName={css.skillsModalContent as string}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>{t('close')}</Button>
          <Button variant="primary" onClick={() => { void save() }} disabled={working || loading || error === 'load' || error === 'conflict'}>
            {working ? t('skillsSaving') : t('skillsSave')}
          </Button>
        </>
      )}
    >
      <div className={css.skillsManagerHeading}>
        <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} size="small" />
        <span>
          <strong>{bot.name}</strong>
          <span>{t('skillsHostLocalHint')}</span>
        </span>
      </div>
      {errorText !== undefined && (
        <div className={css.skillsNotice} role="alert">
          <span>{errorText}</span>
          {error === 'conflict' && (
            <Button variant="outline" size="sm" onClick={() => { setLoadAttempt(value => value + 1) }}>
              {t('skillsReload')}
            </Button>
          )}
        </div>
      )}
      {loading && <div className={css.skillsLoading} role="status"><StateDot state="ongoing" size={13} />{t('skillsLoading')}</div>}
      {!loading && error === 'load' && (
        <div className={css.skillsEmpty}>
          <p>{t('skillsLoadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => { setLoadAttempt(value => value + 1) }}>{t('retry')}</Button>
        </div>
      )}
      {!loading && error !== 'load' && (
        <>
          <fieldset className={css.skillsModes} disabled={working || error === 'conflict'}>
            <legend className={css.dialogLabel}>{t('skillsModeLabel')}</legend>
            <label className={css.skillsModeOption}>
              <input
                type="radio"
                name={`yharness-skills-mode-${bot.id}`}
                checked={policy.mode === 'all'}
                onChange={() => { setPolicy(current => ({ ...current, mode: 'all' })) }}
              />
              <span>{t('skillsModeAll')}</span>
            </label>
            <label className={css.skillsModeOption}>
              <input
                type="radio"
                name={`yharness-skills-mode-${bot.id}`}
                checked={policy.mode === 'selected'}
                onChange={() => { setPolicy(current => ({ ...current, mode: 'selected' })) }}
              />
              <span>{t('skillsModeSelected')}</span>
            </label>
          </fieldset>
          {skills.length === 0
            ? (
              <div className={css.skillsEmpty} role="status">
                <strong>{t('skillsEmptyTitle')}</strong>
                <span>{t('skillsEmptyDescription')}</span>
              </div>
            )
            : (
              <fieldset className={css.skillsList} disabled={working || error === 'conflict'}>
                <legend className={css.dialogLabel}>{t('skillsListLabel')}</legend>
                {skills.map((skill) => {
                  const label = skillLabel(skill, t)
                  const enabled = hasSkill(policy, skill.name)
                  return (
                    <label key={skill.name} className={css.skillRow}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        aria-label={enabled ? t('revokeSkill', { name: label }) : t('grantSkill', { name: label })}
                        onChange={() => { setPolicy(current => toggleSkill(current, skill.name)) }}
                      />
                      <span className={css.skillRowCopy}>
                        <strong>{label}</strong>
                        <span>{skill.description}</span>
                        {skill.whenToUse !== undefined && skill.whenToUse !== '' && <small>{skill.whenToUse}</small>}
                      </span>
                      {enabled && <IconCheckOutlineRegular size={14} />}
                    </label>
                  )
                })}
              </fieldset>
            )}
        </>
      )}
    </Modal>
  )
}
