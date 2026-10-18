/** Locale dictionary for the Compound code-map panel. */

export const en = {
  panel: 'Code map',
  title: 'Compound code map',
  frameTitle: 'Compound code map for this workspace',
  reload: 'Reload the map',
  hint: 'The map is served by this Y Harness build; the graph and the source previews stay on this machine.',
  unavailable: 'The code map could not be loaded. A deployment needs Python 3.11+ so the vendored service can start.',
} as const

/** Keys owned by the code-map dictionary. */
export type CompoundMapKey = keyof typeof en

export const zh: Record<CompoundMapKey, string> = {
  panel: '代码地图',
  title: 'Compound 代码地图',
  frameTitle: '当前工作区的 Compound 代码地图',
  reload: '重新加载地图',
  hint: '该地图由当前 Y Harness 构建提供；图谱与源码预览都保留在本机。',
  unavailable: '无法加载代码地图。部署环境需要 Python 3.11+ 才能启动内置服务。',
}
