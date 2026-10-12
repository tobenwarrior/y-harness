/**
 * Composer provider, model, effort, and speed picker over the shared ModelDirectory.
 * Provider browsing remains local until an explicit qualified model selection succeeds.
 * Escape and Shift+Tab leave a pane before closing; reopening discards provider drafts.
 * A selection completion belongs only to the menu opening that submitted it.
 */
import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseFillRegular,
  IconDataOutlineRegular, IconWarningOutlineRegular, Input, rankByName, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'
import { orderModelProviders } from './provider-order.ts'
import { SelectionOption } from './SelectionOption.tsx'

/** Which pane the dropdown shows: the root menu or one drilled-in list. */
type Pane = 'root' | 'provider' | 'model' | 'effort' | 'speed'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** One dynamic speed row; 'default' is the adapter's standard-speed tier. */
interface TierChoice {
  key: string
  tier: string
  label: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  const [providerDraft, setProviderDraft] = useState<{ provider: string; base: string } | null>(null)
  const menuGeneration = useRef(0)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** Model rows by their position in the selected provider's filtered list. */
  const modelRefs = useRef(new Map<number, HTMLButtonElement>())
  const id = useId()

  const groups = useMemo(() => orderModelProviders(state.groups), [state.groups])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const selectionKey = JSON.stringify(state.current)
  useEffect(() => {
    if (providerDraft !== null && providerDraft.base !== selectionKey) setProviderDraft(null)
  }, [providerDraft, selectionKey])
  // An authoritative change invalidates a draft without waiting for an effect.
  const providerId = providerDraft?.base === selectionKey ? providerDraft.provider : state.current?.provider
  const selectedGroup = groups.find(group => group.id === providerId)
  const selectedFailure = selectedGroup === undefined ? state.failures.find(failure => failure.id === providerId) : undefined
  const showSearch = (selectedGroup?.models.length ?? 0) > 4
  const visibleModels = useMemo(() => selectedGroup === undefined ? []
    : rankByName(selectedGroup.models, showSearch ? query.trim() : '').map(model => ({ ...model, provider: selectedGroup.id })),
  [selectedGroup, query, showSearch])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    state.current !== null && model.provider === state.current.provider && model.id === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const providers = new Map([...state.failures, ...groups].map(provider => [
    provider.id,
    provider.id === 'deepseek-account' ? t('provider.account') : provider.name.trim() === '' ? provider.id : provider.name,
  ]))
  const providerOptions = orderModelProviders([...providers].map(([id, name]) => ({ id, name })))
  const providerLabelFor = (id: string): string => {
    const name = providers.get(id) ?? id
    return [...providers].some(([otherId, otherName]) => otherId !== id && otherName.trim() === name.trim())
      ? t('provider.route', { name, id }) : name
  }
  const providerLabel = providerId === undefined ? t('provider.select') : providerLabelFor(providerId)
  const modelLabelFor = (model: NonNullable<typeof selectedGroup>['models'][number]): string =>
    selectedGroup?.models.some(other => other.id !== model.id && other.name.trim() === model.name.trim()) === true
      ? t('model.route', { name: model.name, id: model.id }) : model.name
  const compatibleProvider = providerId === state.current?.provider
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? state.retainedEffort
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const serviceTiers = currentChoice?.model.serviceTiers
  // The adapter materializes its own default tier, so an unset conversation
  // value already reads as the tier the next request would use.
  const effectiveTier = state.current?.serviceTier ?? serviceTiers?.defaultTier
  const tierLabel = serviceTiers === undefined
    ? state.retainedTier
    : effectiveTier === undefined
      ? undefined
      : serviceTiers.tiers.find(choice => choice.id === effectiveTier)?.name ?? effectiveTier
  const tierChoices = useMemo<readonly TierChoice[]>(() => serviceTiers === undefined
    ? []
    : serviceTiers.tiers.map(tier => ({
      key: `tier:${tier.id}`,
      tier: tier.id,
      label: tier.name,
    })), [serviceTiers])
  const { pending } = state
  const busy = pending !== null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      menuGeneration.current += 1
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    setQuery('')
    setHighlightedIndex(null)
  }, [showSearch, providerId])

  // Pane switches unmount the focused row; restore focus inside the menu so
  // keyboard navigation remains available.
  const paneFocus = useRef<'drill' | Exclude<Pane, 'root'> | null>(null)
  const previousShowSearch = useRef(showSearch)
  const previousProvider = useRef(providerId)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    const changedProvider = previousProvider.current !== providerId
    previousShowSearch.current = showSearch
    previousProvider.current = providerId
    const intent = paneFocus.current ?? ((changedSearchMode || changedProvider) && pane === 'model' ? 'drill' : null)
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model' && showSearch) {
        searchRef.current?.focus()
        return
      }
      // The checked row is the value in use; a pane without one opens on its
      // first model, not on a provider heading, so the first keystroke lands
      // where a choice can be made. Headings stay reachable by arrow.
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const rows = (item: HTMLButtonElement | null): boolean =>
        item !== null && item.getAttribute('role') === 'menuitemradio' && !item.disabled
      const target = checked
        ?? itemRefs.current.find(rows)
        ?? itemRefs.current.find(item => item !== null && !item.disabled)
      // Rows a selection in flight disabled cannot take the keyboard; the
      // trigger does, so the card's keys still reach the menu.
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current.find(item => item?.dataset.modelPane === intent)
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane, showSearch, providerId])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      modelRefs.current.get(activeModelIndex)?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because pane switches and async catalog loads resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state, query])
  /* jscpd:ignore-end */

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    menuGeneration.current += 1
    setProviderDraft(null)
    if (state.current === null) paneFocus.current = 'drill'
    setPane(state.current === null ? 'provider' : 'root')
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    menuGeneration.current += 1
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }

  const drill = (next: Pane): void => {
    setQuery('')
    setHighlightedIndex(null)
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    if (state.current === null) {
      if (from === 'provider') close(true)
      else drill('provider')
      return
    }
    paneFocus.current = from
    setPane('root')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') back(pane)
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose({ provider: highlighted.provider, model: highlighted.id })
      return
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root') back(pane)
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    const generation = menuGeneration.current
    void select(selection).then((result) => {
      if (generation === menuGeneration.current) settleSelection(result)
    })
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      closeAfterSelection()
      return
    }
    const model = groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)
    const effort = state.current?.reasoningEffort
    const tier = state.current?.serviceTier
    submit({
      ...selection,
      ...effort !== undefined && model?.reasoning?.efforts.some(level => level.id === effort) === true
        ? { reasoningEffort: effort } : {},
      ...tier !== undefined && model?.serviceTiers?.tiers.some(level => level.id === tier) === true
        ? { serviceTier: tier } : {},
    })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    // Preserve the conversation's speed: omitting the tier would re-materialize
    // the adapter default and silently undo an explicit Standard choice.
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
      ...state.current.serviceTier === undefined ? {} : { serviceTier: state.current.serviceTier },
    }
    submit(selection)
  }

  const chooseTier = (tier: string): void => {
    if (state.current === null) return
    if (effectiveTier === tier) {
      closeAfterSelection()
      return
    }
    // Preserve the conversation's effort for the same reason as above.
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...state.current.reasoningEffort === undefined ? {} : { reasoningEffort: state.current.reasoningEffort },
      serviceTier: tier,
    }
    submit(selection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const rootModelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : state.current.model)
  const modelLabel = state.current !== null && currentChoice === undefined
    ? `${state.current.provider}/${state.current.model}` : rootModelLabel
  const caption = [effortLabel, tierLabel].filter((part): part is string => part !== undefined).join(' · ')
  const triggerLabel = caption === '' ? modelLabel : `${modelLabel} · ${caption}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel !== undefined && tierLabel !== undefined
        ? t('trigger.ariaEffortSpeed', { model: modelLabel, effort: effortLabel, speed: tierLabel })
        : tierLabel !== undefined
          ? t('trigger.ariaSpeed', { model: modelLabel, speed: tierLabel })
          : effortLabel !== undefined
            ? t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
            : t('trigger.aria', { model: modelLabel })
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }
  /** Seat one model row at its DOM position and under its flat model index. */
  const modelRef = (index: number) => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => {
      itemRefs.current[at] = node
      if (node === null) modelRefs.current.delete(index)
      else modelRefs.current.set(index, node)
    }
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {caption !== '' && <span className={css.triggerEffort}>{caption}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role={pane === 'model' ? 'group' : 'menu'}
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell}
                data-model-pane="provider"
                aria-labelledby={`${id}-provider-label`} aria-describedby={`${id}-provider-value`}
                onClick={() => { drill('provider') }}>
                <span id={`${id}-provider-label`} className={css.cellLabel}>{t('menu.provider')}</span>
                <span id={`${id}-provider-value`} className={css.cellValue} title={providerLabel}>{providerLabel}</span>
                <IconChevronRightOutlineRegular className={css.cellChevron} />
              </button>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} data-model-pane="model" onClick={() => { drill('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{compatibleProvider ? rootModelLabel : t('trigger.fallback')}</span>
                <IconChevronRightOutlineRegular className={css.cellChevron} />
              </button>
              {compatibleProvider && reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} data-model-pane="effort" onClick={() => { drill('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
              )}
              {compatibleProvider && serviceTiers !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} data-model-pane="speed" onClick={() => { drill('speed') }}>
                  <span className={css.cellLabel}>{t('menu.speed')}</span>
                  <span className={css.cellValue}>{tierLabel ?? t('effort.providerDefault')}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'provider' && (
            <>
              {state.status === 'loading' && <div className={css.status} role="status">{t('status.loading')}</div>}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              <div className={clsx(css.groups, 'scrollable')}>
                {providerOptions.map(provider => (
                  <SelectionOption key={provider.id} buttonRef={itemRef()} label={providerLabelFor(provider.id)}
                    selected={providerId === provider.id} disabled={busy} pending={pending?.provider === provider.id}
                    onChoose={() => {
                      setProviderDraft({ provider: provider.id, base: selectionKey })
                      drill('model')
                    }} />
                ))}
              </div>
              {state.status === 'ready' && providerOptions.length === 0 && (
                <div className={css.empty} role="status">{t('empty.providers')}</div>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {showSearch && <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== '' && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                  placeholder={t('search.placeholder')}
                  value={query}
                  readOnly={busy}
                  onChange={(event) => { changeQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    disabled={busy}
                    onClick={() => {
                      changeQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>}
              {state.status === 'loading' && (
                <div className={css.status} role="status">{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {selectedFailure !== undefined && (
                <div className={css.warning}>
                  <span>{t('warning.groupLoad', { name: providerLabel, message: selectedFailure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              <div id={`${id}-models`} className={clsx(css.groups, 'scrollable')}
                role="menu" aria-label={t('menu.model')} hidden={visibleModels.length === 0}>
                {visibleModels.map((model, index) => {
                  const selected = state.current !== null
                    && state.current.provider === model.provider && state.current.model === model.id
                  const label = modelLabelFor(model)
                  return (
                    <button ref={modelRef(index)} type="button" role="menuitemradio" aria-checked={selected}
                      id={`${id}-model-${index}`} tabIndex={showSearch ? -1 : 0}
                      onFocus={() => { setHighlightedIndex(index) }}
                      data-highlighted={index === activeModelIndex ? '' : undefined}
                      className={clsx(
                        css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
                      )}
                      onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                        if (showSearch) setHighlightedIndex(index)
                        else itemRefs.current[index]?.focus()
                      }}
                      key={model.id} title={label} disabled={busy}
                      onClick={() => { choose({ provider: model.provider, model: model.id }) }}>
                      <span className={css.optionCopy}><span className={css.modelName}>{label}</span></span>
                      <span className={css.check}>
                        {pending !== null && pending.provider === model.provider && pending.model === model.id
                          ? <StateDot state="ongoing" /> : selected ? <IconCheckOutlineRegular /> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
              {state.status === 'ready' && visibleModels.length === 0 && selectedFailure === undefined && (
                <div className={css.empty} role="status">{t(selectedGroup === undefined
                  ? 'empty.provider' : selectedGroup.models.length === 0 ? 'empty.models' : 'search.empty')}</div>
              )}
            </>
          )}

          {(pane === 'effort' || pane === 'speed') && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {pane === 'effort'
                ? effortChoices.length === 0
                  ? <div className={css.empty}>{t('empty.efforts')}</div>
                  : effortChoices.map(level => (
                    <SelectionOption key={level.key} buttonRef={itemRef()} label={level.label}
                      selected={effectiveEffort === level.effort} disabled={busy}
                      pending={pending !== null && pending.provider === state.current?.provider
                        && pending.model === state.current.model && pending.reasoningEffort === level.effort}
                      onChoose={() => { chooseEffort(level.effort) }} />
                  ))
                : tierChoices.length === 0
                  ? <div className={css.empty}>{t('empty.tiers')}</div>
                  : tierChoices.map(level => (
                    <SelectionOption key={level.key} buttonRef={itemRef()} label={level.label}
                      selected={effectiveTier === level.tier} disabled={busy}
                      pending={pending !== null && pending.provider === state.current?.provider
                        && pending.model === state.current.model && pending.serviceTier === level.tier}
                      onChoose={() => { chooseTier(level.tier) }} />
                  ))}
            </>
          )}
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
