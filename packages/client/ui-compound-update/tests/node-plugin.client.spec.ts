/** Host half: the indicator renders on the browser side only. */
import { describe, expect, it } from 'vitest'
import * as hostHalf from '../src/index.ts'

describe('compound update host half', () => {
  it('mounts nothing and declares no service', () => {
    hostHalf.apply()
    expect(Object.keys(hostHalf)).toEqual(['apply'])
  })
})
