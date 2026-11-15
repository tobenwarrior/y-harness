/** Shell-owned, isolated Vault window for one connected Cloud workspace. */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { cloudVaultRequest, isVaultLoginUseRequestId, isVaultRequestId, vaultRequestAllowed } from './cloud-vault.ts'
import { VAULT_IPC, VAULT_PAGE, type CloudVaultMode } from './cloud-vault-ipc.ts'
import type { DesktopMessages } from './locale.ts'
import { serveWebDocument } from './web-document.ts'

/** Manages the one window allowed to send secrets to a connected VPS. */
export class DesktopCloudVault {
  private window: BrowserWindow | undefined
  private pending: AbortController | undefined
  private mode: CloudVaultMode = { kind: 'manage' }

  /**
   * @param preload - Packaged isolated Vault bridge.
   * @param renderer - Directory containing the bundled Vault document and assets.
   * @param messages - Current desktop strings.
   */
  constructor(private readonly preload: string, private readonly renderer: string,
    private readonly messages: () => DesktopMessages) {}

  /**
   * @param parent - Window holding the connected Cloud workspace.
   * @param target - Verified SSH destination of the current connection.
   * @param mode - Owner-selected presentation; management is the default.
   */
  open(parent: BrowserWindow, target: string, mode: CloudVaultMode = { kind: 'manage' }): void {
    if (parent.isDestroyed() || !parent.isVisible()) return
    if (mode.kind === 'request' && !isVaultRequestId(mode.id)) return
    if (mode.kind === 'login-use' && !isVaultLoginUseRequestId(mode.id)) return
    if (this.window !== undefined) {
      const sameMode = (this.mode.kind === 'manage' && mode.kind === 'manage')
        || (this.mode.kind === 'request' && mode.kind === 'request' && this.mode.id === mode.id)
        || (this.mode.kind === 'login-use' && mode.kind === 'login-use' && this.mode.id === mode.id)
      if (sameMode) {
        this.window.focus()
        return
      }
      this.close()
    }
    this.mode = mode
    const messages = this.messages()
    const window = new BrowserWindow({
      parent, modal: true, show: false, width: 550, height: mode.kind === 'manage' ? 565 : mode.kind === 'request' ? 370 : 430, minWidth: 400, minHeight: 345,
      resizable: true, minimizable: false, maximizable: false,
      title: mode.kind === 'manage' ? messages.cloudVault
        : mode.kind === 'request' ? messages.cloudVaultRequestTitle : messages.cloudVaultLoginUseTitle,
      webPreferences: {
        partition: `cloud-vault-${randomUUID()}`, preload: this.preload, contextIsolation: true,
        sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false,
      },
    })
    this.window = window
    const contents = window.webContents
    const vaultSession = contents.session
    const assets = [VAULT_PAGE, 'dsh-app://shell/cloud-vault.js', 'dsh-app://shell/cloud-vault.css']
    vaultSession.protocol.handle('dsh-app', request =>
      assets.includes(request.url) ? serveWebDocument(request, this.renderer) : new Response(null, { status: 404 }))
    vaultSession.setPermissionCheckHandler(() => false)
    vaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    vaultSession.webRequest.onBeforeRequest((details, callback) => { callback({ cancel: !assets.includes(details.url) }) })
    vaultSession.on('will-download', (event) => { event.preventDefault() })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', (event) => { event.preventDefault() })
    contents.on('will-redirect', (event) => { event.preventDefault() })
    contents.on('render-process-gone', () => { this.close() })
    window.setMenu(null)
    const owned = (event: IpcMainInvokeEvent): void => {
      if (this.window !== window || event.sender !== contents
        || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== VAULT_PAGE) {
        throw new Error('Vault window is unavailable')
      }
    }
    contents.ipc.handle(VAULT_IPC.messages, (event) => { owned(event); return this.messages() })
    contents.ipc.handle(VAULT_IPC.mode, (event) => { owned(event); return this.mode })
    contents.ipc.handle(VAULT_IPC.request, async (event, request: unknown) => {
      owned(event)
      if (!vaultRequestAllowed(request, mode)) return { ok: false, reason: 'invalid' }
      if (this.pending !== undefined) return { ok: false, reason: 'unavailable' }
      const pending = new AbortController()
      this.pending = pending
      try { return await cloudVaultRequest(target, request, pending.signal) }
      finally { if (this.pending === pending) this.pending = undefined }
    })
    contents.ipc.handle(VAULT_IPC.close, (event) => { owned(event); window.close() })
    const parentHidden = (): void => { this.close() }
    parent.on('hide', parentHidden)
    window.once('closed', () => {
      parent.off('hide', parentHidden)
      vaultSession.protocol.unhandle('dsh-app')
      if (this.window !== window) return
      this.window = undefined
      this.mode = { kind: 'manage' }
      this.pending?.abort()
      this.pending = undefined
    })
    window.once('ready-to-show', () => { if (this.window === window) window.show() })
    void window.loadURL(VAULT_PAGE).catch(() => { if (this.window === window) this.close() })
  }

  /** Dismiss the Vault and cancel an in-flight connection. */
  close(): void {
    const window = this.window
    this.window = undefined
    this.mode = { kind: 'manage' }
    this.pending?.abort()
    this.pending = undefined
    window?.destroy()
  }
}
