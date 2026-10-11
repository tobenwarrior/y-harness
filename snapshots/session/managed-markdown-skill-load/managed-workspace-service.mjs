const entry = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const { default: WorkspaceRegistry } = await import(new URL(`../../../packages/workspace/workspace/${entry}`, import.meta.url))

export default WorkspaceRegistry
