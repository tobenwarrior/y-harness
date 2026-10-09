/** Scoped inventory, lazy details, and reversible skill maintenance. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, DiffBlock, IconArchiveOutlineRegular, IconCloseOutlineRegular, IconChevronDownOutlineRegular,
  IconFolderOpenOutlineRegular, IconPinOutlineRegular, IconPinFillRegular, IconRefreshOutlineRegular,
  IconSearchOutlineRegular, IconSkillOutlineRegular, Input, Menu, MenuItemButton, Modal,
  IconLoadingOutlineRegular, IconPanelLeftOutlineRegular, SegmentedControl, Switch, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryList } from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLibraryFace, SkillLibraryState } from './controller.ts'
import type { createNavigationStore, LibraryNavigation } from './navigation-store.ts'
import { SkillGraph } from './SkillGraph.tsx'
import { SkillReviews } from './SkillReviews.tsx'
import { SkillLearningPolicyControls } from './SkillLearningPolicyControls.tsx'
import css from './SkillLibraryPage.module.css'

/** Locale, controller, and viewing-state inputs bound by the panel registration. */
export type SkillLibraryPageProps = PropsLocale<'skillLibrary'> & InjectFace<SkillLibraryFace> & PropsStore<ReturnType<typeof createNavigationStore>>
type Translate = SkillLibraryPageProps['t']

function FilterMenu<Value extends string>({ value, options, label, onChange }: {
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string }[]
  readonly label: string
  readonly onChange: (value: Value) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus
    anchor={<Button variant="outline" size="sm" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setOpen(value => !value) }}>
      {options.find(option => option.value === value)?.label}<IconChevronDownOutlineRegular size={12} />
    </Button>}>
    {options.map(option => <MenuItemButton key={option.value}
      onSelect={() => { setOpen(false); onChange(option.value) }}>{option.label}</MenuItemButton>)}
  </Menu>
}

function Badges({ item, t }: { readonly item: SkillLibraryItem; readonly t: Translate }): ReactNode {
  return <div className={css.badges}>
    <Tag tone={item.status === 'active' ? 'success' : 'neutral'}>{t(item.status)}</Tag>
    <Tag tone={item.ownership === 'y-managed' ? 'info' : 'quiet'}>{t(item.ownership === 'y-managed' ? 'managed' : item.ownership === 'vendor' ? 'vendor' : 'protected')}</Tag>
    {item.pinned && <Tag tone="quiet">{t('pinned')}</Tag>}
    {item.shadowed && <Tag tone="warning">{t('shadowed')}</Tag>}
    {item.capabilities.native && <Tag tone="quiet">{t('native')}</Tag>}
  </div>
}

function usageText(item: SkillLibraryItem, t: Translate): string {
  return item.usage.coverage === 'unknown' ? t('unknown') : t('recorded', { count: item.usage.loadCount })
}

function matchingItems(inventory: SkillLibraryList, navigation: LibraryNavigation): readonly SkillLibraryItem[] {
  const query = navigation.query.trim().toLocaleLowerCase()
  return inventory.items.filter((item) => {
    if (navigation.status !== 'all' && item.status !== navigation.status) return false
    if (navigation.project === 'shared' && item.scope !== 'shared') return false
    if (navigation.project !== 'all' && navigation.project !== 'shared' && item.scope !== 'shared' && !item.projectIds.includes(navigation.project)) return false
    const projectNames = inventory.projects.filter(project => item.projectIds.includes(project.id)).map(project => project.title)
    return query === '' || [item.name, item.description, item.source, item.provider, item.path, ...projectNames].join('\n').toLocaleLowerCase().includes(query)
  })
}

