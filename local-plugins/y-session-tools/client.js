/**
 * Browser half of the y-session-tools bundle.
 *
 * Four Session-row menu entries and the confirmation they raise:
 *
 * - copy the raw Session id,
 * - copy the canonical `@[label](dsh-session:…)` reference mention, so the
 *   Session can be pasted into another Session's composer as context,
 * - copy the Session's stored artifact directory,
 * - permanently delete a Session, behind a confirmation dialog in the
 *   frame-wide overlay.
 *
 * The id and the mention are protocol values owned by the Host, so the mention
 * and the directory are read from the bundle's Host route rather than rebuilt
 * here. The dialog is written against the host's markup and theme tokens; it
 * imports no other Client package beyond the module table's React and store.
 */
window.__ModuleLoader__.load({
  id: '@local/y-session-tools',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    const { useEffect, useRef, useState } = React
    const h = React.createElement

    /** Dictionary namespace owned by this bundle. */
    const NS = 'y-session-tools'
    /** Document-relative form of the Host route registered by `index.js`. */
    const ROUTE = 'api/y-session-tools.session'

    const EN = {
      'menu.copyId': 'Copy session ID',
      'menu.copyReference': 'Copy session reference',
      'menu.copyPath': 'Copy session path',
      'menu.copied': 'Copied',
      'menu.copyFailed': 'Copy failed',
      'menu.delete': 'Delete session…',
      'delete.title': 'Delete session permanently?',
      'delete.description': '“{title}” and its stored log will be removed from disk.',
      'delete.warning': 'This cannot be undone. Archiving keeps the session; deleting does not.',
      'delete.action': 'Delete permanently',
      'delete.pending': 'Deleting…',
      'delete.live': 'This session is running. Stop it before deleting it.',
      'delete.notFound': 'This session has no stored log to delete.',
      'delete.failed': 'Delete failed.',
      'cancel': 'Cancel',
    }

    const ZH = {
      'menu.copyId': '复制会话 ID',
      'menu.copyReference': '复制会话引用',
      'menu.copyPath': '复制会话路径',
      'menu.copied': '已复制',
      'menu.copyFailed': '复制失败',
      'menu.delete': '删除会话…',
      'delete.title': '永久删除会话？',
      'delete.description': '“{title}”及其存储的日志将从磁盘中删除。',
      'delete.warning': '此操作无法撤销。归档会保留会话，删除不会。',
      'delete.action': '永久删除',
      'delete.pending': '正在删除…',
      'delete.live': '该会话正在运行，请先停止再删除。',
      'delete.notFound': '该会话没有可删除的日志。',
      'delete.failed': '删除失败。',
      'cancel': '取消',
    }

    /** Menu rows and the confirmation card, styled with host theme tokens. */
    const CSS = `
.yst-item-wrap { position: relative; }
.yst-separator { height: 0; margin: 3px 0; border-top: 0.5px solid var(--yh-alias-border-l2); }
.yst-item {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px;
  padding: 6px 8px; border: none; border-radius: var(--yh-radius-md);
  background: transparent; cursor: pointer; font-size: 13px; line-height: 20px;
  color: var(--yh-alias-label-primary); text-align: left;
}
.yst-item:hover:not(:disabled), .yst-item:focus-visible:not(:disabled) {
  background: var(--yh-alias-interactive-bg-hover); outline: none;
}
.yst-item-danger { color: var(--yh-alias-state-error-primary); }
.yst-item-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yst-modal-root {
  pointer-events: auto; position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.yst-modal-mask {
  position: absolute; inset: 0; backdrop-filter: var(--yh-mask-blur);
  background: var(--yh-alias-bg-mask-1);
}
.yst-modal-card {
  position: relative; z-index: 1; display: flex; flex-direction: column; gap: 12px;
  box-sizing: border-box; width: min(420px, 100%); padding: 22px 24px 20px;
  border-radius: var(--yh-radius-panel); background: var(--yh-alias-bg-layer-2);
  box-shadow: var(--yh-elevation-prominent);
}
.yst-modal-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--yh-alias-label-primary); }
.yst-modal-description { margin: 0; font-size: 14px; line-height: 22px; color: var(--yh-alias-label-primary); }
.yst-modal-warning { margin: 0; font-size: 13px; line-height: 20px; color: var(--yh-alias-label-secondary); }
.yst-modal-error { font-size: 12px; line-height: 18px; color: var(--yh-alias-state-error-primary); }
.yst-modal-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.yst-button {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--yh-radius-md);
  background: transparent; cursor: pointer; font-size: 14px; line-height: 22px;
  color: var(--yh-alias-label-primary);
}
.yst-button:disabled { cursor: not-allowed; opacity: 0.4; }
.yst-button-outline { border: 0.5px solid var(--yh-alias-border-l3); }
.yst-button-outline:hover:not(:disabled) { background: var(--yh-alias-interactive-bg-hover); }
.yst-button-danger:not(:disabled) { color: var(--yh-alias-state-error-primary); }
`

    /**
     * Copy text to the clipboard.
     * @param text - exact value to place on the clipboard.
     * @returns after the clipboard holds the value.
     */
    async function writeClipboard(text) {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
        return
      }
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const copied = document.execCommand('copy')
      area.remove()
      if (!copied) throw new Error('clipboard is unavailable')
    }

    /**
     * Read one Session's Host-owned facts.
     * @param sessionId - Session to describe.
     * @param label - display label for the reference mention.
     * @returns `{ sessionId, path, mention }`.
     */
    async function fetchSessionInfo(sessionId, label) {
      const query = new URLSearchParams({ sessionId: String(sessionId), label: label || String(sessionId) })
      const response = await fetch(`${ROUTE}?${query.toString()}`, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw await failureFrom(response, payload)
      return payload
    }

    /**
     * Delete one Session through the Host route.
     * @param sessionId - Session to delete.
     * @returns the Host result.
     */
    async function deleteSession(sessionId) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: String(sessionId) }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw await failureFrom(response, payload)
      return payload
    }

    /**
     * Build the error one failed route response carries.
     * @param response - failed response.
     * @param payload - parsed body, when it was JSON.
     * @returns the error, tagged with the Host's stable code.
     */
    async function failureFrom(response, payload) {
      const error = new Error(payload?.message ?? `HTTP ${response.status}`)
      error.code = payload?.code
      return error
    }

    /** Localized text for one failure, keyed by the Host's stable code. */
    function failureText(error, t) {
      if (error?.code === 'session/live') return t('delete.live')
      if (error?.code === 'session/not-found') return t('delete.notFound')
      return error instanceof Error && error.message ? error.message : t('delete.failed')
    }

    /**
     * One copy row. The menu stays open so the outcome is visible where the
     * gesture happened; a copy that closed the menu would report nothing.
     */
    function CopyMenuItem(props) {
      const { t, labelKey, run, sessionId, displayTitle } = props
      const [outcome, setOutcome] = useState(null)
      const select = () => {
        Promise.resolve()
          .then(() => run(sessionId, displayTitle))
          .then(() => setOutcome('copied'), () => setOutcome('failed'))
      }
      const label = outcome === 'copied' ? t('menu.copied')
        : outcome === 'failed' ? t('menu.copyFailed')
          : t(labelKey)
      return h(
        'div',
        { className: 'yst-item-wrap' },
        labelKey === 'menu.copyId' ? h('div', { className: 'yst-separator', role: 'separator' }) : null,
        h('button', { type: 'button', role: 'menuitem', className: 'yst-item', onClick: select },
          h('span', { className: 'yst-item-label' }, label)),
      )
    }

    /** The destructive row: it closes the menu and raises the confirmation. */
    function DeleteSessionMenuItem(props) {
      const { t, sessionId, displayTitle, useMenuOpenState, requestDelete } = props
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        'div',
        { className: 'yst-item-wrap' },
        h('div', { className: 'yst-separator', role: 'separator' }),
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: 'yst-item yst-item-danger',
          onClick: () => {
            setMenuOpen(false)
            requestDelete(sessionId, displayTitle)
          },
        }, h('span', { className: 'yst-item-label' }, t('menu.delete'))),
      )
    }

    /** Frame-wide entry: nothing while no deletion is pending, else one dialog. */
    function DeleteSessionDialog(props) {
      const request = props.useDeleteRequest(value => value)
      if (request === null) return null
      return h(DeleteConfirmForm, {
        key: request.sessionId,
        request,
        settleDelete: props.settleDelete,
        deleteSession: props.deleteSession,
        t: props.t,
      })
    }

    /** One request's dialog: in-flight and error state die with it. */
    function DeleteConfirmForm({ request, settleDelete, deleteSession, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const busyRef = useRef(false)
      const cancelRef = useRef(null)
      const close = () => { if (!busyRef.current) settleDelete() }

      useEffect(() => {
        const previous = document.activeElement
        cancelRef.current?.focus()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (!busyRef.current) settleDelete()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
        }
      }, [settleDelete])

      const confirm = () => {
        busyRef.current = true
        setBusy(true)
        setError(null)
        deleteSession(request.sessionId).then(() => {
          settleDelete()
        }).catch((reason) => {
          busyRef.current = false
          setBusy(false)
          setError(failureText(reason, t))
        })
      }

      return createPortal(
        h('div', { className: 'yst-modal-root', role: 'presentation' },
          h('div', { className: 'yst-modal-mask', 'aria-hidden': true, onClick: close }),
          h('div', {
            className: 'yst-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('delete.title'),
          },
          h('h2', { className: 'yst-modal-title' }, t('delete.title')),
          h('p', { className: 'yst-modal-description' },
            t('delete.description', { title: request.displayTitle || request.sessionId })),
          h('p', { className: 'yst-modal-warning' }, t('delete.warning')),
          error !== null ? h('div', { className: 'yst-modal-error', role: 'alert' }, error) : null,
          h('div', { className: 'yst-modal-footer' },
            h('button', {
              ref: cancelRef,
              type: 'button',
              className: 'yst-button yst-button-outline',
              disabled: busy,
              onClick: close,
            }, t('cancel')),
            h('button', {
              type: 'button',
              className: 'yst-button yst-button-outline yst-button-danger',
              disabled: busy,
              onClick: confirm,
            }, busy ? t('delete.pending') : t('delete.action'))))),
        document.body,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'y-session-tools: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'y-session-tools: styles')

        /** The pending deletion the menu raises and the dialog consumes. */
        const deleteRequest = createSnapshotStore(null)
        const copySessionId = (sessionId) => writeClipboard(String(sessionId))
        const copySessionReference = async (sessionId, displayTitle) => {
          const info = await fetchSessionInfo(sessionId, displayTitle)
          await writeClipboard(info.mention)
        }
        const copySessionPath = async (sessionId, displayTitle) => {
          const info = await fetchSessionInfo(sessionId, displayTitle)
          if (typeof info.path !== 'string' || info.path === '') throw new Error('session has no stored directory')
          await writeClipboard(info.path)
        }
        const menuInjected = () => ({
          copySessionId,
          copySessionReference,
          copySessionPath,
          requestDelete: (sessionId, displayTitle) => {
            deleteRequest.set({ sessionId: String(sessionId), displayTitle: displayTitle ?? '' })
          },
        })
        const dialogInjected = () => ({
          hooks: { deleteRequest },
          settleDelete: () => { deleteRequest.set(null) },
          deleteSession,
        })

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'y-session-tools.copy-id', order: 500, locale: NS,
              inject: () => ({ ...menuInjected(), labelKey: 'menu.copyId', run: copySessionId }) },
            CopyMenuItem,
          )
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'y-session-tools.copy-reference', order: 510, locale: NS,
              inject: () => ({ ...menuInjected(), labelKey: 'menu.copyReference', run: copySessionReference }) },
            CopyMenuItem,
          )
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'y-session-tools.copy-path', order: 520, locale: NS,
              inject: () => ({ ...menuInjected(), labelKey: 'menu.copyPath', run: copySessionPath }) },
            CopyMenuItem,
          )
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'y-session-tools.delete', order: 900, locale: NS,
              inject: menuInjected },
            DeleteSessionMenuItem,
          )
        })
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'y-session-tools.delete-session', locale: NS, inject: dialogInjected },
          DeleteSessionDialog,
        ))
      },
    }
  },
})
