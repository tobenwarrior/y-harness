/** Native desktop view of the private VPS workspace. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@yharness/atomic-write'
import { WebContentsView, session, type BrowserWindow } from 'electron'
import { isCloudTarget, openCloudConnection, type CloudConnection } from './cloud-connection.ts'
import {
  CLOUD_DESKTOP_USER_AGENT,
  cloudAction,
  cloudDocument,
  cloudRequestAllowed,
  cloudSignInCookie,
  cloudWebsiteLoginUseRequestId,
  cloudVaultRequestId,
  type CloudWorkspaceStatus,
} from './cloud-workspace-document.ts'
import type { DesktopCloudVault } from './cloud-vault-window.ts'
import type { DesktopMessages } from './locale.ts'

const BAR_HEIGHT = 50
const RETRY_MS = 5_000
const LOAD_TIMEOUT_MS = 20_000

interface CloudPreference {
  target: string
  selected: boolean
}

function readPreference(file: string): CloudPreference | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof value === 'object' && value !== null && 'target' in value && 'selected' in value
      && typeof value.target === 'string' && isCloudTarget(value.target) && typeof value.selected === 'boolean') {
      return { target: value.target, selected: value.selected }
    }
  } catch {
    // A missing or unreadable preference opens Mac with Cloud setup available.
  }
}

function closeView(view: WebContentsView | undefined): void {
  const contents = view?.webContents
  if (contents !== undefined && !contents.isDestroyed()) contents.close()
}

/** Keeps the Cloud renderer isolated from the desktop-owned renderer and its IPC. */
export class DesktopCloudWorkspace {
  private owner: BrowserWindow | undefined
  private controls: WebContentsView | undefined
  private remote: WebContentsView | undefined
  private controlsDocument: string | undefined
  private connection: CloudConnection | undefined
  private pending: AbortController | undefined
  private saved: CloudPreference | undefined
  private target: string | undefined
  private selected = false
  private invalidTarget = false
  private status: CloudWorkspaceStatus = 'setup'
  private retry: NodeJS.Timeout | undefined
  private writes = Promise.resolve()

  /**
   * @param file - owner-private local preference path.
   * @param messages - current native shell dictionary.
   * @param preferenceError - notification when the choice cannot be saved.
   * @param vault - application-owned VPS secret window.
   * @param onShowCloud - revokes access scoped to the Mac workspace.
   */
  constructor(private readonly file: string, private readonly messages: () => DesktopMessages,
    private readonly preferenceError: () => void, private readonly vault: DesktopCloudVault,
    private readonly onShowCloud?: () => void) {}

  private onClosed = (): void => { void this.dispose() }

  /** @param owner - ready desktop window that owns the workspace views. */
  attach(owner: BrowserWindow): void {
    if (this.owner === owner) return
    this.owner = owner
    this.saved = readPreference(this.file)
    this.target = this.saved?.target
    owner.on('resize', this.layout)
    owner.once('closed', this.onClosed)
    if (this.saved?.selected === true) this.showCloud()
  }

  /** @returns Whether Cloud is covering the Mac workspace. */
  isCloudSelected(): boolean { return this.selected }

  /** Open Cloud or its first-time setup in the existing window. */
  showCloud(): void {
    if (this.owner === undefined) return
    this.selected = true
    this.onShowCloud?.()
    if (this.saved !== undefined && !this.saved.selected) this.save(this.saved.target)
    if (this.connection === undefined && this.pending === undefined && this.target !== undefined) {
      void this.connect(this.target)
      return
    }
    this.render()
  }

  /** Return to the local workspace, preserving an open Cloud view for quick switching. */
  showMac(): void {
    this.vault.close()
    this.selected = false
    if (this.connection === undefined) this.resetConnection()
    if (this.saved?.selected === true) this.save(this.saved.target)
    this.render()
    this.owner?.webContents.focus()
  }

  /** Open Vault for the active Cloud connection. */
  showVault(): void {
    if (this.selected && this.status === 'online' && this.target !== undefined && this.owner !== undefined) {
      this.vault.open(this.owner, this.target)
    }
  }