function SkillList({ items, inventory, selectedId, onSelect, t }: {
  readonly items: readonly SkillLibraryItem[]
  readonly inventory: SkillLibraryList
  readonly selectedId: SkillLibraryId | null
  readonly onSelect: (item: SkillLibraryItem) => void
  readonly t: Translate
}): ReactNode {
  const groups = inventory.projects.map(project => ({ id: project.id, label: project.title,
    items: items.filter(item => item.scope === 'project' && item.projectIds.includes(project.id)) }))
  const ungrouped = items.filter(item => item.scope === 'project' && !item.projectIds.some(id => inventory.projects.some(project => project.id === id)))
  if (ungrouped.length > 0) groups.push({ id: 'project', label: t('projectSkills'), items: ungrouped })
  groups.push({ id: 'shared', label: t('shared'), items: items.filter(item => item.scope === 'shared') })
  return <div className={css.skillList}>
    {groups.filter(group => group.items.length > 0).map(group => <details key={group.id} className={css.skillGroup} open>
      <summary className={css.groupHeading}>
        <IconChevronDownOutlineRegular size={12} /><IconFolderOpenOutlineRegular size={14} />
        <h2>{group.label}</h2><span>{group.items.length}</span>
      </summary>
      <div className={css.groupFiles}>{group.items.map(item => <button type="button" key={item.id}
        aria-label={t('openSkill', { name: item.name })} aria-pressed={selectedId === item.id}
        className={clsx(css.skillRow, selectedId === item.id && css.selectedRow)} onClick={() => { onSelect(item) }}>
        <span className={css.skillGlyph}><IconSkillOutlineRegular size={15} /></span>
        <span className={css.rowBody}>
          <span className={css.rowTitle}><span className={css.fileName}>{item.name}</span>
            {item.pinned && <IconPinFillRegular size={11} />}</span>
          <span className={css.rowUsage}>{usageText(item, t)}</span>
        </span>
        {item.ownership === 'y-managed' && <span className={css.managedMarker} aria-label={t('managed')} />}
      </button>)}</div>
    </details>)}
  </div>
}

