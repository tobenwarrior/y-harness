// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { StyleRow, type StyleRowComponentProps } from '../src/client/StyleRow.tsx'
import { createStyleRowStore } from '../src/client/settings-store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ThemeStyle } from '../src/theme-settings.ts'

afterEach(cleanup)

const unusedHook = (() => { throw new Error('unused by style row') }) as never
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
type AttentionSnapshot = Parameters<Parameters<StyleRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: StyleRowComponentProps['useSessionStatus'] = selector => selector(noAttention)
const kit = {
  useSessions: unusedHook,
  useSessionStatus,
  usePanelInfo, useSessionRetainInfo: () => undefined, useResource, useWorkspaces: unusedHook,
}

function mount(style: ThemeStyle = 'default', dictionary: Record<string, string> = en) {
  const store = createStyleRowStore().create()
  store.actions.sync(style, 0)
  const setStyle = vi.fn()
  const t: StyleRowComponentProps['t'] = key => dictionary[key] ?? key
  const view = render(<StyleRow {...kit} t={t} useStore={bindSnapshotSelector(store)} actions={store.actions} setStyle={setStyle} />)
  return { store, setStyle, view }
}

function choice(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

describe('StyleRow', () => {
  it('exposes the persisted style through named, mutually exclusive choice buttons', () => {
    mount('terminal')
    expect(screen.getByRole('group', { name: 'Style' })).toBeTruthy()
    expect(choice('Terminal').getAttribute('aria-pressed')).toBe('true')
    expect(choice('Default').getAttribute('aria-pressed')).toBe('false')
    expect(choice('Default').type).toBe('button')
    expect(choice('Terminal').type).toBe('button')
  })

  it('requests a style change and waits for the service mirror to select it', () => {
    const { store, setStyle } = mount()
    fireEvent.click(choice('Terminal'))
    expect(setStyle).toHaveBeenCalledWith('terminal')
    expect(choice('Default').getAttribute('aria-pressed')).toBe('true')
    act(() => { store.actions.sync('terminal', 1) })
    expect(choice('Terminal').getAttribute('aria-pressed')).toBe('true')
    expect(choice('Default').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(choice('Default'))
    expect(setStyle).toHaveBeenLastCalledWith('default')
  })

  it('keeps both previews out of each choice name and translates the controls', () => {
    mount('default', zh)
    expect(screen.getByRole('group', { name: '风格' })).toBeTruthy()
    expect(choice('默认').getAttribute('aria-pressed')).toBe('true')
    expect(choice('终端').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getAllByText('工作区')).toHaveLength(2)
    for (const preview of screen.getAllByText('工作区')) {
      expect(preview.closest('[aria-hidden="true"]')).toBeTruthy()
    }
  })
})
