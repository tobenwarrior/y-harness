import { describe, expect, it, vi } from 'vitest'
import type { SkillLibraryItem, SkillLibraryId, SkillLibraryList } from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLibraryFace } from '../src/client/controller.ts'
import { createSkillConfirmationHandler, createSkillSelectionHandler } from '../src/client/skill-panel-actions.ts'

const item: SkillLibraryItem = { id: 'source' as SkillLibraryId, name: 'Release', description: '', provider: 'fixture', source: 'project', path: '/fixture/SKILL.md', scope: 'project', projectIds: ['project'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'observed-hash', bodyBytes: 42, usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }
const inventory: SkillLibraryList = { items: [item], projects: [], providers: [], bodyBudgetBytes: 1000 }

describe('skill panel render snapshot callbacks', () => {
  it('does not request an action or close when there is no displayed confirmation', () => {
    const act = vi.fn<SkillLibraryFace['act']>(), close = vi.fn()
    createSkillConfirmationHandler(null, item, act, close)()
    expect(act).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })
  it.each(['adopt', 'archive'] as const)('requests the displayed %s source before closing its confirmation', (action) => {
    const order: string[] = []
    const act = vi.fn<SkillLibraryFace['act']>(() => { order.push('request') })
    const close = () => { order.push('close') }
    createSkillConfirmationHandler(action, item, act, close)()
    expect(act).toHaveBeenCalledWith(action, item); expect(order).toEqual(['request', 'close'])
  })
  it('retains an open confirmation when the operation callback throws', () => {
    const act = () => { throw new Error('Unavailable operation') }, close = vi.fn()
    expect(createSkillConfirmationHandler('archive', item, act, close)).toThrow('Unavailable operation')
    expect(close).not.toHaveBeenCalled()
  })
  it('captures the displayed source instead of borrowing a later selection', () => {
    const act = vi.fn<SkillLibraryFace['act']>(), close = vi.fn()
    const confirm = createSkillConfirmationHandler('archive', item, act, close)
    createSkillConfirmationHandler('adopt', { ...item, id: 'new-selection' as SkillLibraryId }, act, close)
    confirm(); expect(act).toHaveBeenCalledWith('archive', item)
  })
  it.each([null, inventory])('ignores unknown identities in the current inventory %j', (current) => {
    const select = vi.fn<(item: SkillLibraryItem) => void>()
    createSkillSelectionHandler(current, select)('missing' as SkillLibraryId)
    expect(select).not.toHaveBeenCalled()
  })
  it('selects the exact observed item and keeps its inventory snapshot after navigation', () => {
    const select = vi.fn<(item: SkillLibraryItem) => void>()
    const choose = createSkillSelectionHandler(inventory, select)
    createSkillSelectionHandler({ ...inventory, items: [] }, select)
    choose(item.id); expect(select).toHaveBeenCalledWith(item)
  })
})
