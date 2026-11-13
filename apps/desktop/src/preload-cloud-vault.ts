/** Write-only preload for the shell-owned Vault document. */
import { contextBridge, ipcRenderer } from 'electron'
import { VAULT_IPC, VAULT_PAGE, type CloudVaultApi } from './cloud-vault-ipc.ts'

const api: CloudVaultApi = {
  messages: () => ipcRenderer.invoke(VAULT_IPC.messages) as ReturnType<CloudVaultApi['messages']>,
  request: request => ipcRenderer.invoke(VAULT_IPC.request, request) as ReturnType<CloudVaultApi['request']>,
  close: () => ipcRenderer.invoke(VAULT_IPC.close) as Promise<void>,
}
if (location.href === VAULT_PAGE) contextBridge.exposeInMainWorld('yhCloudVault', api)
