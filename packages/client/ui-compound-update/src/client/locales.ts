/** Locale dictionary for the Compound skills update indicator. */

export const en = {
  badge: 'Compound skills update available',
  badgeShort: 'Update available',
  badgeCurrent: 'Your Compound skills are up to date',
  badgeCurrentShort: 'Up to date',
  badgeError: 'Could not check for Compound skills updates',
  badgeErrorShort: 'Check failed',
  title: 'Compound skills update',
  checking: 'Checking for Compound skills updates…',
  available: 'Compound skills {upstream} are available; you have {vendored}.',
  current: 'Your Compound skills are up to date ({vendored}).',
  unavailable: 'Could not check for updates: {reason}',
  update: 'Update to {upstream}',
  updating: 'Updating…',
  updated: 'Updated — available on next load',
  updateFailed: 'The update did not apply: {reason}',
  restartHint: 'Updated skills are available on their next load; no restart is needed.',
  stepsTitle: 'To update',
  stepsBody: 'Y Harness verifies the update for you. The new skills are available the next time you load them; no restart is needed.',
  repository: 'Upstream repository',
  refresh: 'Check again',
  close: 'Close',
} as const

/** Keys owned by the indicator's dictionary. */
export type CompoundUpdateKey = keyof typeof en

/** Simplified Chinese dictionary for every key this namespace declares. */
export const zh: Record<CompoundUpdateKey, string> = {
  badge: 'Compound 技能有可用更新',
  badgeShort: '有可用更新',
  badgeCurrent: '你的 Compound 技能已是最新',
  badgeCurrentShort: '已是最新',
  badgeError: '无法检查 Compound 技能更新',
  badgeErrorShort: '检查失败',
  title: 'Compound 技能更新',
  checking: '正在检查 Compound 技能更新…',
  available: 'Compound 技能 {upstream} 已可用；你当前使用的是 {vendored}。',
  current: '你的 Compound 技能已是最新版本（{vendored}）。',
  unavailable: '无法检查更新：{reason}',
  update: '更新到 {upstream}',
  updating: '正在更新…',
  updated: '已更新，下次加载时生效',
  updateFailed: '更新未应用：{reason}',
  restartHint: '更新后的技能会在下次加载时生效，无需重启。',
  stepsTitle: '更新方法',
  stepsBody: 'Y Harness 会为你验证更新。下次加载技能时即可使用，无需重启。',
  repository: '上游仓库',
  refresh: '重新检查',
  close: '关闭',
}
