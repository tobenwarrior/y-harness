/** Private IPC shared by the desktop Vault window and its isolated preload. */
import type { VaultReply, VaultRequest } from './cloud-vault.ts'
import type { DesktopMessages } from './locale.ts'

/** Exact shell document allowed to manage a Vault. */
export const VAULT_PAGE = 'dsh-app://shell/cloud-vault.html'

/** Channels scoped to the web contents that owns the Vault window. */
export const VAULT_IPC = {
  messages: 'dsh-cloud-vault:messages',
  request: 'dsh-cloud-vault:request',
  close: 'dsh-cloud-vault:close',
} as const

/** Operations available only to the desktop-owned Vault document. */
export interface CloudVaultApi {
  messages(): Promise<DesktopMessages>
  request(request: VaultRequest): Promise<VaultReply>
  close(): Promise<void>
}
