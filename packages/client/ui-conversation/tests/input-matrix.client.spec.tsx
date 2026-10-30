// @vitest-environment jsdom
/**
 * Impact-matrix projection tests (row by row): what each
 * phase projects onto the InputBar — enter routing, visuals (token color /
 * hint / pending), edit freedom, and the published currency's claim seat.
 * React over jsdom per the client testing discipline; the machine is real.
 */
import './control-row-dom.ts'
import type { GlobalStandardProps } from '@yharness/client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { Context } from '@yharness/cordis'
import type { SessionSnapshot } from '@yharness/api-session-controller/client'
import { createSnapshotStore } from '@yharness/client-store'
import {
  bindSnapshotSelector, conversationSnapshot, sessionSnapshot,
} from '@yharness/client-test-runtime'
import type { SessionStatusSnapshot } from '@yharness/client-ui-session/client'
import type { SessionId } from '@yharness/session/types'
import type { SubmitAttachment, SubmitOutcome } from '../src/client/contract/input.ts'
import { makeTranslate } from '@yharness/client-test-runtime'
import { en as commonEn } from '@yharness/client-locale/src/locales/en.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import { en } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

// jsdom implements no Range geometry (Lexical's scroll-into-view measures the
// caret with one once the surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})


afterEach(cleanup)

const SCTX = {} as Context
const SID = 's1' as SessionId

/** Standard-props InputBar mount over a real shell (the composer-bar entry shape). */
function mountBar(shell: SessionInputShell, over?: { running?: boolean; disabled?: boolean }) {
  const session = createSnapshotStore<SessionSnapshot>({
    ...sessionSnapshot(SID),
    running: over?.running ?? false,
    removed: over?.disabled ?? false,
  })
  const props: InputBarProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    sessionId: SID,
    SessionProvider: ({ children }) => children,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      projectionsBySession: {}, currentAddress: undefined,
    })),
    useSessionStatus: bindSnapshotSelector(
      createSnapshotStore<SessionStatusSnapshot>(new Map()),
    ),
    useSessionRetainInfo: () => undefined,
    useResource,
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
    useProjection: (() => undefined),
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationSnapshot())),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addFiles: () => null,
    useFileUploads: bindSnapshotSelector(createSnapshotStore({})),
    retryFileUpload: undefined,
    removeAttachment: () => {},
    // Every id resolves so the bar's registry prune never drops a test image.
    resolveDraftAttachments: ids => ids.map(id => ({
      kind: 'image' as const, id,
      file: new File([Uint8Array.of(1)], `${id}.png`, { type: 'image/png' }),
      previewUrl: `blob:${id}`,
    })),
    toggleCommandMenu: vi.fn(),
    useBusyEnter: bindSnapshotSelector(createSnapshotStore<'queue' | 'steer'>('queue')),
    useStopShortcut: bindSnapshotSelector(createSnapshotStore<readonly string[]>([])),
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(createSnapshotStore<string | null>(null)),
    renderSlot: (() => null) as InputBarProps['renderSlot'],
    stop: vi.fn(),
    t: makeTranslate(en, commonEn),
    variant: 'composer',
  }
  return render(<InputBar {...props} />)
}

