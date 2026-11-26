/** Render and reverse named UI changes within the mounted app. */
import type { LiveEditOperation, LiveEditPatch } from '@yharness/api-remotes/client'
import css from './LiveEditPreview.module.css'

/** The browser-side handle for one reversible live-edit preview. */
export interface LiveEditPreview {
  /** Apply a complete preview, or omit the patch to restore the previous view. */
  apply(patch?: LiveEditPatch): void
  /** Stop observing the document and restore every change owned by the preview. */
  dispose(): void
}

interface ElementSnapshot {
  element: HTMLElement
  hidden: boolean
  ariaHidden: string | null
  inert: boolean
  styles: Partial<Record<LiveEditStyleProperty, StyleSnapshot>>
}

type LiveEditStyleProperty = 'display' | 'color' | 'background' | 'border-radius' | 'padding' | 'order'

interface StyleSnapshot {
  readonly value: string
  readonly priority: string
}

const LIVE_EDIT_STYLE_PROPERTIES: readonly LiveEditStyleProperty[] = [
  'display', 'color', 'background', 'border-radius', 'padding', 'order',
]

interface AddedEntry {
  readonly id: string
  readonly operation: Extract<LiveEditOperation, { kind: 'add' }>
  element: HTMLElement
}

interface FocusRecord {
  readonly previous: HTMLElement
  readonly fallback: HTMLElement | null
}

const TARGET_ATTRIBUTES = ['data-yh-part', 'data-yh-live-target'] as const

