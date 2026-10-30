// @vitest-environment jsdom
/** The ghost prediction hint travels through the locale-owned composer style. */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DraftEditor } from '../src/client/input/editor/DraftEditor.tsx'
import { en } from '../src/client/locales.ts'

describe('ghost prediction hint', () => {
  it('keeps the hint translated and inherited by the decorator portal', () => {
    const { container } = render(
      <DraftEditor
        classNames={{}}
        editor={null}
        scrollRef={{ current: null }}
        editable={false}
        editorDisabled={false}
        phase="inert"
        placeholderText=""
        ariaLabel=""
        workspaceTrigger={false}
        workspacePickerOpen={false}
        onWorkspaceKeyDown={() => {}}
        hint={null}
        ghostHint={en['input.ghost.accept']}
        showPlaceholder={false}
      />,
    )

    const editor = container.querySelector('[data-yh-part="composer-editor"]')
    expect(editor?.getAttribute('style')).toContain('--dsh-ghost-prediction-hint: "Press Tab to accept"')
    expect(en['input.ghost.accept']).toBe('Press Tab to accept')
  })
})
