import { parseEnv } from 'node:util'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeDesktopDotenvValue, writeDesktopDotenvFile } from '../scripts/desktop-dotenv.mjs'

describe('Desktop release dotenv serialization', () => {
  it.each([
    ['comment marker', 'password#with#markers'],
    ['double quote', 'identity"with#marker'],
    ['single quote', "password'with#marker"],
    ['backslash', 'C:\\signing\\certificate.p12'],
    ['newline', 'line-one\nline-two'],
  ])('round trips %s through Node parseEnv', (_label, value) => {
    const contents = `SETTING=${serializeDesktopDotenvValue(value)}\n`
    expect(parseEnv(contents).SETTING).toBe(value)
  })

  it('rejects values whose two quote delimiters cannot be represented losslessly', () => {
    expect(() => serializeDesktopDotenvValue(`both'quotes"#`)).toThrow(/unsupported quote/u)
  })

  it('writes selected settings without logging or changing their values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yharness-dotenv-'))
    try {
      const path = join(root, '.env.macos')
      const environment = { SECRET: 'password#with\\path', OTHER: 'line-one\nline-two' }
      await writeDesktopDotenvFile(path, ['SECRET', 'OTHER'], environment)
      const parsed = parseEnv(await readFile(path, 'utf8'))
      expect(parsed).toEqual(environment)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