/** These parts contain app navigation, recovery, or the live-edit controls themselves. */
const PROTECTED_MARKERS = new Set([
  'app',
  'center-column',
  'composer',
  'controls',
  'frame',
  'main',
  'main-column',
  'rightbar',
  'rightbar-column',
  'root',
  'shell',
  'sidebar-column',
  'sidebar',
  'sidebar-nav',
  'toolbar',
  'conversation',
  'conversation-header',
  'composer-editor',
  'composer-draft',
  'composer-controls',
  'composer-primary',
  'session-prompt',
  'shell-overlay',
  'shell-recovery',
  'live-edit-controls',
  'recovery-controls',
  'security-controls',
])

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const SAFE_CSS_PATTERN = /^[a-z\d(),.%#\s+-]+$/iu
const SAFE_CSS_FUNCTION_PATTERN = /^(?:rgb|rgba|hsl|hsla)\([^;{}<>`]+\)$/iu
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const ANIMATION_DURATION = 180

/**
 * Creates a DOM-only live-edit preview. The engine accepts only named product
 * markers; it never evaluates selectors, markup, style rules, or script.
 *
 * @param document - The window document whose existing UI is previewed.
 * @returns A reversible preview handle.
 */
export function createLiveEditPreview(document: Document): LiveEditPreview {
  return new BrowserLiveEditPreview(document)
}

class BrowserLiveEditPreview implements LiveEditPreview {
  private readonly snapshots = new Map<HTMLElement, ElementSnapshot>()
  private readonly added = new Map<string, AddedEntry>()
  private readonly hidden = new Set<HTMLElement>()
  private readonly exitAnimations = new Set<Animation>()
  private observer: MutationObserver | null = null
  private exitLayer: HTMLElement | null = null
  private focusRecord: FocusRecord | null = null
  private activePatch: LiveEditPatch | undefined
  private reconcileQueued = false
  private disposed = false

  public constructor(private readonly document: Document) {
    const MutationObserverConstructor = document.defaultView?.MutationObserver
    if (MutationObserverConstructor === undefined) return
    const root = document.documentElement

    this.observer = new MutationObserverConstructor((records) => {
      if (this.activePatch === undefined || this.disposed || this.ownedOnly(records)
        || !records.some(record => this.needsReconcile(record))) return
      this.queueReconcile()
    })
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...TARGET_ATTRIBUTES],
    })
  }

  public apply(patch?: LiveEditPatch): void {
    if (this.disposed) return
    this.restoreApplied(this.activePatch !== undefined)
    this.activePatch = patch
    if (patch === undefined) return
    this.reconcile()
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.activePatch = undefined
    this.restoreApplied()
  }

  private reconcile(): void {
    const patch = this.activePatch
    if (patch === undefined || this.disposed) return

    const layoutBefore = new Map<HTMLElement, Map<HTMLElement, DOMRect>>()
    for (const operation of patch.operations) {
      if (operation.kind === 'hide') {
        for (const target of this.findTargets(operation.target)) {
          if (this.isProtectedTarget(target)) continue
          this.captureLayout(target.parentElement, layoutBefore)
          this.applyHide(target)
          this.animateLayout(target.parentElement, layoutBefore.get(target.parentElement ?? target))
        }
      } else if (operation.kind === 'style') {
        for (const target of this.findTargets(operation.target)) {
          if (this.isProtectedTarget(target)) continue
          this.captureLayout(target.parentElement, layoutBefore)
          this.applyStyle(target, operation)
          this.animateLayout(target.parentElement, layoutBefore.get(target.parentElement ?? target))
        }
      } else {
        const target = this.findTargets(operation.target).find(candidate => !this.isProtectedTarget(candidate))
        if (target === undefined || !this.isSafeAddOperation(operation)) continue
        const existing = this.added.get(operation.id)
        if (existing !== undefined) {
          const expectedParent = operation.position === 'start' || operation.position === 'end'
            ? target
            : target.parentElement
          if (existing.element.isConnected && existing.element.parentNode === expectedParent) continue
          if (this.isOwned(existing.element)) existing.element.remove()
          this.added.delete(operation.id)
        }
        this.captureLayout(target.parentElement, layoutBefore)
        const element = this.createAddition(operation)
        if (element === null) continue
        if (!this.insertAddition(target, element, operation.position)) continue
        this.added.set(operation.id, { id: operation.id, operation, element })
        this.animateAdd(element)
        this.animateLayout(target.parentElement, layoutBefore.get(target.parentElement ?? target))
      }
    }
    this.restoreFocusAfterHide()
  }

  private findTargets(target: string): HTMLElement[] {
    if (!TARGET_PATTERN.test(target)) return []
    const matches: HTMLElement[] = []
    // `target` has already passed the lowercase token grammar, so interpolation
    // cannot introduce a selector or attribute escape. The selector stays exact
    // and avoids walking streamed message text or unrelated app nodes.
    const selector = `[data-yh-part="${target}"], [data-yh-live-target="${target}"]`
    for (const node of Array.from(this.document.querySelectorAll<HTMLElement>(selector))) {
      if (this.isOwnedTree(node)) continue
      matches.push(node)
    }
    return matches
  }

  private needsReconcile(record: MutationRecord): boolean {
    if (record.type === 'attributes') return true
    if (record.target instanceof HTMLElement && this.isOwned(record.target)) return true
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
    return nodes.some(node => node instanceof HTMLElement && (this.isOwned(node) || this.hasTargetMarker(node)))
  }

  private hasTargetMarker(element: HTMLElement): boolean {
    if (TARGET_ATTRIBUTES.some(attribute => element.hasAttribute(attribute))) return true
    return element.querySelector('[data-yh-part], [data-yh-live-target]') !== null
  }

  private isProtectedTarget(element: HTMLElement): boolean {
    const stack: HTMLElement[] = [element]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) continue
      if (current.hasAttribute('data-yh-live-edit-protected')
        || current.hasAttribute('data-yh-recovery-control')
        || current.hasAttribute('data-yh-security-surface')
        || current.hasAttribute('data-yh-live-edit-control')
        || current.hasAttribute('data-yh-live-edit-controls')) return true
      const marker = this.markerOf(current)
      if (marker !== null && PROTECTED_MARKERS.has(marker)) return true
      for (const child of Array.from(current.children)) {
        if (child instanceof HTMLElement) stack.push(child)
      }
    }
    return false
  }

  private markerOf(element: HTMLElement): string | null {
    for (const attribute of TARGET_ATTRIBUTES) {
      const value = element.getAttribute(attribute)
      if (value !== null) return value
    }
    return null
  }

  private captureLayout(parent: HTMLElement | null, layouts: Map<HTMLElement, Map<HTMLElement, DOMRect>>): void {
    if (parent === null || layouts.has(parent)) return
    const before = new Map<HTMLElement, DOMRect>()
    for (const child of Array.from(parent.children)) {
      if (child instanceof HTMLElement && !this.isOwned(child)) before.set(child, child.getBoundingClientRect())
    }
    layouts.set(parent, before)
  }

  private animateLayout(
    parent: HTMLElement | null,
    before: Map<HTMLElement, DOMRect> | undefined,
    skip: ReadonlySet<HTMLElement> = new Set(),
  ): void {
    if (parent === null || before === undefined || this.prefersReducedMotion()) return
    for (const [element, oldRect] of before) {
      if (skip.has(element) || !element.isConnected || element.hidden) continue
      const nextRect = element.getBoundingClientRect()
      const x = oldRect.left - nextRect.left
      const y = oldRect.top - nextRect.top
      if (x === 0 && y === 0) continue
      this.animate(element, [
        { transform: `translate(${x}px, ${y}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: ANIMATION_DURATION, easing: 'ease-out' })
    }
  }

  private applyHide(element: HTMLElement): void {
    const firstApplication = !this.hidden.has(element)
    if (firstApplication) {
      this.snapshot(element, ['display'])
      this.hidden.add(element)
      const active = this.document.activeElement
      if (this.focusRecord === null && active instanceof HTMLElement && element.contains(active)) {
        this.focusRecord = { previous: active, fallback: element.parentElement }
      }
      if (!element.hidden) this.animateExit(element)
    }
    element.hidden = true
    element.setAttribute('aria-hidden', 'true')
    element.setAttribute('inert', '')
    element.style.setProperty('display', 'none', 'important')
  }

  private applyStyle(element: HTMLElement, operation: Extract<LiveEditOperation, { kind: 'style' }>): void {
    const color = this.safeCssValue(operation.color, 'color')
    const background = this.safeCssValue(operation.background, 'background')
    const radius = this.safeDimension(operation.radius)
    const padding = this.safeDimension(operation.padding)
    const order = this.safeOrder(operation.order)
    this.snapshot(element, [
      ...color === undefined ? [] : ['color' as const],
      ...background === undefined ? [] : ['background' as const],
      ...radius === undefined ? [] : ['border-radius' as const],
      ...padding === undefined ? [] : ['padding' as const],
      ...order === undefined ? [] : ['order' as const],
    ])
    if (color !== undefined) element.style.color = color
    if (background !== undefined) element.style.background = background
    if (radius !== undefined) element.style.borderRadius = `${radius}px`
    if (padding !== undefined) element.style.padding = `${padding}px`
    if (order !== undefined) element.style.order = `${order}`
  }

  private createAddition(operation: Extract<LiveEditOperation, { kind: 'add' }>): HTMLElement | null {
    const element = this.document.createElement('div')
    element.setAttribute('data-yh-live-edit-owned', 'true')
    element.setAttribute('data-yh-live-edit-id', operation.id)
    element.className = css.addition ?? ''
    element.setAttribute('aria-live', 'polite')

    const title = this.document.createElement('strong')
    title.className = css.title ?? ''
    title.setAttribute('data-yh-live-edit-title', '')
    title.textContent = operation.title
    element.append(title)
    if (operation.text !== undefined) {
      const text = this.document.createElement('span')
      text.className = css.text ?? ''
      text.setAttribute('data-yh-live-edit-text', '')
      text.textContent = operation.text
      element.append(text)
    }
    return element
  }

  private insertAddition(target: HTMLElement, element: HTMLElement, position: Extract<LiveEditOperation, { kind: 'add' }>['position']): boolean {
    if (position === 'start') {
      target.insertBefore(element, target.firstChild)
      return true
    }
    if (position === 'end') {
      target.append(element)
      return true
    }
    const parent = target.parentNode
    if (parent === null) return false
    if (position === 'before') parent.insertBefore(element, target)
    else parent.insertBefore(element, target.nextSibling)
    return true
  }

  private isSafeAddOperation(operation: Extract<LiveEditOperation, { kind: 'add' }>): boolean {
    return ID_PATTERN.test(operation.id)
      && operation.title.length <= 1_000
      && (operation.text === undefined || operation.text.length <= 4_000)
  }

  private animateAdd(element: HTMLElement): void {
    if (this.prefersReducedMotion()) return
    element.style.opacity = '0'
    element.style.transform = 'translateY(4px)'
    this.animate(element, [
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: ANIMATION_DURATION, easing: 'ease-out', fill: 'both' }, () => {
      element.style.opacity = ''
      element.style.transform = ''
    })
  }

  private animateExit(element: HTMLElement): void {
    if (this.prefersReducedMotion()) return
    const layer = this.ensureExitLayer()
    if (layer === null) return
    const clone = element.cloneNode(true)
    if (!(clone instanceof HTMLElement)) return
    clone.removeAttribute('id')
    clone.setAttribute('data-yh-live-edit-exit', 'true')
    clone.setAttribute('aria-hidden', 'true')
    clone.setAttribute('inert', '')
    for (const node of Array.from(clone.querySelectorAll<HTMLElement>('[id]'))) node.removeAttribute('id')
    const rect = element.getBoundingClientRect()
    clone.style.position = 'fixed'
    clone.style.left = `${rect.left}px`
    clone.style.top = `${rect.top}px`
    clone.style.width = `${rect.width}px`
    clone.style.height = `${rect.height}px`
    clone.style.margin = '0'
    clone.style.pointerEvents = 'none'
    layer.append(clone)
    this.animate(clone, [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-4px) scale(.98)' },
    ], { duration: ANIMATION_DURATION, easing: 'ease-in', fill: 'forwards' }, () => {
      clone.remove()
      if (this.exitLayer === layer && layer.childElementCount === 0) {
        layer.remove()
        this.exitLayer = null
      }
    })
  }

  private ensureExitLayer(): HTMLElement | null {
    if (this.exitLayer?.isConnected) return this.exitLayer
    const body = this.document.body
    const layer = this.document.createElement('div')
    layer.setAttribute('data-yh-live-edit-exits', 'true')
    layer.setAttribute('aria-hidden', 'true')
    layer.setAttribute('inert', '')
    layer.style.position = 'fixed'
    layer.style.inset = '0'
    layer.style.pointerEvents = 'none'
    layer.style.zIndex = '2147483646'
    body.append(layer)
    this.exitLayer = layer
    return layer
  }

  private animate(
    element: HTMLElement,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
    onFinish?: () => void,
  ): void {
    if (this.prefersReducedMotion() || typeof element.animate !== 'function') {
      onFinish?.()
      return
    }
    try {
      const animation = element.animate(keyframes, options)
      this.exitAnimations.add(animation)
      const finish = (): void => {
        this.exitAnimations.delete(animation)
        onFinish?.()
      }
      animation.onfinish = finish
      animation.oncancel = finish
    } catch (animationError) {
      // A browser without a usable Web Animations implementation still gets the edit.
      void animationError
      onFinish?.()
    }
  }

  private safeCssValue(value: string | undefined, property: 'color' | 'background'): string | undefined {
    if (value === undefined) return undefined
    const candidate = value.trim()
    if (candidate.length === 0 || candidate.length > 120 || !SAFE_CSS_PATTERN.test(candidate)
      || /(?:url|var|expression)\s*\(/iu.test(candidate)
      || (candidate.includes('(') && !SAFE_CSS_FUNCTION_PATTERN.test(candidate))) return undefined
    const css = this.document.defaultView?.CSS
    if (css !== undefined && typeof css.supports === 'function' && !css.supports(property, candidate)) return undefined
    return candidate
  }

  private safeDimension(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 96 ? value : undefined
  }

  private safeOrder(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value >= -100 && value <= 100 ? value : undefined
  }

  private snapshot(element: HTMLElement, properties: readonly LiveEditStyleProperty[]): void {
    const snapshot = this.snapshots.get(element) ?? {
      element,
      hidden: element.hidden === true,
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element.hasAttribute('inert'),
      styles: {},
    }
    for (const property of properties) {
      if (snapshot.styles[property] !== undefined) continue
      snapshot.styles[property] = {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      }
    }
    this.snapshots.set(element, snapshot)
  }

  private restoreApplied(animateRestore = false): void {
    this.cancelAnimations()
    this.exitLayer?.remove()
    this.exitLayer = null
    const layouts = animateRestore ? this.captureRestoreLayouts() : new Map<HTMLElement, Map<HTMLElement, DOMRect>>()
    const restored = animateRestore
      ? new Set([...this.hidden].filter(element => this.snapshots.get(element)?.hidden === false))
      : new Set<HTMLElement>()
    if (animateRestore) {
      for (const entry of this.added.values()) {
        if (this.isOwned(entry.element) && entry.element.isConnected) this.animateExit(entry.element)
      }
    }
    for (const entry of this.added.values()) {
      if (this.isOwned(entry.element)) entry.element.remove()
    }
    this.added.clear()
    for (const snapshot of this.snapshots.values()) {
      snapshot.element.hidden = snapshot.hidden
      if (snapshot.ariaHidden === null) snapshot.element.removeAttribute('aria-hidden')
      else snapshot.element.setAttribute('aria-hidden', snapshot.ariaHidden)
      if (snapshot.inert) snapshot.element.setAttribute('inert', '')
      else snapshot.element.removeAttribute('inert')
      for (const property of LIVE_EDIT_STYLE_PROPERTIES) {
        const previous = snapshot.styles[property]
        if (previous !== undefined) snapshot.element.style.setProperty(property, previous.value, previous.priority)
      }
    }
    this.snapshots.clear()
    this.hidden.clear()
    this.restoreFocus()
    this.focusRecord = null
    if (animateRestore) {
      for (const element of restored) this.animateRestore(element)
      for (const [parent, before] of layouts) this.animateLayout(parent, before, restored)
    }
  }

  private captureRestoreLayouts(): Map<HTMLElement, Map<HTMLElement, DOMRect>> {
    const layouts = new Map<HTMLElement, Map<HTMLElement, DOMRect>>()
    for (const element of this.hidden) this.captureLayout(element.parentElement, layouts)
    for (const entry of this.added.values()) this.captureLayout(entry.element.parentElement, layouts)
    return layouts
  }

  private animateRestore(element: HTMLElement): void {
    if (!element.isConnected || this.prefersReducedMotion()) return
    this.animate(element, [
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: ANIMATION_DURATION, easing: 'ease-out' })
  }

  private restoreFocusAfterHide(): void {
    const record = this.focusRecord
    if (record === null || (!this.isHiddenByPreview(record.previous) && record.previous.isConnected)) return
    const candidate = this.findFocusable(record.fallback)
    if (candidate !== null) this.focus(candidate)
  }

  private restoreFocus(): void {
    const record = this.focusRecord
    if (record === null || !record.previous.isConnected || this.isHiddenByPreview(record.previous)) return
    this.focus(record.previous)
  }

  private isHiddenByPreview(element: HTMLElement): boolean {
    let current: HTMLElement | null = element
    while (current !== null) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return true
      current = current.parentElement
    }
    return false
  }

  private findFocusable(preferred: HTMLElement | null): HTMLElement | null {
    if (preferred !== null && this.canFocus(preferred)) return preferred
    for (const node of Array.from(this.document.getElementsByTagName('*'))) {
      if (node instanceof HTMLElement && this.canFocus(node)) return node
    }
    return null
  }

  private canFocus(element: HTMLElement): boolean {
    if (!element.isConnected || this.isHiddenByPreview(element)) return false
    if (element.dataset.yhLiveEditOwned === 'true') return false
    if (element.tabIndex >= 0) return true
    const tagName = element.tagName.toLowerCase()
    return (tagName === 'button' || tagName === 'input' || tagName === 'select' || tagName === 'textarea' || tagName === 'a')
      && !element.hasAttribute('disabled')
  }

  private focus(element: HTMLElement): void {
    try {
      element.focus({ preventScroll: true })
    } catch (focusError) {
      // Older WebViews may not accept focus options; focusing remains best effort.
      void focusError
      element.focus()
    }
  }

  private isOwned(element: HTMLElement): boolean {
    return element.getAttribute('data-yh-live-edit-owned') === 'true'
      || element.getAttribute('data-yh-live-edit-exit') === 'true'
  }

  private isOwnedTree(element: HTMLElement): boolean {
    let current: HTMLElement | null = element
    while (current !== null) {
      if (this.isOwned(current)) return true
      current = current.parentElement
    }
    return false
  }

  private ownedOnly(records: readonly MutationRecord[]): boolean {
    if (records.length === 0) return false
    return records.every((record) => {
      if (record.target instanceof HTMLElement && this.isOwned(record.target)) return true
      const added = Array.from(record.addedNodes)
      return added.length > 0 && record.removedNodes.length === 0
        && added.every(node => node instanceof HTMLElement && this.isOwned(node))
    })
  }

  private queueReconcile(): void {
    if (this.reconcileQueued || this.disposed) return
    this.reconcileQueued = true
    queueMicrotask(() => {
      this.reconcileQueued = false
      if (this.activePatch !== undefined && !this.disposed) this.reconcile()
    })
  }

  private cancelAnimations(): void {
    for (const animation of this.exitAnimations) animation.cancel()
    this.exitAnimations.clear()
  }

  private prefersReducedMotion(): boolean {
    try {
      const view = this.document.defaultView
      if (view === null) return false
      return view.matchMedia(REDUCED_MOTION_QUERY).matches
    } catch (mediaError) {
      // Match-media is optional in embedded WebViews; preserve the animated default.
      void mediaError
      return false
    }
  }
}
