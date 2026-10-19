import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MAX_DOCK_COLUMNS, MAX_DOCK_ROWS, SessionDockStore } from '../src/client/dock/store.ts'

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => id as SessionId)

/** A store whose candidates are the given Sessions, in order. */
function storeWith(candidates: readonly SessionId[]): SessionDockStore {
  const store = new SessionDockStore()
  store.seedFrom(() => candidates)
  return store
}

describe('docked Session panes', () => {
  it('starts as the single ambient pane the client already shows', () => {
    const store = storeWith(ids)
    expect(store.observable.getSnapshot()).toEqual({ panes: [{ sessionId: null }], columns: 1, rows: 1 })
    expect(store.canSplit()).toBe(true)
  })

  it('seeds each new pane with a Session that is not docked yet', () => {
    const store = storeWith(ids)
    store.split('right')
    store.split('right')
    expect(store.observable.getSnapshot().panes).toEqual([
      { sessionId: null }, { sessionId: 'a' }, { sessionId: 'b' },
    ])
  })

  it('grows to three columns and two rows and then stops', () => {
    const store = storeWith(ids)
    expect(store.split('right')).toBe(true)
    expect(store.split('right')).toBe(true)
    expect(store.split('right')).toBe(false)
    expect(store.observable.getSnapshot()).toMatchObject({ columns: MAX_DOCK_COLUMNS, rows: 1 })
    expect(store.split('down')).toBe(true)
    expect(store.split('down')).toBe(false)
    expect(store.observable.getSnapshot()).toMatchObject({ columns: MAX_DOCK_COLUMNS, rows: MAX_DOCK_ROWS })
    expect(store.canSplit()).toBe(false)
  })

  it('refuses a split when every candidate is docked already', () => {
    const store = storeWith([ids[0] as SessionId])
    expect(store.split('right')).toBe(true)
    expect(store.split('down')).toBe(false)
  })

  it('drops the last pane and shrinks the grid with it', () => {
    const store = storeWith(ids)
    store.split('right')
    store.split('down')
    expect(store.closeLast()).toBe(true)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: null }, { sessionId: 'a' }], columns: 2, rows: 1,
    })
    expect(store.closeLast()).toBe(true)
    expect(store.closeLast()).toBe(false)
    expect(store.observable.getSnapshot().panes).toEqual([{ sessionId: null }])
  })

  it('points one pane at another Session without disturbing its neighbours', () => {
    const store = storeWith(ids)
    store.split('right')
    store.show(1, ids[5] as SessionId)
    expect(store.observable.getSnapshot().panes).toEqual([{ sessionId: null }, { sessionId: 'f' }])
    store.show(0, ids[3] as SessionId)
    expect(store.observable.getSnapshot().panes).toEqual([{ sessionId: 'd' }, { sessionId: 'f' }])
    store.show(9, ids[1] as SessionId)
    expect(store.observable.getSnapshot().panes).toHaveLength(2)
  })
})
