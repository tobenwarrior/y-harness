import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveEditRevisionError, LiveEditStore, validateLiveEditPatch } from '../src/live-edit.ts'

const firstPatch = {
  title: 'Add a workspace action',
  operations: [{
    kind: 'add', target: 'sidebar-panel-plugins', id: 'workspace-action', position: 'end',
    title: 'Workspace', text: 'Open the workspace',
  }],
} as const

const secondPatch = {
  title: 'Hide the session dock',
  operations: [{ kind: 'hide', target: 'session-dock' }],
} as const

const stylePatch = {
  title: 'Tune the header',
  operations: [{ kind: 'style', target: 'conversation-header', color: '#112233', radius: 12 }],
} as const

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function profileFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yh-live-edit-'))
  temporaryDirectories.push(directory)
  return join(directory, 'profile', 'live-ui.json')
}

describe('Live Edit validation', () => {
  it('accepts bounded data-yh-part operations and keeps only literal text/style values', () => {
    expect(validateLiveEditPatch(firstPatch)).toEqual(firstPatch)
    expect(validateLiveEditPatch(stylePatch)).toEqual(stylePatch)
  })

  it.each([
    [{ title: 'bad', operations: [{ kind: 'hide', target: 'frame' }] }, 'protected target'],
    [{ title: 'bad', operations: [{ kind: 'hide', target: 'button#save' }] }, 'data-yh-part token'],
    [{ title: 'bad', operations: [{ kind: 'add', target: 'sidebar-panel-plugins', id: 'x', position: 'end', title: '<b>bad</b>' }] }, 'plain text'],
    [{ title: 'bad', operations: [{ kind: 'style', target: 'conversation-header', color: 'red;display:none' }] }, 'hex color'],
  ])('rejects unsafe patch %j', (patch, message) => {
    expect(() => validateLiveEditPatch(patch)).toThrow(message)
  })
})

describe('Live Edit state transitions', () => {
  it('stages a preview, keeps it, drops a new preview, then reverts the last Keep', async () => {
    const events: number[] = []
    const store = new LiveEditStore(undefined, () => { events.push(1) })
    const preview = await store.stage(firstPatch)
    expect(preview).toMatchObject({ preview: firstPatch, canUndo: true })

    const kept = await store.apply('keep', preview.revision)
    expect(kept).toEqual({ revision: expect.any(String), kept: firstPatch, canUndo: true })
    const cleared = await store.apply('undo', kept.revision)
    expect(cleared).toMatchObject({ canUndo: false })

    const secondPreview = await store.stage(firstPatch)
    expect(secondPreview).toMatchObject({ preview: firstPatch, canUndo: true })
    const firstKeptAgain = await store.apply('keep', secondPreview.revision)
    expect(firstKeptAgain).toMatchObject({ kept: firstPatch, canUndo: true })

    const thirdPreview = await store.stage(stylePatch)
    const secondKept = await store.apply('keep', thirdPreview.revision)
    expect(secondKept).toMatchObject({ kept: stylePatch, canUndo: true })
    const reverted = await store.apply('undo', secondKept.revision)
    expect(reverted).toMatchObject({ kept: firstPatch, canUndo: false })
    expect(events).toHaveLength(8)
  })

  it('rejects stale revisions', async () => {
    const store = new LiveEditStore()
    const first = await store.stage(firstPatch)
    await store.stage(secondPatch)
    await expect(store.apply('keep', first.revision)).rejects.toBeInstanceOf(LiveEditRevisionError)
    expect(store.state()).toMatchObject({ preview: secondPatch, canUndo: true })
  })
})

describe('Live Edit persistence', () => {
  it('saves the displayed preview before staging a concurrent edit', async () => {
    const file = await profileFile()
    const store = new LiveEditStore(file)
    const preview = await store.stage(firstPatch)
    const keep = store.apply('keep', preview.revision)
    const update = store.stage(stylePatch)

    await expect(keep).resolves.toMatchObject({ kept: firstPatch })
    await expect(update).resolves.toMatchObject({ kept: firstPatch, preview: stylePatch })
    expect(new LiveEditStore(file).state()).toEqual({ revision: expect.any(String), kept: firstPatch, canUndo: true })
  })

  it('persists kept and previous patches, restores them on reopen, and writes a private file', async () => {
    const file = await profileFile()
    const first = new LiveEditStore(file)
    const firstPreview = await first.stage(firstPatch)
    await first.apply('keep', firstPreview.revision)
    const secondPreview = await first.stage(secondPatch)
    await first.apply('keep', secondPreview.revision)

    const reopened = new LiveEditStore(file)
    expect(reopened.state()).toMatchObject({ kept: secondPatch, canUndo: true })
    const undone = await reopened.apply('undo', reopened.state().revision)
    expect(undone).toMatchObject({ kept: firstPatch, canUndo: false })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, record: { kept: firstPatch, undoAvailable: false } })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})
