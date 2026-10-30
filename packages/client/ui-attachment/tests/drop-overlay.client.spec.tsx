// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DropOverlay } from '../src/DropOverlay.tsx'

afterEach(cleanup)

describe('DropOverlay', () => {
  it('portals the invitation with its title and limits desc to the body', () => {
    const view = render(
      <DropOverlay disabled={false} labels={{ title: '\u{56FE}\u{7247}\u{62D6}\u{52A8}\u{5230}\u{6B64}\u{5904}\u{5373}\u{53EF}\u{6DFB}\u{52A0}', desc: '\u{6700}\u{591A} 20 \u{5F20}，\u{6BCF}\u{5F20} 5MB' }} />,
    )
    const overlay = view.getByRole('status')
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.textContent).toContain('\u{56FE}\u{7247}\u{62D6}\u{52A8}\u{5230}\u{6B64}\u{5904}\u{5373}\u{53EF}\u{6DFB}\u{52A0}')
    expect(overlay.textContent).toContain('\u{6700}\u{591A} 20 \u{5F20}，\u{6BCF}\u{5F20} 5MB')
  })

  it('omits the desc line when none is resolved', () => {
    const view = render(<DropOverlay disabled={false} labels={{ title: '\u{56FE}\u{7247}\u{62D6}\u{52A8}\u{5230}\u{6B64}\u{5904}\u{5373}\u{53EF}\u{6DFB}\u{52A0}' }} />)
    expect(view.getByRole('status').textContent).toBe('\u{56FE}\u{7247}\u{62D6}\u{52A8}\u{5230}\u{6B64}\u{5904}\u{5373}\u{53EF}\u{6DFB}\u{52A0}')
  })

  it('drops the desc and switches the illustration while disabled', () => {
    const enabled = render(
      <DropOverlay disabled={false} labels={{ title: '\u{62D6}\u{5165}', desc: '\u{9650}\u{5236}' }} />,
    )
    const enabledSvg = enabled.getByRole('status').querySelector('svg')!.innerHTML
    enabled.unmount()
    const disabled = render(
      <DropOverlay disabled labels={{ title: '\u{5F53}\u{524D}\u{65E0}\u{6CD5}\u{6DFB}\u{52A0}\u{56FE}\u{7247}', desc: '\u{9650}\u{5236}' }} />,
    )
    const overlay = disabled.getByRole('status')
    expect(overlay.textContent).toBe('\u{5F53}\u{524D}\u{65E0}\u{6CD5}\u{6DFB}\u{52A0}\u{56FE}\u{7247}')
    expect(overlay.querySelector('svg')!.innerHTML).not.toBe(enabledSvg)
  })
})
