// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveEditPatch } from '@yharness/api-remotes/client'
import { createLiveEditPreview } from '../src/client/live-edit-preview.ts'

afterEach(() => {
  document.body.replaceChildren()
})

function patchOf(...operations: LiveEditPatch['operations']): LiveEditPatch {
  return { title: 'Preview', operations }
}

function flushMutations(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

interface MockAnimation {
  readonly cancel: ReturnType<typeof vi.fn>
  onfinish: (() => void) | null
  oncancel: (() => void) | null
}

function installAnimations(): { readonly animations: MockAnimation[]; readonly restore: () => void } {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
  const animations: MockAnimation[] = []
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(() => {
      const animation = {
        cancel: vi.fn(),
        onfinish: null as (() => void) | null,
        oncancel: null as (() => void) | null,
      }
      animations.push(animation)
      return animation
    }),
  })
  return {
    animations,
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'animate')
      else Object.defineProperty(HTMLElement.prototype, 'animate', previous)
    },
  }
}

describe('createLiveEditPreview', () => {
  it('applies safe additions, hides, and literal styles, then restores the exact DOM state', () => {
    const optional = document.createElement('section')
    optional.setAttribute('data-yh-part', 'optional-panel')
    optional.style.cssText = 'display: grid !important; color: rgb(1, 2, 3); padding: 3px;'
    const input = document.createElement('button')
    input.textContent = 'inside'
    optional.append(input)
    const fallback = document.createElement('button')
    fallback.textContent = 'fallback'
    document.body.append(optional, fallback)
    input.focus()

    const preview = createLiveEditPreview(document)
    preview.apply(patchOf(
      { kind: 'hide', target: 'optional-panel' },
      { kind: 'style', target: 'optional-panel', color: '#ff0000', radius: 12, order: -2 },
      {
        kind: 'add', target: 'optional-panel', id: 'notice', position: 'end',
        title: '<b>Added</b>', text: '<script>safe</script>',
      },
    ))

    expect(optional.hidden).toBe(true)
    expect(optional.getAttribute('aria-hidden')).toBe('true')
    expect(optional.hasAttribute('inert')).toBe(true)
    expect(optional.style.getPropertyValue('display')).toBe('none')
    expect(optional.style.getPropertyPriority('display')).toBe('important')
    expect(optional.style.color).toBe('rgb(255, 0, 0)')
    expect(optional.style.borderRadius).toBe('12px')
    expect(optional.style.order).toBe('-2')
    expect(optional.querySelector('[data-yh-live-edit-id="notice"]')).not.toBeNull()
    expect(document.activeElement).toBe(fallback)

    // The addition is made only when a target can accept a child. Its labels are
    // text nodes, so model text cannot become markup or executable content.
    preview.apply(patchOf({
      kind: 'add', target: 'optional-panel', id: 'notice', position: 'end',
      title: '<b>Added</b>', text: '<script>safe</script>',
    }))
    const added = optional.querySelector<HTMLElement>('[data-yh-live-edit-id="notice"]')
    expect(added?.querySelector('b')).toBeNull()
    expect(added?.querySelector('script')).toBeNull()
    expect(added?.textContent).toBe('<b>Added</b><script>safe</script>')

    // Simulate an unrelated React inline-style update while the addition
    // preview is active; Undo must not replace the complete style attribute.
    optional.style.marginLeft = '22px'
    preview.apply()
    expect(optional.hidden).toBe(false)
    expect(optional.getAttribute('aria-hidden')).toBeNull()
    expect(optional.hasAttribute('inert')).toBe(false)
    expect(optional.style.getPropertyValue('display')).toBe('grid')
    expect(optional.style.getPropertyPriority('display')).toBe('important')
    expect(optional.style.color).toBe('rgb(1, 2, 3)')
    expect(optional.style.padding).toBe('3px')
    expect(optional.style.marginLeft).toBe('22px')
    expect(optional.querySelector('[data-yh-live-edit-id="notice"]')).toBeNull()
    expect(document.activeElement).toBe(input)
    preview.dispose()
  })

  it('accepts the live-target alias and refuses protected or unavailable targets', () => {
    const protectedFrame = document.createElement('main')
    protectedFrame.setAttribute('data-yh-part', 'frame')
    protectedFrame.textContent = 'recovery stays'
    const protectedControl = document.createElement('button')
    protectedControl.setAttribute('data-yh-live-target', 'secure')
    protectedControl.setAttribute('data-yh-live-edit-controls', '')
    protectedControl.textContent = 'secure'
    const alias = document.createElement('div')
    alias.setAttribute('data-yh-live-target', 'sidebar-panel-settings')
    document.body.append(protectedFrame, protectedControl, alias)

    const preview = createLiveEditPreview(document)
    preview.apply(patchOf(
      { kind: 'hide', target: 'frame' },
      { kind: 'hide', target: 'secure' },
      { kind: 'style', target: 'sidebar-panel-settings', background: '#101010', padding: 8 },
      { kind: 'style', target: 'does-not-exist', color: '#fff' },
    ))

    expect(protectedFrame.hidden).toBe(false)
    expect(protectedControl.hidden).toBe(false)
    expect(alias.style.background).toBe('rgb(16, 16, 16)')
    expect(alias.style.padding).toBe('8px')
    preview.dispose()
  })

  it('re-applies a live patch after React replaces a target or removes an owned addition', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-yh-part', 'live-region')
    target.style.color = '#111111'
    document.body.append(target)
    const preview = createLiveEditPreview(document)
    preview.apply(patchOf(
      { kind: 'style', target: 'live-region', color: '#ff0000' },
      { kind: 'add', target: 'live-region', id: 'live-note', position: 'end', title: 'Live note' },
    ))
    expect(target.querySelectorAll('[data-yh-live-edit-id="live-note"]')).toHaveLength(1)

    target.querySelector('[data-yh-live-edit-id="live-note"]')?.remove()
    await flushMutations()
    expect(target.querySelectorAll('[data-yh-live-edit-id="live-note"]')).toHaveLength(1)

    const replacement = document.createElement('div')
    replacement.setAttribute('data-yh-part', 'live-region')
    replacement.style.color = '#222222'
    target.replaceWith(replacement)
    await flushMutations()
    expect(replacement.style.color).toBe('rgb(255, 0, 0)')
    expect(replacement.querySelectorAll('[data-yh-live-edit-id="live-note"]')).toHaveLength(1)

    preview.apply()
    expect(replacement.style.color).toBe('rgb(34, 34, 34)')
    expect(replacement.querySelector('[data-yh-live-edit-id="live-note"]')).toBeNull()
    preview.dispose()
  })

  it('animates additions out and restored regions in when undoing a preview', () => {
    const animationMocks = installAnimations()
    try {
      const target = document.createElement('div')
      target.setAttribute('data-yh-part', 'undo-region')
      target.id = 'undo-target'
      const sibling = document.createElement('div')
      document.body.append(target, sibling)
      const preview = createLiveEditPreview(document)
      preview.apply(patchOf(
        { kind: 'hide', target: 'undo-region' },
        { kind: 'add', target: 'undo-region', id: 'undo-note', position: 'end', title: 'Undo me' },
      ))
      const beforeUndo = animationMocks.animations.length
      expect(document.querySelector('[data-yh-live-edit-exit]')?.id).toBe('')

      preview.apply()

      // The hide exit and addition entrance are followed by an addition exit
      // and a restored-region entrance during the Undo transition.
      expect(animationMocks.animations.length).toBeGreaterThan(beforeUndo)
      expect(animationMocks.animations.some(animation => animation.cancel.mock.calls.length > 0)).toBe(true)
      expect(target.hidden).toBe(false)
      expect(target.querySelector('[data-yh-live-edit-id="undo-note"]')).toBeNull()
      for (const animation of animationMocks.animations) animation.onfinish?.()
      expect(document.querySelector('[data-yh-live-edit-exits]')).toBeNull()
      preview.dispose()
    } finally {
      animationMocks.restore()
    }
  })
})