function SkillDetail({
  item, state, budget, t, onClose, closeLabel, act, preview, rollback, loadDetail, onSelect, approvePolicy, setLearningAutomatic,
}: {
  readonly item: SkillLibraryItem
  readonly state: SkillLibraryState
  readonly budget: number
  readonly t: Translate
  readonly onClose: () => void
  readonly closeLabel?: string
  readonly act: SkillLibraryPageProps['act']
  readonly preview: SkillLibraryPageProps['preview']
  readonly rollback: SkillLibraryPageProps['rollback']
  readonly loadDetail: SkillLibraryPageProps['loadDetail']
  readonly onSelect: (item: SkillLibraryItem) => void
  readonly approvePolicy: SkillLibraryPageProps['approvePolicy']
  readonly setLearningAutomatic: SkillLibraryPageProps['setLearningAutomatic']
}): ReactNode {
  const [confirm, setConfirm] = useState<'adopt' | 'archive' | null>(null)
  const detail = state.detail?.item.id === item.id ? state.detail : null
  const loaded = detail?.item ?? item
  const hasSize = loaded.contentHash !== ''
  const closeCopy = closeLabel ?? t('close')
  const requestedAction = confirm
  const submit = (): void => { if (requestedAction !== null) { act(requestedAction, loaded); setConfirm(null) } }
  return <aside className={css.detail} aria-label={t('details')}>
    <div className={css.detailHeader}>
      <span className={css.documentTab}><IconSkillOutlineRegular size={14} /><span>{loaded.name}</span>
        <span className={css.documentFile}>{t('skillFile')}</span></span>
      <Tooltip label={closeCopy} portal><Button size="sm" aria-label={closeCopy} onClick={onClose}><IconCloseOutlineRegular size={14} /></Button></Tooltip>
    </div>
    <h2 className={css.detailTitle}>{loaded.name}</h2>
    <p className={css.secondary}>{loaded.description}</p>
    <Badges item={loaded} t={t} />
    <div className={css.actionRow}>
      <Button size="sm" variant="outline" disabled={state.busy} aria-pressed={loaded.pinned}
        icon={loaded.pinned ? <IconPinFillRegular size={13} /> : <IconPinOutlineRegular size={13} />}
        onClick={() => { act(loaded.pinned ? 'unpin' : 'pin', loaded) }}>{t(loaded.pinned ? 'unpin' : 'pin')}</Button>
      {loaded.capabilities.adopt && <Button size="sm" variant="outline" disabled={state.busy} onClick={() => { setConfirm('adopt') }}>{t('adopt')}</Button>}
      {loaded.capabilities.archive && <Button size="sm" disabled={state.busy} icon={<IconArchiveOutlineRegular size={13} />} onClick={() => { setConfirm('archive') }}>{t('archive')}</Button>}
      {loaded.capabilities.restore && <Button size="sm" variant="outline" disabled={state.busy} onClick={() => { act('restore', loaded) }}>{t('restore')}</Button>}
    </div>
    <section className={css.readingSection}>
      <div className={css.sectionHeading}><h3>{t('instructions')}</h3><span className={css.readOnly}>{t('readOnly')}</span></div>
      {loaded.capabilities.native && loaded.contentHash === '' ? <p className={css.secondary}>{t('instructionsUnavailable')}</p>
        : state.detailStatus === 'loading' ? <span role="status" aria-label={t('loading')} className={css.spinner}><IconLoadingOutlineRegular size={18} /></span>
          : state.detailStatus === 'error' ? <div className={css.note}><p>{t('detailError')}</p><Button size="sm" onClick={() => { loadDetail(loaded.id) }}>{t('retry')}</Button></div>
            : detail !== null && <pre className={css.instructions}>{detail.content}</pre>}
    </section>
    <dl className={css.metadata}>
      <dt>{t('scope')}</dt><dd>{t(loaded.scope === 'shared' ? 'shared' : 'project')}</dd>
      <dt>{t('source')}</dt><dd>{loaded.provider} · {loaded.source}</dd>
      <dt>{t('sourceVersion')}</dt><dd className={css.path}>{loaded.contentHash || t('checkUnknown')}</dd>
      <dt>{t('location')}</dt><dd className={css.path}>{loaded.path}</dd>
      <dt>{t('size')}</dt><dd>{hasSize ? t('bytes', { count: loaded.bodyBytes }) : t('unknownSize')}
        {hasSize && loaded.bodyBytes > budget && <Tag tone="warning">{t('overBudget')}</Tag>}
      </dd>
      <dt>{t('modelInvocation')}</dt><dd>{t(loaded.invocation.modelInvocable ? 'allowed' : 'blocked')}</dd>
      <dt>{t('directInvocation')}</dt><dd>{t(loaded.invocation.userInvocable ? 'allowed' : 'blocked')}</dd>
    </dl>
    <section className={css.detailSection}>
      <h3>{t('usage')}</h3><p>{usageText(loaded, t)}</p>
      <p className={css.secondary}>{t(loaded.usage.coverage === 'unknown' ? 'usageUnknown' : 'usageRecorded')}</p>
      {loaded.usage.lastLoadedAt !== undefined && <p>{t('lastLoaded')} · <time dateTime={loaded.usage.lastLoadedAt}>{loaded.usage.lastLoadedAt}</time></p>}
    </section>
    {loaded.capabilities.cleanup && <section className={css.detailSection}>
      <div className={css.sectionHeading}><h3>{t('automatic')}</h3><Switch label={t('automatic')} checked={loaded.automaticCleanup}
        disabled={state.busy || loaded.pinned} onChange={(enabled) => { act(enabled ? 'automaticOn' : 'automaticOff', loaded) }} /></div>
      <p className={css.secondary}>{t('automaticHint')}</p><p className={css.secondary}>{t('automaticReview')}</p>
      <Button size="sm" variant="outline" disabled={state.busy || loaded.pinned} onClick={() => { preview([loaded.id]) }}>{t('cleanupSelected')}</Button>
    </section>}
    {loaded.capabilities.native && <p className={css.note}>{t('nativeReadOnly')}</p>}
    <SkillLearningPolicyControls item={loaded} state={state.learning} busy={state.busy} t={t}
      approvePolicy={approvePolicy} setLearningAutomatic={setLearningAutomatic} />
    <section className={css.detailSection}>
      <h3>{t('references')}</h3>
      {loaded.references.length === 0 ? <p className={css.secondary}>{t('noReferences')}</p>
        : <ul className={css.references}>{loaded.references.map((reference, index) => <li key={`${reference.target}:${index}`}>
          {reference.resolvedId === undefined ? <span>{reference.target}</span>
            : <button className={css.referenceButton} type="button" onClick={() => {
              const related = state.inventory?.items.find(candidate => candidate.id === reference.resolvedId)
              if (related !== undefined) onSelect(related)
            }}>{reference.target}</button>}
        </li>)}</ul>}
    </section>
    <section className={css.detailSection}>
      <h3>{t('history')}</h3>
      {detail === null || detail.revisions.length === 0 ? <p className={css.secondary}>{t('noHistory')}</p>
        : detail.revisions.map(revision => <div key={revision.id} className={css.revision}>
          <div><span>{t(revision.reason === 'cleanup' ? 'revisionCleanup' : revision.reason === 'learning' ? 'revisionLearning' : 'revisionRollback')}</span><time dateTime={revision.createdAt}>{revision.createdAt}</time>
            <span>{revision.beforeBytes} → {revision.afterBytes}</span></div>
          <Button size="sm" disabled={state.busy} onClick={() => { rollback(loaded, revision.id) }}>{t('rollback')}</Button>
        </div>)}
    </section>
    <Modal open={confirm !== null} title={t(confirm === 'archive' ? 'archiveTitle' : 'adoptTitle')}
      description={t(confirm === 'archive' ? 'archiveDescription' : 'adoptDescription')}
      closeLabel={t('close')} onClose={() => { setConfirm(null) }} footer={<>
        <Button onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
        <Button variant="primary" onClick={submit}>{t(confirm === 'archive' ? 'archive' : 'adopt')}</Button>
      </>} />
  </aside>
}

