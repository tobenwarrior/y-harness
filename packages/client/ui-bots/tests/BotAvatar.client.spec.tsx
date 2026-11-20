// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@yharness/attachment'
import { BotAvatar } from '../src/client/BotAvatar.tsx'
import { BOT_IDENTITY_CHOICES } from '../src/client/BotAppearancePicker.tsx'
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
  ['round', 'amber', 'Round'],
  ['cloud', 'amber', 'Cloud'],
  ['tile', 'amber', 'Tile'],
  ['clover', 'amber', 'Clover'],
  ['heart', 'amber', 'Heart'],
  ['drop', 'amber', 'Drop'],
  ['oval', 'amber', 'Oval'],
  ['triangle', 'amber', 'Triangle'],
] as const

describe('BotAvatar', () => {
  it('offers a larger set of character silhouettes', () => {
    expect(BOT_IDENTITY_CHOICES.length).toBeGreaterThanOrEqual(14)
  })
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

  it('gives every character a distinct silhouette and a clear pair of eyes', () => {
    render(<div>{identities.map(([identity, accent, name]) =>
      <BotAvatar key={identity} name={name} identity={identity} accent={accent} />)}</div>)
    const silhouettes = identities.map(([, , name]) => {
      const character = screen.getByRole('img', { name })
      expect(character.querySelectorAll('svg [data-character-part="eye"]')).toHaveLength(2)
      expect(character.querySelectorAll('[data-character-part="depth"]').length).toBeGreaterThan(1)
      return character.querySelector('svg [data-character-part="body"]')?.getAttribute('d')
    })
    expect(silhouettes.every(Boolean)).toBe(true)
    expect(new Set(silhouettes).size).toBe(identities.length)
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
    const generated = screen.getByRole('img', { name: 'Generated' })
    expect(generated.querySelector('[data-character]')).toBeNull()
    expect(generated.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(generated.querySelector('img')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('falls back to the character when the uploaded avatar cannot be loaded', async () => {
    const avatar = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const loadAvatar = vi.fn().mockRejectedValue(new Error('synthetic avatar failure'))
    render(<BotAvatar name="Fallback" avatar={avatar} botId="fallback" loadAvatar={loadAvatar} />)

    const rendered = screen.getByRole('img', { name: 'Fallback' })
    await waitFor(() => { expect(loadAvatar).toHaveBeenCalledWith('fallback', avatar) })
    await waitFor(() => { expect(rendered.querySelector('[data-character]')).not.toBeNull() })
    expect(rendered.getAttribute('data-avatar-loaded')).toBe('false')
  })

  it('ignores an uploaded avatar that resolves after unmount', async () => {
    const avatar = {
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    let resolveAvatar!: (url: string) => void
    const pending = new Promise<string>((resolve) => { resolveAvatar = resolve })
    const loadAvatar = vi.fn().mockReturnValue(pending)
    const view = render(<BotAvatar name="Unmounted" avatar={avatar} botId="unmounted" loadAvatar={loadAvatar} />)

    await waitFor(() => { expect(loadAvatar).toHaveBeenCalledWith('unmounted', avatar) })
    view.unmount()
    resolveAvatar('data:image/png;base64,c3RhbGU=')
    await pending
    await Promise.resolve()
  })

  it('ignores an uploaded avatar failure that arrives after unmount', async () => {
    const avatar = {
      attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    let rejectAvatar!: (reason: unknown) => void
    const pending = new Promise<string>((_, reject) => { rejectAvatar = reject })
    const loadAvatar = vi.fn().mockReturnValue(pending)
    const view = render(<BotAvatar name="Rejected" avatar={avatar} botId="rejected" loadAvatar={loadAvatar} />)

    await waitFor(() => { expect(loadAvatar).toHaveBeenCalledWith('rejected', avatar) })
    view.unmount()
    rejectAvatar(new Error('synthetic late failure'))
    await pending.catch(() => undefined)
    await Promise.resolve()
  })

  it('reflects bot activity on the character', () => {
    render(<BotAvatar name="Working bot" status="working" />)
    expect(screen.getByRole('img', { name: 'Working bot' }).getAttribute('data-status')).toBe('working')
  })

  it('lets the eyes follow the pointer and resets them when it leaves', () => {
    render(<BotAvatar name="Curious bot" />)
    const character = screen.getByRole('img', { name: 'Curious bot' }).querySelector<HTMLElement>('[data-character]')!
    vi.spyOn(character, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.mouseMove(character, { clientX: 100, clientY: 50 })
    expect(character.style.getPropertyValue('--eye-x')).toBe('3px')
    fireEvent.mouseLeave(character)
    expect(character.style.getPropertyValue('--eye-x')).toBe('')
  })

  it('ignores pointer motion when the character has no rendered bounds', () => {
    render(<BotAvatar name="Hidden bot" />)
    const character = screen.getByRole('img', { name: 'Hidden bot' }).querySelector<HTMLElement>('[data-character]')!
    vi.spyOn(character, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })

    fireEvent.mouseMove(character, { clientX: 100, clientY: 100 })

    expect(character.style.getPropertyValue('--eye-x')).toBe('')
    expect(character.style.getPropertyValue('--eye-y')).toBe('')
  })

  it('uses the requested size classes and keeps an empty name accessible', () => {
    render(<div><BotAvatar name="" size="tiny" /><BotAvatar name="Large bot" size="large" /></div>)

    const tiny = screen.getByRole('img', { name: '?' })
    const large = screen.getByRole('img', { name: 'Large bot' })
    expect(tiny.className).toContain('tiny')
    expect(large.className).toContain('large')
    expect(tiny.getAttribute('aria-label')).toBe('?')
  })

  it('positions the barbell eyes according to its definition', () => {
    render(<BotAvatar name="Barbell" identity="goal" />)
    const eyes = screen.getByRole('img', { name: 'Barbell' }).querySelectorAll('rect[data-character-part="eye"]')
    expect(eyes).toHaveLength(2)
    const [left, right] = Array.from(eyes).map(eye => Number(eye.getAttribute('x')))
    expect(right! - left!).toBe(15)
  })

  it('disables character motion for reduced-motion users', () => {
    const styles = readFileSync(resolve(import.meta.dirname, '../src/client/BotAvatar.module.css'), 'utf8')
    const reducedMotion = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))

    expect(reducedMotion).toContain('animation: none')
  })

  it('animates the eyes separately from the silhouette', () => {
    const styles = readFileSync(resolve(import.meta.dirname, '../src/client/BotAvatar.module.css'), 'utf8')
    expect(styles).toContain('@keyframes avatar-blink')
    expect(styles).toContain('translateX(')
  })
})
