/** Private IPC shared by the desktop Vault window and its isolated preload. */
import type { VaultReply, VaultRequest, VaultRequestMode } from './cloud-vault.ts'
import type { VaultLoginImportReply } from './cloud-vault-import.ts'
import type { DesktopMessages } from './locale.ts'

/** Exact shell document allowed to manage a Vault. */
export const VAULT_PAGE = 'dsh-app://shell/cloud-vault.html'

/** Channels scoped to the web contents that owns the Vault window. */
export const VAULT_IPC = {
  messages: 'dsh-cloud-vault:messages',
  mode: 'dsh-cloud-vault:mode',
  request: 'dsh-cloud-vault:request',
  importLogins: 'dsh-cloud-vault:import-logins',
  close: 'dsh-cloud-vault:close',
} as const

/** Presentation selected by the desktop-owned opener, never by Cloud content. */
export type CloudVaultMode = VaultRequestMode

/** Operations available only to the desktop-owned Vault document. */
export interface CloudVaultApi {
  messages(): Promise<DesktopMessages>
  mode(): Promise<CloudVaultMode>
  request(request: VaultRequest): Promise<VaultReply>
  importLogins(action: 'choose' | 'confirm' | 'cancel', id?: string): Promise<VaultLoginImportReply>
  close(): Promise<void>
}
