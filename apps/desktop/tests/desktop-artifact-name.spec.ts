import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ARTIFACT_PREFIX,
  desktopArtifactBase,
  desktopArtifactFilename,
  desktopArtifactPattern,
} from '../scripts/desktop-artifact-name.mjs'

describe('Y Harness desktop artifact names', () => {
  it('uses the public Y Harness prefix for newly built artifacts', () => {
    expect(DESKTOP_ARTIFACT_PREFIX).toBe('y-harness')
    expect(desktopArtifactBase('1.2.3', 'win', 'x64')).toBe('y-harness-1.2.3-win-x64')
    expect(desktopArtifactFilename('1.2.3', 'win', 'x64', 'exe')).toBe('y-harness-1.2.3-win-x64.exe')
    expect(desktopArtifactFilename('1.2.3', 'win', 'x64', 'exe', true)).toBe('y-harness-1.2.3-win-x64-unsigned.exe')
  })

  it('recognizes old release names when discovering existing update versions', () => {
    const pattern = desktopArtifactPattern()
    expect(pattern.exec('dsh-desk/bin/win-x64/y-harness-1.2.3-win-x64.exe')?.groups?.version).toBe('1.2.3')
    expect(pattern.exec('dsh-desk/bin/win-x64/deepseek-harness-1.2.2-win-x64.exe')?.groups?.version).toBe('1.2.2')
    expect(pattern.exec('y-harness-1.2.3-win-x64.exe.blockmap')).toBeNull()
  })
})
