/** Kernel-owned text remains available while locale plugins are replacing. */
export interface BootMessages {
  /** Status while the client roster is activating. */
  readonly loading: string
  /** Heading for an activation failure report. */
  readonly failed: string
  /** Label for the page-local recovery action. */
  readonly retry: string
}

const en: BootMessages = {
  loading: 'Loading plugins…',
  failed: 'Failed to load plugins',
  retry: 'Retry',
}
const zh: BootMessages = {
  loading: '正在加载插件…',
  failed: '插件加载失败',
  retry: '重试',
}

/**
 * Resolve boot text from the document locale retained through plugin teardown.
 * @param document - owning document.
 * @returns localized kernel text.
 */
export function bootMessages(document: Document): BootMessages {
  return document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en
}
