import { describe, expect, it } from 'vitest'
import type { SessionId } from '@yharness/session/types'
import { SessionDockStore } from '../src/client/dock/store.ts'

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => id as SessionId)

/** A store with `count` Sessions right-dropped beside the ambient pane. */
function storeWith(count: number): SessionDockStore {
  const store = new SessionDockStore()
  for (let position = 0; position < count; position += 1) {
    expect(store.dropSession(ids[position] as SessionId, 'right')).toBe(true)
  }
  return store
}

describe('docked Session panes', () => {
  it('starts as the single ambient pane the client already shows', () => {
    const store = new SessionDockStore()
    expect(store.observable.getSnapshot()).toEqual({ panes: [{ sessionId: null }], columns: 1, rows: 1 })
  })

  it('closes the pane at its own index and shrinks the grid with it', () => {
    const store = storeWith(2)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: null }, { sessionId: 'a' }, { sessionId: 'b' }], columns: 3, rows: 1,
    })
    expect(store.closePane(1)).toBe(true)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: null }, { sessionId: 'b' }], columns: 2, rows: 1,
    })
    expect(store.closePane(0)).toBe(true)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: 'b' }], columns: 1, rows: 1,
    })
  })

  it('shrinks rows when the reversed growth added one', () => {
    const store = storeWith(1)
    expect(store.dropSession(ids[2] as SessionId, 'bottom')).toBe(true)
    expect(store.observable.getSnapshot()).toMatchObject({ columns: 2, rows: 2 })
    expect(store.closePane(0)).toBe(true)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: 'a' }, { sessionId: 'c' }], columns: 2, rows: 1,
    })
  })

  it('refuses an unknown index without disturbing the grid', () => {
    const store = storeWith(1)
    expect(store.closePane(9)).toBe(false)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: null }, { sessionId: 'a' }], columns: 2, rows: 1,
    })
    expect(store.closePane(1)).toBe(true)
  })

  it('refuses to close the last remaining pane', () => {
    const store = new SessionDockStore()
    expect(store.closePane(0)).toBe(false)
    expect(store.observable.getSnapshot().panes).toEqual([{ sessionId: null }])
  })

  it('places a Session dragged in on the right after the docked panes', () => {
    const store = new SessionDockStore()
    expect(store.dropSession(ids[2] as SessionId, 'right')).toBe(true)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: null }, { sessionId: 'c' }], columns: 2, rows: 1,
    })
  })

  it('places a Session dropped on the left or top first in reading order', () => {
    const left = new SessionDockStore()
    expect(left.dropSession(ids[0] as SessionId, 'right')).toBe(true)
    expect(left.dropSession(ids[4] as SessionId, 'left')).toBe(true)
    expect(left.observable.getSnapshot().panes).toEqual([
      { sessionId: 'e' }, { sessionId: null }, { sessionId: 'a' },
    ])
    const top = new SessionDockStore()
    expect(top.dropSession(ids[4] as SessionId, 'top')).toBe(true)
    expect(top.observable.getSnapshot()).toMatchObject({ columns: 1, rows: 2 })
    expect(top.observable.getSnapshot().panes[0]).toEqual({ sessionId: 'e' })
  })

  it('refuses a drop that the grid cannot hold', () => {
    const store = new SessionDockStore()
    expect(store.dropSession(ids[0] as SessionId, 'right')).toBe(true)
    expect(store.dropSession(ids[1] as SessionId, 'right')).toBe(true)
    expect(store.dropSession(ids[5] as SessionId, 'right')).toBe(false)
    expect(store.dropSession(ids[5] as SessionId, 'bottom')).toBe(true)
  })

  it('refuses a Session that is already on screen', () => {
    const store = storeWith(1)
    expect(store.dropSession(ids[0] as SessionId, 'bottom')).toBe(false)
    expect(store.observable.getSnapshot()).toEqual({
      panes: [{ sessionId: null }, { sessionId: 'a' }], columns: 2, rows: 1,
    })
    expect(store.dropSession(ids[1] as SessionId, 'bottom')).toBe(true)
    expect(store.observable.getSnapshot()).toMatchObject({ columns: 2, rows: 2 })
  })
})
