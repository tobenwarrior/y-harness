import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotAccent, BotIdentity } from './types.ts'

type Translate = PropsLocale<'bots'>['t']
type IdentityLabelKey = 'identity.agent' | 'identity.sparkle' | 'identity.goal' | 'identity.browse' | 'identity.skill' | 'identity.workspace'
type AccentLabelKey = 'accent.blue' | 'accent.teal' | 'accent.amber' | 'accent.violet' | 'accent.rose' | 'accent.lime'

/** The stable character order shared by creation and editing surfaces. */
export const BOT_IDENTITY_CHOICES: readonly BotIdentity[] = ['agent', 'sparkle', 'goal', 'browse', 'skill', 'workspace']

/** The stable accent order shared by creation and editing surfaces. */
export const BOT_ACCENT_CHOICES: readonly BotAccent[] = ['blue', 'teal', 'amber', 'violet', 'rose', 'lime']

const identityLabels: Readonly<Record<BotIdentity, IdentityLabelKey>> = {
  agent: 'identity.agent',
  sparkle: 'identity.sparkle',
  goal: 'identity.goal',
  browse: 'identity.browse',
  skill: 'identity.skill',
  workspace: 'identity.workspace',
}

const accentLabels: Readonly<Record<BotAccent, AccentLabelKey>> = {
  blue: 'accent.blue',
  teal: 'accent.teal',
  amber: 'accent.amber',
  violet: 'accent.violet',
  rose: 'accent.rose',
  lime: 'accent.lime',
}

/** Return the locale key for one character family. */
export function botIdentityLabelKey(identity: BotIdentity): IdentityLabelKey {
  return identityLabels[identity]
}

/** Return the locale key for one accent family. */
export function botAccentLabelKey(accent: BotAccent): AccentLabelKey {
  return accentLabels[accent]
}

/**
 * Shared accessible character and accent controls for a Bot appearance.
 */
export interface BotAppearancePickerProps {
  /** Current semantic character family. */
  readonly identity: BotIdentity
  /** Current accent family shared by every character preview. */
  readonly accent: BotAccent
  /** Persist or stage a new character choice in the owner. */
  readonly onIdentityChange: (identity: BotIdentity) => void
  /** Persist or stage a new accent choice in the owner. */
  readonly onAccentChange: (accent: BotAccent) => void
  /** Clear owner-local feedback after a new appearance choice. */
  readonly onAppearanceChange?: (() => void) | undefined
  /** Disable both radio groups while an owner operation is in flight. */
  readonly disabled?: boolean | undefined
  /** Locale-owned Bot workspace translator. */
  readonly t: Translate
}

/**
 * Render shared accessible character and accent controls.
 * @param props - Current appearance, change handlers, and locale-owned labels.
 * @returns The character and accent radio groups.
 */
export function BotAppearancePicker({
  identity, accent, onIdentityChange, onAccentChange, onAppearanceChange, disabled = false, t,
}: BotAppearancePickerProps) {
  return (
    <>
      <div className={css.dialogField}>
        <span className={css.avatarEditorLabel}>{t('identityLabel')}</span>
        <div className={css.identityChoices} role="radiogroup" aria-label={t('identityLabel')}>
          {BOT_IDENTITY_CHOICES.map(choice => (
            <button
              key={choice}
              type="button"
              className={choice === identity ? `${css.identityChoice} ${css.identityChoiceSelected}` : css.identityChoice}
              role="radio"
              aria-checked={choice === identity}
              aria-label={t(botIdentityLabelKey(choice))}
              data-accent={accent}
              onClick={() => { onIdentityChange(choice); onAppearanceChange?.() }}
              disabled={disabled}
            >
              <BotAvatar name={t(botIdentityLabelKey(choice))} identity={choice} accent={accent} size="large" />
            </button>
          ))}
        </div>
      </div>
      <div className={css.dialogField}>
        <span className={css.avatarEditorLabel}>{t('accentLabel')}</span>
        <div className={css.accentChoices} role="radiogroup" aria-label={t('accentLabel')}>
          {BOT_ACCENT_CHOICES.map(choice => (
            <button
              key={choice}
              type="button"
              className={choice === accent ? `${css.accentChoice} ${css.accentChoiceSelected}` : css.accentChoice}
              role="radio"
              aria-checked={choice === accent}
              aria-label={t(botAccentLabelKey(choice))}
              onClick={() => { onAccentChange(choice); onAppearanceChange?.() }}
              disabled={disabled}
            >
              <span className={css.accentSwatch} data-accent={choice} aria-hidden="true" />
              <span>{t(botAccentLabelKey(choice))}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
