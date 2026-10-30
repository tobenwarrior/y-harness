// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@yharness/cordis'
import { stubConfigForm, type StubConfigForm } from '@yharness/client-test-runtime'
import type { LocaleSettings, LocaleSnapshot } from '@yharness/client-locale/client'
import { FALLBACK_LOCALE, LocaleRuntime } from '@yharness/client-locale/client'
const make = (host?: StubConfigForm<LocaleSettings>): {
  ctx: Context
  svc: LocaleRuntime
  events: LocaleSnapshot[]
} => {
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  return { ctx, svc: new LocaleRuntime(ctx, host?.scope), events }
}

/**
 * Pin the browser environment a fresh service reads its initial locale from.
 * This package's own specs stub the globals directly instead of using
 * `usePinnedBrowserLanguages` (dsh-client-test-runtime): they need the shapes
 * that helper deliberately cannot express — a missing `languages` list, a
 * list decoupled from `language`, and a non-browser run with no `window`.
 */
const stubLanguages = (...tags: string[]): void => {
  vi.stubGlobal('navigator', { languages: tags, language: tags[0] ?? '' })
}

describe('LocaleRuntime', () => {
  beforeEach(() => {
    // A retired-locale browser must resolve to the English product default.
    stubLanguages('zh-CN')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('translates through the active-locale -> en -> key chain', () => {
    const { svc } = make()
    svc.register('ns', 'fr', { hello: 'Bonjour' })
    svc.register('ns', 'en', { hello: 'Hello', onlyEn: 'English only' })
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    const t = svc.bind('ns')
    expect(svc.getLocale().active).toBe('fr')
    expect(t('hello')).toBe('Bonjour')
    // The active locale misses this key; the en fallback supplies it.
    expect(t('onlyEn')).toBe('English only')
    svc.setLocale('en')
    expect(t('hello')).toBe('Hello')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('falls through to the common vocabulary after the namespace misses (production keys)', () => {
    const { svc } = make()
    // The shipped common pair is registered by apply; the bench registers it
    // directly to pin the production chain: ns -> common -> en -> key.
    svc.register('common', 'fr', { retry: 'Retry in French' })
    svc.register('common', 'en', { retry: 'Retry' })
    svc.register('ns', 'en', { own: 'Own' })
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    const t = svc.bind('ns')
    expect(t('retry')).toBe('Retry in French')
    // fr is active and `ns` has no fr dictionary: the en fallback answers.
    expect(t('own')).toBe('Own')
    svc.setLocale('en')
    expect(t('retry')).toBe('Retry')
    expect(t('own')).toBe('Own')
    // common itself must not recurse: a miss inside common echoes the key.
    // (Wide-string ns hits the untyped bind overload — the typed one rejects
    // unknown keys at compile time, which is the point of the typed registry contract.)
    expect(svc.bind('common' as string)('nope')).toBe('nope')
  })

  it('interpolates {name} params and leaves unknown placeholders intact', () => {
    const { svc } = make()
    svc.register('ns', 'fr', { greet: 'Bonjour {name}! Attempt {n}', partial: '{known} plus {unknown}' })
    svc.register('ns', 'en', { greet: 'Hello {name}! Attempt {n}' })
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    const t = svc.bind('ns')
    expect(t('greet', { name: 'World', n: 2 })).toBe('Bonjour World! Attempt 2')
    expect(t('partial', { known: 'A' })).toBe('A plus {unknown}')
  })

  it('bind returns a stable per-namespace function identity', () => {
    const { svc } = make()
    expect(svc.bind('a')).toBe(svc.bind('a'))
    expect(svc.bind('a')).not.toBe(svc.bind('b'))
  })

  it('rejects duplicate (ns, locale) and disposer only removes its own dict', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'en', { k: 'v1' })
    expect(() => svc.register('ns', 'EN', { k: 'v2' })).toThrow('already has locale')
    dispose()
    const t = svc.bind('ns')
    expect(t('k')).toBe('k')
    svc.register('ns', 'en', { k: 'v2' })
    expect(t('k')).toBe('v2')
    dispose()
    expect(t('k')).toBe('v2')
  })

  it('serves the LocaleFace: snapshot revision moves on switch and registration, subscribers fire, unsubscribe stops them', () => {
    const { svc } = make()
    const seen: number[] = []
    const off = svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
    expect(svc.getSnapshot()).toBe(svc.getLocale())
    const r0 = svc.getSnapshot().revision
    svc.register('ns', 'en', { k: 'v' })
    expect(svc.getSnapshot().revision).toBe(r0 + 1)
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    expect(seen).toEqual([r0 + 1, r0 + 2, r0 + 3])
    off()
    svc.setLocale('en')
    expect(seen).toHaveLength(3)
  })

  it('isolates a throwing subscriber: the rest still see the new revision', () => {
    const { svc } = make()
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const seen: number[] = []
      svc.subscribe(() => { throw new Error('boom') })
      svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
      svc.setLocale('fr')
      expect(seen).toEqual([2])
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('register disposer republishes (mounted outlets drop the dead dictionary)', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'en', { k: 'v' })
    const before = svc.getSnapshot().revision
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
    // Second run hits the idempotent arm: nothing removed, no republish.
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
  })

  it('setLocale writes through the scope and republishes only on a real change', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    expect(svc.getLocale().active).toBe('fr')
    expect(host.set).toHaveBeenCalledWith('preference', 'fr')
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(svc.getLocale())
    expect(events[0]!.revision).toBe(2)
    // Re-selecting the active locale publishes nothing (no subscriber churn)
    // but still writes: the active value may be a provisional browser-derived
    // resolution nothing has stored, and picking it is an explicit choice that
    // must outlive this browser.
    svc.setLocale('fr')
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledTimes(2)
    expect(host.set).toHaveBeenLastCalledWith('preference', 'fr')
  })

  it('persists an explicit pick of the provisional locale, so a shared DSH home agrees', () => {
    // A browser naming no shipped language opens at FALLBACK_LOCALE with
    // nothing stored. Choosing that same language in the menu must become
    // durable, so the selected default survives a different browser.
    stubLanguages('fr-FR')
    const host = stubConfigForm<LocaleSettings>()
    const { svc } = make(host)
    expect(svc.getLocale().active).toBe('en')
    expect(host.set).not.toHaveBeenCalled()
    svc.setLocale('en')
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
  })

  it('setLocale without a host scope stays process-local', () => {
    const { svc, events } = make()
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    expect(svc.getLocale().active).toBe('fr')
    expect(events).toHaveLength(1)
  })

  it('throws on unknown locale ids', () => {
    const { svc } = make()
    expect(() => { svc.setLocale('fr') }).toThrow('not registered')
  })

  it('registers an external locale for selection, translation, persistence, and reversible disposal', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    svc.register('ns', 'en', { hello: 'Hello' })
    svc.register('ns', 'FR', { hello: 'Bonjour' })
    const dispose = svc.addLanguage({ id: 'fr', label: 'French', fallback: 'EN' })
    expect(svc.getLocale().locales).toContainEqual({ id: 'fr', label: 'French', fallback: 'en' })

    svc.setLocale('FR')
    expect(svc.getLocale().active).toBe('fr')
    expect(svc.bind('ns')('hello')).toBe('Bonjour')
    expect(host.set).toHaveBeenCalledWith('preference', 'fr')

    dispose()
    expect(svc.getLocale().active).toBe('en')
    expect(svc.getLocale().locales.map(locale => locale.id)).toEqual(['en'])
    expect(svc.bind('ns')('hello')).toBe('Hello')
    const revision = svc.getLocale().revision
    dispose()
    expect(svc.getLocale().revision).toBe(revision)
    expect(events.map(snapshot => snapshot.active)).toEqual(['fr', 'en'])
  })

  it('uses fallback copy until a language dictionary registers later', () => {
    const { svc } = make()
    svc.register('ns', 'en', { hello: 'Hello' })
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    expect(svc.bind('ns')('hello')).toBe('Hello')

    const revision = svc.getLocale().revision
    svc.register('ns', 'fr', { hello: 'Bonjour' })
    expect(svc.getLocale().revision).toBe(revision + 1)
    expect(svc.bind('ns')('hello')).toBe('Bonjour')
  })

  it('rejects duplicate and malformed locale definitions', () => {
    const { svc } = make()
    expect(() => svc.addLanguage({ id: 'EN', label: 'Other English', fallback: 'en' }))
      .toThrow('already registered')
    expect(() => svc.addLanguage({ id: 'bad locale', label: 'Bad', fallback: 'en' }))
      .toThrow('not a BCP 47-style tag')
    expect(() => svc.addLanguage({ id: '123', label: 'Numeric', fallback: 'en' }))
      .toThrow('not a BCP 47-style tag')
    expect(() => svc.addLanguage({ id: 'fr', label: '   ', fallback: 'en' }))
      .toThrow('label must not be empty')
    expect(() => svc.addLanguage({ id: 'fr', label: 'French', fallback: 'bad tag' }))
      .toThrow('locale fallback')
    expect(() => svc.addLanguage({ id: 'fr', label: 'French', fallback: 'de' }))
      .toThrow('not registered')
  })

  it('allows an external language pack to reintroduce a retired locale id', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { hello: 'External translation' })
    const dispose = svc.addLanguage({ id: 'zh', label: 'External language', fallback: 'en' })

    expect(svc.getLocale().locales).toContainEqual({ id: 'zh', label: 'External language', fallback: 'en' })
    svc.setLocale('zh')
    expect(svc.getLocale().active).toBe('zh')
    expect(svc.bind('ns')('hello')).toBe('External translation')

    dispose()
    expect(svc.getLocale().active).toBe('en')
  })

  it('rejects malformed locale ids before dictionary registration', () => {
    const { svc } = make()
    expect(() => svc.register('ns', 'bad locale', { hello: 'Bad' }))
      .toThrow('not a BCP 47-style tag')
    expect(() => svc.register('ns', '123', { hello: 'Numeric' }))
      .toThrow('not a BCP 47-style tag')
    expect(svc.bind('ns')('hello')).toBe('hello')
  })

  it('walks each language fallback recursively for every dictionary key', () => {
    const { svc } = make()
    svc.register('ns', 'en', { base: 'English', shared: 'English shared' })
    svc.register('ns', 'fr', { shared: 'Français' })
    svc.register('ns', 'fr-CA', { local: 'Québec' })
    svc.register('common', 'en', { commonBase: 'Common English' })
    svc.register('common', 'fr', { commonShared: 'Common French' })
    svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    svc.addLanguage({ id: 'fr-CA', label: 'Français (Canada)', fallback: 'fr' })
    svc.setLocale('fr-CA')
    const t = svc.bind('ns')
    expect(t('local')).toBe('Québec')
    expect(t('shared')).toBe('Français')
    expect(t('base')).toBe('English')
    expect(t('commonShared')).toBe('Common French')
    expect(t('commonBase')).toBe('Common English')
  })

  it('rejects a fallback cycle exposed by re-registering an unloaded language', () => {
    const { svc } = make()
    svc.register('ns', 'en', { base: 'English' })
    const removeFr = svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    svc.addLanguage({ id: 'fr-CA', label: 'Français (Canada)', fallback: 'fr' })
    svc.setLocale('fr-CA')
    removeFr()
    expect(svc.bind('ns')('base')).toBe('English')
    expect(() => svc.addLanguage({ id: 'de', label: 'Deutsch', fallback: 'fr-CA' }))
      .toThrow('locale fallback "fr" is not registered')
    expect(() => svc.addLanguage({ id: 'fr', label: 'Français', fallback: 'fr-CA' }))
      .toThrow('fallback cycle')
    expect(svc.getLocale().locales.map(locale => locale.id)).toEqual(['en', 'fr-CA'])
  })

  it('adopts a saved external locale when its definition registers later', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    host.publish({ status: 'ready', value: { preference: 'fr' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')

    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    expect(svc.getLocale().active).toBe('fr')
    expect(events.map(snapshot => snapshot.active)).toEqual(['fr'])
    expect(host.set).not.toHaveBeenCalled()
  })

  it('adopts a Host preference over the browser language without writing it back', () => {
    stubLanguages('fr-FR')
    const host = stubConfigForm<LocaleSettings>()
    const { svc, events } = make(host)
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    expect(svc.getLocale().active).toBe('fr')
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(2)
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { preference: 'en' }, revision: 2 })
    expect(events).toHaveLength(2)
  })

  it('resolves a retired stored locale to English even after another language becomes available', () => {
    stubLanguages('fr-FR')
    const host = stubConfigForm<LocaleSettings>()
    host.publish({ status: 'ready', value: { preference: 'zh' }, revision: 1, writable: true })
    const { svc } = make(host)
    expect(svc.getLocale().active).toBe('en')

    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    expect(svc.getLocale().active).toBe('en')
    expect(host.set).not.toHaveBeenCalled()
  })

  it('an absent Host preference returns to the browser-derived locale', () => {
    const host = stubConfigForm<LocaleSettings>()
    const { svc } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    host.publish({ value: {}, revision: 2 })
    expect(svc.getLocale().active).toBe('en')
  })

  it('adopts a section already standing at construction and releases its subscription on dispose', async () => {
    const host = stubConfigForm<LocaleSettings>()
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    const { ctx, svc } = make(host)
    expect(svc.getLocale().active).toBe('en')
    expect(host.listenerCount()).toBe(1)
    await ctx.fiber.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('opens provisionally in the browser language, matching regional variants on their primary subtag', () => {
    stubLanguages('en-GB', 'zh-CN')
    expect(make().svc.getLocale().active).toBe('en')
    stubLanguages('zh-Hant-TW')
    expect(make().svc.getLocale().active).toBe('en')
    // An unshipped language walks the list to the first one this app ships.
    stubLanguages('fr-FR', 'en-US')
    expect(make().svc.getLocale().active).toBe('en')
    // Only `language` populated: an empty ordered list, and a host that
    // exposes no `languages` property at all.
    vi.stubGlobal('navigator', { languages: [], language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('en')
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('en')
    // No shipped language anywhere in the browser's preferences: en is the
    // product default rather than an arbitrary near-match.
    stubLanguages('fr-FR', 'de')
    expect(make().svc.getLocale().active).toBe('en')
  })

  it('re-evaluates browser languages as external definitions register and unload', () => {
    stubLanguages('pt-BR', 'zh-CN')
    const { svc } = make()
    expect(svc.getLocale().active).toBe('en')
    const dispose = svc.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
    expect(svc.getLocale().active).toBe('pt-BR')
    dispose()
    expect(svc.getLocale().active).toBe('en')
  })

  it('runs outside a browser (node boots): the default decides and the machine language does not', () => {
    vi.stubGlobal('window', undefined)
    // Node exposes its own global navigator; without a window it must not
    // reach the resolution at all.
    stubLanguages('zh-CN')
    const { svc } = make()
    expect(svc.getLocale().active).toBe('en')
    svc.setLocale('zh')
    expect(svc.getLocale().active).toBe('en')
  })

  it('lets an explicit in-process preference replace the browser-derived value', () => {
    stubLanguages('en-US')
    const { svc } = make()
    svc.addLanguage({ id: 'fr', label: 'French', fallback: 'en' })
    svc.setLocale('fr')
    expect(svc.getLocale().active).toBe('fr')
  })

  it('serves English as both the opening locale and the dictionary fallback', () => {
    // One constant covers both jobs: the locale the UI opens in with no usable
    // browser signal and the dictionary backing a missing active-locale key.
    expect(FALLBACK_LOCALE).toBe('en')
    vi.stubGlobal('window', undefined)
    const { svc } = make()
    // A key present in the English dictionary resolves after a retired setting.
    svc.register('ns', 'zh', {})
    svc.register('ns', 'en', { onlyEn: 'English only' })
    svc.setLocale('zh')
    expect(svc.getLocale().active).toBe('en')
    expect(svc.bind('ns')('onlyEn')).toBe('English only')
    // Retired dictionaries are ignored, so their keys surface instead of
    // silently restoring the retired locale.
    svc.register('ns2', 'zh', { retiredOnly: 'Retired only' })
    svc.register('ns2', 'en', {})
    svc.setLocale('en')
    expect(svc.bind('ns2')('retiredOnly')).toBe('retiredOnly')
  })

  it('starts with exactly the English shipped locale', () => {
    const { svc } = make()
    expect(svc.getLocale().locales).toEqual([
      { id: 'en', label: 'English' },
    ])
  })
})
