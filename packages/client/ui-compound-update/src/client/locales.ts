/** Locale dictionary for the Compound skills update indicator. */

export const en = {
  badge: 'Compound skills update available',
  badgeShort: 'Update available',
  title: 'Compound skills update',
  checking: 'Checking the released Compound skills version…',
  available: 'Compound skills {upstream} is released; this build ships {vendored}.',
  current: 'This build ships the current Compound skills release, {vendored}.',
  unavailable: 'The released version could not be read: {reason}',
  update: 'Update to {upstream}',
  updating: 'Updating…',
  updated: 'Updated — Y Harness restarts itself',
  updateFailed: 'The update did not apply: {reason}',
  restartHint: 'The checkout takes the release, then Y Harness rebuilds and reopens.',
  stepsTitle: 'To update',
  stepsBody: 'Update and rebuild your Y Harness checkout, then restart the app. The skills and their Python tools ship with Y Harness, so the vendored copy follows the checkout.',
  repository: 'Upstream repository',
  refresh: 'Check again',
  close: 'Close',
} as const

/** Keys owned by the indicator's dictionary. */
export type CompoundUpdateKey = keyof typeof en

export const zh: Record<CompoundUpdateKey, string> = {
  badge: 'Compound 技能有可用更新',
  badgeShort: '有可用更新',
  title: 'Compound 技能更新',
  checking: '正在检查已发布的 Compound 技能版本…',
  available: 'Compound 技能 {upstream} 已发布；当前构建包含 {vendored}。',
  current: '当前构建已包含最新的 Compound 技能版本 {vendored}。',
  unavailable: '无法读取已发布的版本：{reason}',
  update: '更新到 {upstream}',
  updating: '正在更新…',
  updated: '已更新 — Y Harness 将自行重启',
  updateFailed: '更新未应用：{reason}',
  restartHint: '检出目录会先获取该版本，随后 Y Harness 重新构建并重新打开。',
  stepsTitle: '更新方法',
  stepsBody: '更新并重新构建你的 Y Harness 检出目录，然后重启应用。技能及其 Python 工具随 Y Harness 一起发布，因此随检出目录一并更新。',
  repository: '上游仓库',
  refresh: '重新检查',
  close: '关闭',
}