function bench(over?: {
  running?: boolean
  disabled?: boolean
  submit?: (args: string) => Promise<SubmitOutcome>
  serialize?: (ids: readonly DraftAttachmentId[]) => Promise<readonly SubmitAttachment[]>
}) {
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const serialize = vi.fn(over?.serialize ?? (() => Promise.resolve<readonly SubmitAttachment[]>([])))
  const release = vi.fn()
  const shell = new SessionInputShell({ actx: SCTX, defaultSink: sink, commandAttachments: { serialize, release, unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported` } })
  const wiring = shell
  const view = mountBar(shell, over)
  const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
  const claim = (token = '/goal ', hint = '\u{76EE}\u{6807}', attachments?: true) => {
    act(() => {
      shell.setDraft(token)
      shell.beginCommand(
        {
          name: token.slice(1).trim(), token, hint,
          ...(attachments === true ? { attachments: true } : {}),
          submit: over?.submit ?? (() => Promise.resolve({ kind: 'success' as const, source: 'command', name: 'goal' })),
        },
        { start: 0, end: token.length, draftRev: shell.snapshot.draftRev },
      )
    })
  }
  return { view, textarea, shell, wiring, sink, claim, serialize, release }
}

describe('matrix row: plain', () => {
  it('unsubscribes from the Inbox projection when disposed', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const shell = new SessionInputShell({
      actx: SCTX,
      defaultSink: () => Promise.resolve({ kind: 'success' }),
      inbox: { getSnapshot: () => undefined, subscribe },
      commandAttachments: {
        serialize: () => Promise.resolve([]),
        release: () => {},
        unsupportedNotice: token => `${token.trim()} attachments-unsupported`,
      },
    })

    expect(subscribe).toHaveBeenCalledOnce()
    shell.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('enter falls to the default sink; no claim on the currency; edits free', async () => {
    const { textarea, shell, sink } = bench()
    act(() => { shell.setDraft('\u{666E}\u{901A}\u{6D88}\u{606F}') })
    expect(shell.snapshot.claim).toBeUndefined()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('\u{666E}\u{901A}\u{6D88}\u{606F}', [], 'queue', expect.any(AbortSignal))
    // The detached default send never freezes the composer.
    expect(shell.snapshot.phase).toBe('plain')
    expect(shell.snapshot.draft).toBe('')
    expect(shell.snapshot.claim).toBeUndefined()
  })
})

describe('matrix row: claimed', () => {
  it('publishes the claim currency, colors the token, hints while args are blank, and edits stay free', () => {
    const { view, textarea, shell, claim } = bench()
    claim()
    act(() => { shell.editor.update(() => {}, { discrete: true }) }) // flush the queued decoration refresh
    expect(shell.snapshot.claim).toEqual({ name: 'goal', token: '/goal ', hint: '\u{76EE}\u{6807}' })
    expect(view.container.querySelector('[data-lexical-text][style*="business-primary"]')?.textContent).toBe('/goal ')
    // The conversation dictionary owns a hint.goal entry, which overrides the raw claim hint (production behavior).
    expect(textarea.style.getPropertyValue('--dsh-composer-hint')).toBe(JSON.stringify('describe the objective for a long-running task'))
    expect(textarea.getAttribute('contenteditable')).toBe('true')
    // Free editing beyond the token: hint drops, claim holds.
    act(() => { shell.setDraft('/goal \u{53D1}\u{5E03}\u{7248}\u{672C}') })
    expect(shell.snapshot.phase).toBe('claimed')
    expect(textarea.style.getPropertyValue('--dsh-composer-hint')).toBe('')
  })

  it('enter routes to claim.submit (command lane, never the queue sink)', async () => {
    const submit = vi.fn(() => Promise.resolve({ kind: 'success' as const, text: '\u{5B8C}\u{6210}', source: 'command', name: 'goal' }))
    const { view, textarea, shell, sink, claim } = bench({ submit })
    claim()
    act(() => { shell.setDraft('/goal \u{53D1}\u{5E03}') })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledWith('\u{53D1}\u{5E03}', SCTX, []) })
    // Commit: draft cleared, notice surfaced, back to plain.
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('') })
    expect(view.getByText('\u{5B8C}\u{6210}')).toBeTruthy()
  })

  it('backspacing the token auto-releases to plain and the visuals vanish (scenario H)', () => {
    const { view, shell, claim } = bench()
    claim()
    act(() => { shell.setDraft('/goa \u{53D1}\u{5E03}') }) // token broken
    expect(shell.snapshot.phase).toBe('plain')
    expect(shell.snapshot.claim).toBeUndefined()
    act(() => { shell.editor.update(() => {}, { discrete: true }) }) // flush the queued decoration refresh
    expect(view.container.querySelector('[data-lexical-text][style*="business-primary"]')).toBeNull()
  })
})

describe('matrix row: claimed with attachments', () => {
  const img = 'img-1' as DraftAttachmentId

  it('a claim without attachment acceptance blocks enter: one notice and the full draft retained', async () => {
    const submit = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    const { view, textarea, shell, sink, claim } = bench({ submit })
    claim()
    act(() => { shell.addAttachments([img]) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await Promise.resolve()
    expect(shell.snapshot.phase).toBe('claimed')
    expect(submit).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
    expect(view.getByText('/goal attachments-unsupported')).toBeTruthy()
    expect(shell.snapshot.attachmentIds).toEqual([img])
    expect(shell.snapshot.draft).toBe('/goal ')
  })

  it('an accepting claim serializes and forwards a mixed batch; success consumes and clears', async () => {
    const submit = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    const png: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: 'AA==' }
    const file: SubmitAttachment = { type: 'file', receiptId: 'receipt-x' }
    const { textarea, shell, claim, serialize, release } = bench({ submit, serialize: () => Promise.resolve([png, file]) })
    claim('/goal ', '\u{76EE}\u{6807}', true)
    // The claim currency carries the acceptance flag the pre-gate reads.
    expect(shell.snapshot.claim).toEqual({ name: 'goal', token: '/goal ', hint: '\u{76EE}\u{6807}', attachments: true })
    act(() => { shell.addAttachments([img]) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledWith('', SCTX, [png, file]) })
    expect(serialize).toHaveBeenCalledWith([img])
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('') })
    expect(release).toHaveBeenCalledWith([img])
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(shell.snapshot.phase).toBe('plain')
  })

  it('a handler error keeps a serialized file unreleased beside the notice and draft', async () => {
    const submit = vi.fn(() => Promise.resolve({ kind: 'error' as const, text: '\u{5904}\u{7406}\u{5931}\u{8D25}' }))
    const file: SubmitAttachment = { type: 'file', receiptId: 'receipt-x' }
    const { view, textarea, shell, claim, release } = bench({ submit, serialize: () => Promise.resolve([file]) })
    claim('/goal ', '\u{76EE}\u{6807}', true)
    act(() => { shell.addAttachments([img]) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(view.getByText('\u{5904}\u{7406}\u{5931}\u{8D25}')).toBeTruthy() })
    expect(shell.snapshot.phase).toBe('claimed')
    expect(shell.snapshot.attachmentIds).toEqual([img])
    expect(release).not.toHaveBeenCalled()
    expect(shell.snapshot.draft).toBe('/goal ')
  })

  it('a serialize rejection blocks the transaction: notice, no submit call, images kept', async () => {
    const submit = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    const { view, textarea, shell, claim, release } = bench({ submit, serialize: () => Promise.reject(new Error('\u{9644}\u{4EF6}\u{5DF2}\u{5931}\u{6548}')) })
    claim('/goal ', '\u{76EE}\u{6807}', true)
    act(() => { shell.addAttachments([img]) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(view.getByText('\u{9644}\u{4EF6}\u{5DF2}\u{5931}\u{6548}')).toBeTruthy() })
    expect(submit).not.toHaveBeenCalled()
    expect(shell.snapshot.attachmentIds).toEqual([img])
    expect(release).not.toHaveBeenCalled()
    expect(shell.snapshot.phase).toBe('claimed')
  })

  it('a disposed shell never lets a pending serialization reach claim.submit', async () => {
    const submit = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    let resolveSerialize!: (images: readonly SubmitAttachment[]) => void
    const { shell, textarea, claim } = bench({
      submit,
      serialize: () => new Promise((resolve) => { resolveSerialize = resolve }),
    })
    claim('/goal ', '\u{76EE}\u{6807}', true)
    act(() => { shell.addAttachments([img]) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(resolveSerialize).toBeDefined() })
    shell.dispose()
    resolveSerialize([{ type: 'image', mediaType: 'image/png', data: 'AA==' }])
    await Promise.resolve()
    await Promise.resolve()
    expect(submit).not.toHaveBeenCalled()
  })

  it('image removal is refused while a command submit is in flight', async () => {
    const submit = vi.fn(() => new Promise<SubmitOutcome>(() => {})) // never settles
    const { shell, textarea, claim } = bench({ submit, serialize: () => Promise.resolve([]) })
    claim('/goal ', '\u{76EE}\u{6807}', true)
    act(() => { shell.addAttachments([img]) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(shell.snapshot.phase).toBe('submitting')
    const draft = shell.snapshot.draft
    expect(shell.addFiles([{
      source: 'reference', ref: '@note.txt', label: 'note.txt', clipboardText: '@note.txt',
    }], ['new-file' as DraftAttachmentId])).toBe(false)
    expect(shell.snapshot.draft).toBe(draft)
    let removed = true
    act(() => { removed = shell.removeAttachment(img) })
    expect(removed).toBe(false)
    expect(shell.snapshot.attachmentIds).toEqual([img])
  })
})

describe('matrix row: submitting', () => {
  it('locks enter, renders pending + read-only, keeps the claim snapshot on the currency', async () => {
    const submit = vi.fn(() => new Promise<SubmitOutcome>(() => {})) // never settles
    const { textarea, shell, sink, claim } = bench({ submit })
    claim()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(shell.snapshot.phase).toBe('submitting')
    expect(shell.snapshot.claim).toBeDefined()
    expect(textarea.getAttribute('contenteditable')).toBe('false')
    // Enter is dead inside the lock (submit dispatch is microtask-deferred).
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledTimes(1) })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await Promise.resolve()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(sink).not.toHaveBeenCalled()
  })

  it('rollback with unchanged draft returns to claimed with the notice; drifted draft only notices', async () => {
    let rejectSubmit!: (e: Error) => void
    const submit = vi.fn(() => new Promise<SubmitOutcome>((_res, rej) => { rejectSubmit = rej }))
    const first = bench({ submit })
    first.claim()
    fireEvent.keyDown(first.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(submit).toHaveBeenCalled() })
    act(() => { rejectSubmit(new Error('\u{6267}\u{884C}\u{5931}\u{8D25}')) })
    await vi.waitFor(() => { expect(first.shell.snapshot.phase).toBe('claimed') })
    expect(first.shell.snapshot.draft).toBe('/goal ')
    expect(first.view.getByText('\u{6267}\u{884C}\u{5931}\u{8D25}')).toBeTruthy()
    cleanup()
    // Drift: typing during flight wins; no restore, plain, notice only.
    const submit2 = vi.fn(() => new Promise<SubmitOutcome>((_res, rej) => { rejectSubmit = rej }))
    const second = bench({ submit: submit2 })
    second.claim()
    fireEvent.keyDown(second.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(submit2).toHaveBeenCalled() })
    act(() => { second.shell.setDraft('\u{7528}\u{6237}\u{98DE}\u{884C}\u{4E2D}\u{6253}\u{7684}\u{65B0}\u{7A3F}') })
    act(() => { rejectSubmit(new Error('\u{665A}\u{5230}\u{5931}\u{8D25}')) })
    await vi.waitFor(() => { expect(second.shell.snapshot.phase).toBe('plain') })
    expect(second.shell.snapshot.draft).toBe('\u{7528}\u{6237}\u{98DE}\u{884C}\u{4E2D}\u{6253}\u{7684}\u{65B0}\u{7A3F}')
    expect(second.view.getByText('\u{665A}\u{5230}\u{5931}\u{8D25}')).toBeTruthy()
  })
})

describe('matrix row: locked (session disabled)', () => {
  it('disables the textarea and chrome; the machine currency is untouched', () => {
    const { view, textarea, shell } = bench({ disabled: true })
    expect(textarea.getAttribute('aria-disabled')).toBe('true')
    expect((view.getByLabelText('Add files or run commands') as HTMLButtonElement).disabled).toBe(true)
    expect(shell.snapshot.phase).toBe('plain')
  })

  it('running does NOT lock: typing and enter-queue stay live', () => {
    const { textarea, shell, sink } = bench({ running: true })
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    act(() => { shell.setDraft('\u{6392}\u{961F}') })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('\u{6392}\u{961F}', [], 'queue', expect.any(AbortSignal))
  })
})

describe('matrix row: takeover (orthogonal axis)', () => {
  it('the machine state survives outside the render tree (claim lives on the shell, not the DOM)', () => {
    const { view, shell, claim } = bench()
    claim()
    // Takeover hides the composer (overlay chain keeps it mounted-but-hidden);
    // even a full unmount keeps the claim: state lives on the resident shell.
    view.unmount()
    expect(shell.snapshot.phase).toBe('claimed')
    expect(shell.snapshot.claim?.token).toBe('/goal ')
    expect(shell.snapshot.draft).toBe('/goal ')
  })
})
