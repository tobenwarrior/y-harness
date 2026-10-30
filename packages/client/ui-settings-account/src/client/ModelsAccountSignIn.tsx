/** Optional DeepSeek account access alongside other model providers. */
import { Button } from '@yharness/client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-settings-models/client'
import type { AccountSectionInjected } from './AccountSection.tsx'
import css from './AccountSection.module.css'

type ModelsAccountSignInInjected = Pick<AccountSectionInjected, 'start'> & {
  hooks: Pick<AccountSectionInjected['hooks'], 'account'>
}

/**
 * Offer optional DeepSeek account sign-in in Models.
 * @param props - shared account state, sign-in action, and localized copy.
 * @returns the sign-in entry until the account is connected.
 */
export function ModelsAccountSignIn({ useAccount, start, t }:
  PropsRuntime<'settings.models.footer'> & PropsLocale<'settings.account'> & InjectFace<ModelsAccountSignInInjected>) {
  const account = useAccount(value => value)
  if (account.view?.status === 'credential-stored') return null
  return <section className={css.card} aria-label={t('modelsAccountTitle')}>
    <span className={css.identityCopy}>
      <span className={css.name}>{t('modelsAccountTitle')}</span>
      <span>{account.failed ? t('failed') : t('modelsAccountDescription')}</span>
    </span>
    <Button variant="outline" disabled={account.view === undefined || account.loginVisible === true}
      onClick={() => { void start().catch(() => undefined) }}>{t('signIn')}</Button>
  </section>
}
