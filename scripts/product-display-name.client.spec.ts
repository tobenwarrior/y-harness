/** Selected feature dictionaries project the public build-time product name. */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function dictionaries() {
  const [plugins, models, account, office, onboarding] = await Promise.all([
    import('../packages/client/ui-plugin-manager/src/client/locales.ts'),
    import('../packages/client/ui-settings-models/src/client/locales.ts'),
    import('../packages/client/ui-settings-account/src/client/locales.ts'),
    import('../packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts'),
    import('../packages/client/ui-settings-account/src/client/locales/onboarding.ts'),
  ])
  return { plugins, models, account, office, onboarding }
}

function productCopy(value: Awaited<ReturnType<typeof dictionaries>>): string[] {
  return [
    ...[value.plugins.en, value.plugins.zh].flatMap(copy => [copy.installGuideSafety]),
    ...[value.models.en, value.models.zh].flatMap(copy => [
      copy.nousHint, copy.nousModelsHint, copy.nousHermesDisclosure, copy.welcomeBody,
    ]),
    ...[value.account.en, value.account.zh].flatMap(copy => [
      copy.backToHarness, copy.settingsSignedOutTitle, copy.settingsSignedOutDescription, copy.quotaDescription,
    ]),
    ...[value.office.en, value.office.zh].flatMap(copy => [copy.unavailable]),
    ...[value.onboarding.onboardingCopy, value.onboarding.onboardingEnglishCopy].flatMap(copy => [
      copy.onboardingBrand, copy.onboardingIntroduction, copy.onboardingCreditDescription,
      copy.onboardingProcessDescription, copy.onboardingNoCreditDescription,
    ]),
  ]
}

describe('feature product labels', () => {
  it('retains existing locale brand text and dictionary key sets when unset', async () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', undefined)
    const value = await dictionaries()
    expect(value.account.en.backToHarness).toMatch(/^Back to (?:DeepSeek Harness|Y Harness)$/)
    expect(value.account.zh.backToHarness).toMatch(/^返回 (?:DeepSeek Harness|Y Harness)$/)
    expect(value.onboarding.onboardingCopy.onboardingBrand).toBe('Y Harness')
    for (const copy of productCopy(value)) expect(copy).toMatch(/DeepSeek Harness|Y Harness/)
    for (const dictionary of [value.plugins, value.models, value.account, value.office]) {
      expect(Object.keys(dictionary.en).sort()).toEqual(Object.keys(dictionary.zh).sort())
    }
    expect(Object.keys(value.onboarding.onboardingCopy).sort())
      .toEqual(Object.keys(value.onboarding.onboardingEnglishCopy).sort())
  })

  it.each(['Y Harness', 'Atlas', '星图 $&'])('projects %s without altering provider copy', async (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    const value = await dictionaries()
    for (const copy of productCopy(value)) expect(copy).toContain(displayName)
    if (displayName !== 'Y Harness') {
      for (const copy of productCopy(value)) expect(copy).not.toMatch(/Y Harness|DeepSeek Harness/)
    }
    expect(value.account.en.signInDescription).toBe('Use your DeepSeek account to get started.')
    expect(value.account.en.signedIn).toBe('Signed in to DeepSeek')
    expect(value.models.en.deepSeekAccount).toBe('DeepSeek Account')
    expect(value.models.en.onboardingDescription).toBe('Configure the official DeepSeek provider to start building.')
    expect(value.models.zh.onboardingDescription).toBe('配置 DeepSeek 官方模型，即可开始使用。')
    expect(value.models.en.nousHint).toContain('Connect your Nous Portal account in the browser')
    expect(value.models.zh.nousHint).toContain('在浏览器中连接 Nous Portal 账户')
    expect(value.models.en.nousHermesDisclosure).toContain('public hermes-cli client ID')
  })
})
