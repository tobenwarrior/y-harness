import { expect, it } from 'vitest'
import { isNativeProcedurePath } from '../src/native-procedure-path.ts'

it.each(['/project/src/source.ts', '../outside.ts', 'C:\\project\\source.ts', 'src/.hidden.ts', 'src/token.ts', 'src/source.txt', 'src/a.ts\n'])('rejects unsafe or unsupported native procedure path %s', (path) => {
  expect(isNativeProcedurePath(path)).toBe(false)
})

it('admits only a bounded project-relative source filename', () => {
  expect(isNativeProcedurePath('src/source.ts')).toBe(true)
  expect(isNativeProcedurePath(`src/${'a'.repeat(249)}.ts`)).toBe(true)
  expect(isNativeProcedurePath(`src/${'a'.repeat(250)}.ts`)).toBe(false)
})