  /**
   * Release the view and SSH forward without affecting the server.
   * @returns when the forward and pending preference writes have settled.
   */
  async dispose(): Promise<void> {
    const owner = this.owner
    this.owner = undefined
    owner?.off('resize', this.layout)
    owner?.off('closed', this.onClosed)
    const closed = this.connection?.closed
    this.resetConnection(owner)
    this.release(this.controls, owner)
    this.controls = undefined
    this.controlsDocument = undefined
    await Promise.all([closed, this.writes])
  }

  private save(target: string): void {
    const preference: CloudPreference = { target, selected: this.selected }
    this.saved = preference
    this.writes = this.writes.then(() => writeFileAtomic(this.file, JSON.stringify(preference) + '\n', {
      mode: 0o600, dirMode: 0o700,
    })).catch(() => { if (this.owner !== undefined) this.preferenceError() })
  }

  private layout = (): void => {
    if (this.owner === undefined || this.owner.isDestroyed()) return
    const { width, height } = this.owner.getContentBounds()
    const online = this.status === 'online'
    this.controls?.setBounds({ x: 0, y: 0, width, height: online ? BAR_HEIGHT : height })
    this.remote?.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) })
  }

  private release(view: WebContentsView | undefined, owner = this.owner): void {
    if (view === undefined) return
    if (owner !== undefined && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    closeView(view)
  }

  private render(): void {
    const owner = this.owner
    if (owner === undefined || owner.isDestroyed()) return
    if (!this.selected) {
      this.controls?.setVisible(false)
      this.remote?.setVisible(false)
      return
    }
    if (this.controls === undefined) {
      const controls = new WebContentsView({ webPreferences: {
        partition: `cloud-controls-${randomUUID()}`, nodeIntegration: false, contextIsolation: true,
        sandbox: true, devTools: false,
      } })
      this.controls = controls
      controls.webContents.session.webRequest.onBeforeRequest({ urls: ['https://workspace.invalid/*'] }, (_details, callback) => {
        callback({ cancel: true })
      })
      controls.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      controls.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        const action = cloudAction(url)
        if (action === undefined) return
        switch (action.type) {
          case 'mac': this.showMac(); break
          case 'vault': this.showVault(); break
          case 'configure':
            this.resetConnection()
            this.target = undefined
            this.invalidTarget = false
            this.status = 'setup'
            this.render()
            break
          case 'retry': this.showCloud(); break
          case 'connect':
            this.invalidTarget = !isCloudTarget(action.target)
            if (this.invalidTarget) this.render()
            else void this.connect(action.target)
            break
        }
      })
      owner.contentView.addChildView(controls)
    }
    const document = cloudDocument(this.messages(), this.status, this.invalidTarget)
    if (this.controlsDocument !== document) {
      this.controlsDocument = document
      void this.controls.webContents.loadURL(document).catch(() => {
        // Electron cancels the previous controls load when the connection changes.
      })
    }
    this.layout()
    this.controls.setVisible(true)
    this.remote?.setVisible(this.status === 'online')
    if (this.status === 'online') this.remote?.webContents.focus()
  }

  private resetConnection(owner = this.owner): void {
    this.vault.close()
    clearTimeout(this.retry)
    this.retry = undefined
    const { pending, connection, remote } = this
    this.pending = undefined
    this.connection = undefined
    this.remote = undefined
    this.release(remote, owner)
    pending?.abort()
    connection?.close()
  }

  private disconnected(connection: CloudConnection): void {
    if (this.connection !== connection) return
    const reconnect = this.status === 'online'
    this.resetConnection()
    this.status = 'offline'
    this.render()
    if (reconnect && this.selected) {
      this.retry = setTimeout(() => { if (this.selected) this.showCloud() }, RETRY_MS)
    }
  }

  private isPending(pending: AbortController): boolean {
    return this.pending === pending && !pending.signal.aborted
  }

  private async connect(target: string): Promise<void> {
    const owner = this.owner
    if (owner === undefined || owner.isDestroyed()) return
    this.resetConnection()
    const pending = new AbortController()
    this.pending = pending
    this.target = target
    this.status = 'connecting'
    this.render()
    const timer = setTimeout(() => { pending.abort() }, LOAD_TIMEOUT_MS)
    try {
      const connection = await openCloudConnection(target, pending.signal)
      if (!this.isPending(pending)) { connection.close(); return }
      this.connection = connection
      void connection.closed.then(() => { this.disconnected(connection) })

      const isolated = session.fromPartition(`cloud-workspace-${randomUUID()}`, { cache: false })
      await isolated.setProxy({ mode: 'direct' })
      const response = await fetch(connection.loginUrl, { redirect: 'manual', signal: pending.signal })
      const cookie = cloudSignInCookie(connection.origin, response)
      if (cookie === undefined) throw new Error('Cloud authentication failed')
      await isolated.cookies.set(cookie)
      if (!this.isPending(pending)) return
      isolated.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
      isolated.setPermissionRequestHandler((_contents, permission, callback) => {
        callback(permission === 'clipboard-sanitized-write')
      })
      isolated.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: this.connection !== connection || !cloudRequestAllowed(connection.origin, details.url) })
      })

      const remote = new WebContentsView({ webPreferences: {
        session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false,
      } })
      this.remote = remote
      remote.setVisible(false)
      remote.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      remote.webContents.on('will-frame-navigate', (event) => {
        if (!cloudRequestAllowed(connection.origin, event.url)) event.preventDefault()
      })
      remote.webContents.on('will-redirect', (event) => {
        if (!cloudRequestAllowed(connection.origin, event.url)) event.preventDefault()
      })
      remote.webContents.on('render-process-gone', () => { this.disconnected(connection) })
      const contents = remote.webContents
      const userAgent = contents.getUserAgent()
      if (!userAgent.split(/\s+/u).includes(CLOUD_DESKTOP_USER_AGENT)) {
        contents.setUserAgent(`${userAgent} ${CLOUD_DESKTOP_USER_AGENT}`.trim())
      }
      contents.on('will-navigate', (event, url) => {
        if (!this.selected || this.connection !== connection || this.remote?.webContents !== contents) return
        const loginUseRequestId = cloudWebsiteLoginUseRequestId(connection.origin, url)
        if (loginUseRequestId !== undefined && this.owner !== undefined) {
          event.preventDefault()
          this.vault.open(this.owner, target, { kind: 'login-use', id: loginUseRequestId })
          return
        }
        const requestId = cloudVaultRequestId(connection.origin, url)
        if (requestId === undefined || this.owner === undefined) return
        event.preventDefault()
        this.vault.open(this.owner, target, { kind: 'request', id: requestId })
      })
      const responseStatus = new Promise<number>((resolve) => {
        contents.once('did-navigate', (_event, _url, status) => { resolve(status) })
      })
      const cancelLoad = (): void => { closeView(remote) }
      pending.signal.addEventListener('abort', cancelLoad, { once: true })
      owner.contentView.addChildView(remote)
      try {
        const status = await Promise.race([responseStatus, contents.loadURL(connection.origin + '/').then(() => 0)])
        if (!this.isPending(pending)) return
        if (status !== 200) throw new Error('Cloud workspace did not load')
      } finally {
        pending.signal.removeEventListener('abort', cancelLoad)
      }
      this.status = 'online'
      this.save(target)
      this.render()
    } catch {
      // Raw SSH and Electron errors can contain the target or sign-in URL.
      if (this.pending === pending) {
        this.resetConnection()
        this.status = 'offline'
        this.render()
      }
    } finally {
      clearTimeout(timer)
      if (this.pending === pending) {
        this.pending = undefined
        if (pending.signal.aborted) {
          this.resetConnection()
          this.status = 'offline'
          this.render()
        }
      }
    }
  }
}
