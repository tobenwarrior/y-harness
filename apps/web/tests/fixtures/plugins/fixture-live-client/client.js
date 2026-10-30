/** Test package using the published registration protocol, locale and slots. */
window.__ModuleLoader__.load({
  id: '@fixture/live-client',
  factory(require) {
    const React = require('react')
    const { MenuItemButton } = require('@yharness/client-ui-primitives')
    const style = document.createElement('style')
    style.dataset.plugin = '@fixture/live-client'
    style.textContent = '[data-live-client] { color: rgb(12, 34, 56); position: absolute; bottom: 20px; right: 20px; }'
    document.head.append(style)
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const counters = document.documentElement.dataset
        counters.liveMounts = String(Number(counters.liveMounts ?? 0) + 1)
        ctx.effect(() => ctx.locale.register('fixtureLive', {
          zh: {
            active: '\u{52A8}\u{6001}\u{63D2}\u{4EF6}\u{5DF2}\u{542F}\u{7528}', configSummary: '\u{793A}\u{4F8B}\u{914D}\u{7F6E}\u{9879}', configForm: '\u{52A8}\u{6001}\u{63D2}\u{4EF6}\u{914D}\u{7F6E}', configField: '\u{95EE}\u{5019}\u{8BED}', configSave: '\u{4FDD}\u{5B58}',
            action: '\u{5939}\u{5177}\u{64CD}\u{4F5C}', badge: '\u{5939}\u{5177}\u{6807}\u{7B7E}', section: '\u{5939}\u{5177}\u{533A}\u{5757}', sectionBody: '\u{6765}\u{81EA}\u{5939}\u{5177}\u{7684}\u{533A}\u{5757}\u{5185}\u{5BB9}',
            exportSession: '\u{5BFC}\u{51FA}\u{4F1A}\u{8BDD}', copySessionId: '\u{590D}\u{5236}\u{4F1A}\u{8BDD} ID',
          },
          en: {
            active: 'Live plugin enabled', configSummary: 'An example setting', configForm: 'Live plugin configuration', configField: 'Greeting', configSave: 'Save',
            action: 'Fixture action', badge: 'Fixture badge', section: 'Fixture section', sectionBody: 'Section content from the fixture',
            exportSession: 'Export session', copySessionId: 'Copy session ID',
          },
        }))
        // Detail contributions for this bundle's own page and its row's page: an
        // action at the head, a badge beside the title, and a section below.
        // The subject says what the open page is about; another bundle's page
        // gets nothing from these entries.
        const mine = (subject) => (subject.kind === 'bundle' || subject.kind === 'row') && subject.pkg.name === '@fixture/live-client'
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t, subject }) => mine(subject)
          ? React.createElement('button', { type: 'button', 'data-live-action': subject.kind }, t('action'))
          : null))
        ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
          name: 'plugins.detail.badge', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t, subject }) => mine(subject)
          ? React.createElement('span', { 'data-live-badge': subject.kind }, t('badge'))
          : null))
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t, subject }) => mine(subject)
          ? React.createElement('section', { 'data-live-section': subject.kind, 'aria-label': t('section') },
            React.createElement('h4', null, t('section')),
            React.createElement('p', null, t('sectionBody')))
          : null))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t }) => React.createElement('div', { 'data-live-client': '' }, t('active'))))
        // The configuration of this bundle's one row, as the Plugins page renders it on the row's own page.
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@fixture/live-client#fixture-live-client', locale: 'fixtureLive',
        }, ({ t, view }) => view === 'summary'
          ? t('configSummary')
          : React.createElement('form', {
            'data-live-config': '',
            'aria-label': t('configForm'),
            onSubmit: (event) => {
              event.preventDefault()
              counters.liveSaves = String(Number(counters.liveSaves ?? 0) + 1)
            },
          },
          React.createElement('label', null, t('configField'), React.createElement('input', { name: 'greeting', defaultValue: 'hello' })),
          React.createElement('button', { type: 'submit' }, t('configSave')))))
        const actionInjected = () => ({
          selectAction(action, sessionId, displayTitle) {
            counters.sessionAction = action
            counters.sessionActionId = sessionId
            counters.sessionActionTitle = displayTitle
          },
        })
        const registerSessionAction = (id, order, label, separatorBefore) => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id, order, locale: 'fixtureLive', inject: actionInjected,
        }, ({ sessionId, displayTitle, useMenuOpenState, selectAction, t }) => {
          const [, setMenuOpen] = useMenuOpenState()
          return React.createElement(
            MenuItemButton,
            {
              separatorBefore,
              onSelect: () => {
                setMenuOpen(false)
                selectAction(id, sessionId, displayTitle)
              },
            },
            t(label),
          )
        })
        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          // The shipped rows end at archive (400); these follow as one group,
          // opened by the export row's hairline.
          yield registerSessionAction('fixture.export-session', 500, 'exportSession', true)
          yield registerSessionAction('fixture.copy-session-id', 600, 'copySessionId', false)
        })
        ctx.effect(() => {
          const ping = () => { counters.liveHits = String(Number(counters.liveHits ?? 0) + 1) }
          window.addEventListener('dsh-fixture-ping', ping)
          return async () => {
            window.removeEventListener('dsh-fixture-ping', ping)
            await Promise.resolve()
            counters.liveDisposals = String(Number(counters.liveDisposals ?? 0) + 1)
          }
        })
      },
    }
  },
})
