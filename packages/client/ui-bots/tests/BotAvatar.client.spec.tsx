// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@yharness/attachment'
import { BotAvatar } from '../src/client/BotAvatar.tsx'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

afterEach(cleanup)

const identities = [
  ['agent', 'violet', 'Bean'],
  ['sparkle', 'blue', 'Spark'],
  ['goal', 'amber', 'Orbit'],
  ['browse', 'teal', 'Blink'],
  ['skill', 'rose', 'Sprout'],
  ['workspace', 'lime', 'Buddy'],
] as const

describe('BotAvatar', () => {
  it('renders an original character with identity-specific parts and the selected accent', () => {
    render(<div>
      {identities.map(([identity, accent, name]) => <BotAvatar key={identity} name={name} identity={identity} accent={accent} />)}
    </div>)

    for (const [identity, accent, name] of identities) {
      const avatar = screen.getByRole('img', { name })
      const character = avatar.querySelector('[data-character]')
      expect(character).not.toBeNull()
      expect(character?.getAttribute('data-identity')).toBe(identity)
      expect(character?.getAttribute('data-accent')).toBe(accent)
      expect(character?.querySelector('[data-character-part="body"]')).not.toBeNull()
      expect(character?.querySelectorAll('[data-character-part="eye"]')).toHaveLength(2)
    }
  })

  it('keeps a generated avatar ahead of the semantic character fallback', async () => {
    const avatar = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const loadAvatar = vi.fn().mockResolvedValue('data:image/png;base64,aW1n')
    render(<BotAvatar name="Generated" identity="goal" accent="amber" avatar={avatar} botId="generated" loadAvatar={loadAvatar} />)

    await waitFor(() => { expect(screen.getByRole('img', { name: 'Generated' }).querySelector('img')).not.toBeNull() })
    expect(screen.getByRole('img', { name: 'Generated' }).querySelector('[data-character]')).toBeNull()
  })

  it('disables character motion for reduced-motion users', () => {
    const styles = readFileSync(resolve(import.meta.dirname, '../src/client/BotAvatar.module.css'), 'utf8')
    const reducedMotion = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))

    expect(reducedMotion).toContain('animation: none')
  })

  it('keeps each identity top orientation while the accessory sways', () => {
    const styles = readFileSync(resolve(import.meta.dirname, '../src/client/BotAvatar.module.css'), 'utf8')

    expect(styles).toContain('transform: rotate(var(--top-sway-start));')
    expect(styles).toContain('transform: rotate(var(--top-sway-end));')
    expect(styles).toMatch(
      /\.avatar\[data-identity='sparkle'\] \.characterTop \{[\s\S]*?--top-sway-start: 0deg;[\s\S]*?--top-sway-end: 0deg;/u,
    )
    expect(styles).toMatch(
      /\.avatar\[data-identity='goal'\] \.characterTop \{[\s\S]*?--top-sway-start: 34deg;[\s\S]*?--top-sway-end: 42deg;/u,
    )
  })
})