function CleanupDialog({ state, t, closePreview, applyPreview }: Pick<SkillLibraryPageProps, 't' | 'closePreview' | 'applyPreview'> & { readonly state: SkillLibraryState }): ReactNode {
  const proposal = state.proposal
  const labels = { codeLabel: t('diff'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'), copy: t('copy'), copied: t('copied'),
    collapseAria: t('collapse'), collapse: t('collapse'), expandAria: (count: number) => t('expand', { count }), expand: (count: number) => t('expand', { count }) }
  return <Modal open={state.cleanupOpen} title={t('cleanupTitle')} description={t('cleanupDescription')}
    closeLabel={t('close')} onClose={closePreview} className={clsx(css.cleanupDialog)}
    footer={<><Button disabled={state.busy} onClick={closePreview}>{t('cancel')}</Button>
      <Button variant="primary" disabled={state.busy || proposal === null || proposal.changes.length === 0} onClick={applyPreview}>{t('apply')}</Button></>}>
    <p className={css.secondary}>{t('automaticReview')}</p>
    {state.previewLoading && <span className={css.spinner} role="status" aria-label={t('loading')}><IconLoadingOutlineRegular size={18} /></span>}
    {state.previewError && <p className={css.note}>{t('loadError')}</p>}
    {proposal !== null && <>
      {proposal.changes.length === 0 ? <p>{t('cleanupEmpty')}</p>
        : <p>{t('cleanupSummary', { count: proposal.changes.length, bytes: proposal.changes.reduce((sum, change) => sum + change.beforeBytes - change.afterBytes, 0) })}</p>}
      {proposal.changes.map(change => <section key={change.id} className={css.cleanupChange}>
        <div className={css.sectionHeading}><h3>{change.name}</h3>{change.overBudget && <Tag tone="warning">{t('overBudget')}</Tag>}</div>
        <DiffBlock diffs={[{ path: change.name, oldText: change.before, newText: change.after }]} labels={labels} maxLines={24} />
      </section>)}
      {proposal.skipped.length > 0 && <p className={css.secondary}>{t('cleanupSkipped', { count: proposal.skipped.length })}</p>}
    </>}
  </Modal>
}

/**
 * Render metadata first and read full instructions only for the selected item.
 * @param props - framework-bound copy, controller callbacks, and navigation store.
 * @returns the library or entire filtered graph with a detail pane.
 */
export function SkillLibraryPage(props: SkillLibraryPageProps): ReactNode {
  const {
    t, useLibrary, useStore, actions, ensure, refresh, loadDetail, act, preview,
    closePreview, applyPreview, rollback, approvePolicy, setLearningAutomatic,
  } = props
  const state = useLibrary(value => value)
  const navigation = useStore(value => value)
  const [explorerVisible, setExplorerVisible] = useState(true)
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const inspectorPane = useRef<HTMLDivElement>(null)
  const inspectorToggle = useRef<HTMLButtonElement>(null)
  const inspectorFocus = useRef<'open' | 'closed' | null>(null)
  useEffect(() => {
    if (inspectorFocus.current === 'closed') inspectorToggle.current?.focus()
    else if (inspectorFocus.current === 'open') inspectorPane.current?.querySelector('button')?.focus()
    inspectorFocus.current = null
  }, [inspectorVisible])
  useEffect(() => { if (navigation.selectedId !== null) setInspectorVisible(true) }, [navigation.selectedId])
  useEffect(() => { ensure() }, [ensure])
  useEffect(() => {
    if (navigation.view === 'review' && state.learning.detailId !== null) actions.selectReview(state.learning.detailId)
  }, [navigation.view, state.learning.detailId, actions])
  const inventory = state.inventory
  const items = useMemo(() => inventory === null ? [] : matchingItems(inventory, navigation),
    [inventory, navigation.query, navigation.project, navigation.status])
  const selected = inventory?.items.find(item => item.id === navigation.selectedId)
  const select = (item: SkillLibraryItem): void => { setInspectorVisible(true); actions.select(item.id); loadDetail(item.id) }
  const selectId = (id: SkillLibraryItem['id']): void => { const item = inventory?.items.find(candidate => candidate.id === id); if (item !== undefined) select(item) }
  const unavailable = inventory?.providers.some(provider => provider.state !== 'connected') === true
  const projectOptions = inventory?.projects.map(project => ({ value: project.id, label: project.title })) ?? []
  for (const id of new Set(inventory?.items.flatMap(item => item.projectIds) ?? [])) {
    if (!projectOptions.some(option => option.value === id)) projectOptions.push({ value: id, label: id })
  }
  const detail = selected === undefined ? null : <SkillDetail key={selected.id} item={selected} state={state}
    budget={inventory?.bodyBudgetBytes ?? 0} t={t}
    act={act} preview={preview} rollback={rollback} loadDetail={loadDetail} onSelect={select} approvePolicy={approvePolicy}
    setLearningAutomatic={setLearningAutomatic} closeLabel={navigation.view === 'graph' ? t('hideInspector') : t('close')}
    onClose={() => { if (navigation.view === 'graph') { inspectorFocus.current = 'closed'; setInspectorVisible(false) } else actions.select(null) }} />
  return <div className={css.page} data-yh-terminal="panel">
    <header className={css.header} data-window-drag data-yh-terminal="toolbar">
      <div className={css.workspaceTitle}>
        {navigation.view !== 'review' && <Tooltip label={t(explorerVisible ? 'hideExplorer' : 'showExplorer')} portal>
          <Button size="sm" aria-label={t(explorerVisible ? 'hideExplorer' : 'showExplorer')} aria-expanded={explorerVisible}
            aria-controls="skill-library-explorer" onClick={() => { setExplorerVisible(value => !value) }}><IconPanelLeftOutlineRegular size={15} /></Button>
        </Tooltip>}
        <h1>{t('panel')}</h1>
      </div>
      <SegmentedControl appearance="tabs" id="skill-library-view" label={t('view')} value={navigation.view} options={[{ value: 'library', label: t('library') }, { value: 'graph', label: t('graph') }, { value: 'review', label: t('review') }]} onChange={actions.setView} />
    </header>
    <div className={css.toolbar} data-yh-terminal="toolbar">
      <Input className={clsx(css.search)} aria-label={t(navigation.view === 'review' ? 'searchReviews' : 'search')} placeholder={t(navigation.view === 'review' ? 'searchReviews' : 'search')} value={navigation.query}
        icon={<IconSearchOutlineRegular size={14} />} onChange={(event) => { actions.setQuery(event.target.value) }} />
      <FilterMenu label={t('project')} value={navigation.project} onChange={actions.setProject}
        options={[{ value: 'all', label: t('allProjects') }, ...navigation.view === 'review' ? [] : [{ value: 'shared', label: t('shared') }], ...projectOptions]} />
      {navigation.view !== 'review' && <FilterMenu label={t('status')} value={navigation.status} onChange={actions.setStatus}
        options={[{ value: 'all', label: t('allStatuses') }, { value: 'active', label: t('active') }, { value: 'disabled', label: t('disabled') }, { value: 'archived', label: t('archived') }]} />}
      <div className={css.headerActions}>
        <Tooltip label={t('refresh')} portal><Button size="sm" aria-label={t('refresh')} onClick={refresh}><IconRefreshOutlineRegular size={15} /></Button></Tooltip>
        <Button variant="outline" size="sm" disabled={state.busy || inventory === null} onClick={() => { preview() }}>{t('cleanup')}</Button>
      </div>
    </div>
    {state.readError && <div className={css.queryNotice}><span>{t('loadError')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button></div>}
    {navigation.view === 'review' ? <SkillReviews t={t} state={state.learning} inventory={inventory} selectedId={navigation.selectedReviewId} selectReview={actions.selectReview}
      project={navigation.project} query={navigation.query} busy={state.busy} loadReview={props.loadReview}
      validateReview={props.validateReview} approveReview={props.approveReview}
      rejectReview={props.rejectReview} proposeLearning={props.proposeLearning} refreshLearning={props.refreshLearning} openSkill={(id) => { actions.setView('library'); actions.select(id); loadDetail(id) }} />
      : <div id={`skill-library-view-${navigation.view}-panel`} role="tabpanel" aria-labelledby={`skill-library-view-${navigation.view}`}
        className={clsx(css.content, !explorerVisible && css.explorerHidden, navigation.view === 'graph' && css.graphContent)}>
        {explorerVisible && <aside id="skill-library-explorer" className={clsx(css.inventory, css.explorer)} aria-label={t('explorer')}>
          <div className={css.explorerHeading}><span>{t('files')}</span></div>
          {inventory !== null && (items.length === 0 ? <div className={css.empty}><IconSearchOutlineRegular size={24} /><p>{t(inventory.items.length === 0 ? 'empty' : 'noResults')}</p></div>
            : <SkillList items={items} inventory={inventory} selectedId={navigation.selectedId} onSelect={select} t={t} />)}
        </aside>}
        <div className={css.documentWorkspace}>
          {inventory === null ? state.status === 'loading' ? <span role="status" aria-label={t('loading')} className={css.spinner}><IconLoadingOutlineRegular size={18} /></span>
            : <div className={css.empty}><IconSkillOutlineRegular size={28} /><p>{t('empty')}</p></div>
            : navigation.view === 'graph' ? <>
              {items.length === 0 ? <div className={css.empty}><IconSearchOutlineRegular size={24} /><p>{t(inventory.items.length === 0 ? 'empty' : 'noResults')}</p></div>
                : <SkillGraph items={items} projects={inventory.projects} selectedId={navigation.selectedId}
                  onSelect={selectId} onProject={actions.setProject} t={t} />}
              {selected !== undefined && (inspectorVisible ? <div ref={inspectorPane} id="skill-library-inspector" className={css.inspector}>{detail}</div>
                : <div className={css.inspectorToggle}><Button ref={inspectorToggle} size="sm" variant="outline" aria-controls="skill-library-inspector" aria-expanded={false}
                  onClick={() => { inspectorFocus.current = 'open'; setInspectorVisible(true) }}>{t('showInspector')}</Button></div>)}
            </> : detail ?? <aside className={css.detailEmpty}>
              <IconSkillOutlineRegular size={30} /><h2>{t('selectSkill')}</h2><p>{t('selectHint')}</p>
            </aside>}
        </div>
      </div>}
    {inventory !== null && <footer className={css.summary}>
      <span>{t('skillsCount', { count: inventory.items.length })}</span><span>{t('projectsCount', { count: inventory.projects.length })}</span>
      <span>{t('managedCount', { count: inventory.items.filter(item => item.ownership === 'y-managed').length })}</span>
      {unavailable && <details className={css.providerNotice}><summary>{t('sourceUnavailable')}</summary>
        <div className={css.providers}><p>{t('providerUnavailable')}</p>{inventory.providers.map(provider => <span key={provider.provider}>{provider.provider} · {t(provider.state)}</span>)}</div>
      </details>}
      <span className={css.budget}>{t('budget', { count: inventory.bodyBudgetBytes })}</span>
    </footer>}
    <CleanupDialog state={state} t={t} closePreview={closePreview} applyPreview={applyPreview} />
  </div>
}
