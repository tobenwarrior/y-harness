// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AppearanceSection, type AppearanceSectionComponentProps } from '../src/client/AppearanceSection.tsx'

afterEach(cleanup)

const unusedHook = (() => { throw new Error('unused by appearance section') }) as never
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
type AttentionSnapshot = Parameters<Parameters<AppearanceSectionComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()

it('renders Appearance item contributions through its owned slot', () => {
  const renderSlot = vi.fn(((key: string) => <div data-slot={key}>Appearance controls</div>) as AppearanceSectionComponentProps['renderSlot'])
  const props: AppearanceSectionComponentProps = {
    useSessions: unusedHook, useSessionStatus: selector => selector(noAttention),
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource, useWorkspaces: unusedHook,
    close: vi.fn(), renderSlot,
  }
  render(<AppearanceSection {...props} />)
  expect(renderSlot).toHaveBeenCalledWith('settings.appearance.item', {})
  expect(screen.getByText('Appearance controls')).toBeTruthy()
})
