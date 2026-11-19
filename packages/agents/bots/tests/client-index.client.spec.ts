import { expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('loads the browser Bot vocabulary without requiring any Client services', () => {
  expect(inject).toEqual([])
  expect(apply).not.toThrow()
})
