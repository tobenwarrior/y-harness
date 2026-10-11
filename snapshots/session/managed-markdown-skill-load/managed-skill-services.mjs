const entry = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const { default: SkillLibraryController } = await import(new URL(`../../../packages/skill/skill-library/${entry}`, import.meta.url))

export default SkillLibraryController
