/** Upload state for a Computer Files tab. */

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { SidebarFilesKey } from './locales.ts'

type FailureKey = Extract<SidebarFilesKey, `upload.error.${string}`>
interface UploadFailure {
  readonly name: string
  readonly key: FailureKey
}

const errorByStatus: Readonly<Partial<Record<number, FailureKey>>> = {
  400: 'upload.error.invalid',
  404: 'upload.error.folder',
  409: 'upload.error.exists',
  413: 'upload.error.large',
  507: 'upload.error.space',
}

async function uploadFile(
  sessionId: string, directory: string, file: File, signal: AbortSignal,
): Promise<FailureKey | 'cancelled' | undefined> {
  const params = new URLSearchParams({ sessionId, directory, name: file.name, bytes: String(file.size) })
  try {
    const response = await fetch(`api/computer/files/upload?${params.toString()}`, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
    return response.status === 201 ? undefined : errorByStatus[response.status] ?? 'upload.error.unavailable'
  } catch (_error) {
    return signal.aborted ? 'cancelled' : 'upload.error.unavailable'
  }
}

/** Computer file picker and transfer state owned by a Files tab body. */
interface ComputerFilePicker {
  readonly input: RefObject<HTMLInputElement>
  readonly pick: (directory: string) => void
  readonly submit: (files: FileList) => Promise<void>
  readonly cancel: () => void
  readonly uploading: string | undefined
  readonly failures: readonly UploadFailure[]
}

/**
 * Keep picker and transfer state tied to the exact active Files body.
 * @param sessionId - owner Bot's Session.
 * @param lifetime - owning tab record's lifetime.
 * @param root - absolute or relative Computer workspace root.
 * @param refresh - refresh the destination Files tree after a successful copy.
 * @returns local state and picker actions.
 */
export function useComputerFilePicker(sessionId: string, lifetime: AbortSignal, root: string, refresh: () => void): ComputerFilePicker {
  const input = useRef<HTMLInputElement>(null)
  const directory = useRef(root)
  const active = useRef<AbortController | undefined>(undefined)
  const [uploading, setUploading] = useState<string>()
  const [failures, setFailures] = useState<readonly UploadFailure[]>([])
  const tabIsClosed = () => lifetime.aborted
  useEffect(() => () => {
    active.current?.abort()
    active.current = undefined
  }, [])
  return {
    input,
    uploading,
    failures,
    pick: (folder) => {
      if (active.current !== undefined || tabIsClosed()) return
      directory.current = folder.startsWith('./') ? folder.slice(2) : folder
      input.current?.click()
    },
    submit: async (selection) => {
      if (active.current !== undefined || tabIsClosed() || selection.length === 0) return
      const files = Array.from(selection)
      const folder = directory.current
      const controller = new AbortController()
      active.current = controller
      const signal = AbortSignal.any([lifetime, controller.signal])
      const errors: UploadFailure[] = []
      let saved = false
      setFailures([])
      try {
        for (const file of files) {
          if (signal.aborted) break
          setUploading(file.name)
          const failure = await uploadFile(sessionId, folder, file, signal)
          if (failure === 'cancelled') break
          if (failure === undefined) saved = true
          else errors.push({ name: file.name, key: failure })
        }
      } finally {
        if (active.current === controller) {
          active.current = undefined
          if (!tabIsClosed()) {
            setUploading(undefined)
            setFailures(errors)
          }
        }
        if (saved && !tabIsClosed()) refresh()
      }
    },
    cancel: () => { active.current?.abort() },
  }
}
