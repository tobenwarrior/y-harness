import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import clsx from 'clsx'
import type { BotAvatar as SharedBotAvatar } from '@yharness/bots/client'
import css from './BotAvatar.module.css'
import type { BotAccent, BotIdentity, BotStatus } from './types.ts'

const silhouettes: Record<BotIdentity, string> = {
  agent: 'M25 30 C14 29 10 38 8 55 C6 70 10 76 18 76 C27 76 28 64 36 63 L64 63 C72 64 73 76 82 76 C90 76 94 70 92 55 C90 38 86 29 75 30 C66 30 63 33 50 33 C37 33 34 30 25 30 Z',
  sparkle: 'M50 9 C53 9 55 15 57 25 C59 34 65 40 74 42 C84 44 91 47 91 50 C91 53 84 56 74 58 C65 60 59 66 57 75 C55 85 53 91 50 91 C47 91 45 85 43 75 C41 66 35 60 26 58 C16 56 9 53 9 50 C9 47 16 44 26 42 C35 40 41 34 43 25 C45 15 47 9 50 9 Z',
  goal: 'M12 41H12A4 4 0 0 1 16 45V55A4 4 0 0 1 12 59H12A4 4 0 0 1 8 55V45A4 4 0 0 1 12 41ZM18 29H18A4 4 0 0 1 22 33V67A4 4 0 0 1 18 71H18A4 4 0 0 1 14 67V33A4 4 0 0 1 18 29ZM26 17H26A5 5 0 0 1 31 22V78A5 5 0 0 1 26 83H26A5 5 0 0 1 21 78V22A5 5 0 0 1 26 17ZM38 33H62A10 10 0 0 1 72 43V57A10 10 0 0 1 62 67H38A10 10 0 0 1 28 57V43A10 10 0 0 1 38 33ZM74 17H74A5 5 0 0 1 79 22V78A5 5 0 0 1 74 83H74A5 5 0 0 1 69 78V22A5 5 0 0 1 74 17ZM82 29H82A4 4 0 0 1 86 33V67A4 4 0 0 1 82 71H82A4 4 0 0 1 78 67V33A4 4 0 0 1 82 29ZM88 41H88A4 4 0 0 1 92 45V55A4 4 0 0 1 88 59H88A4 4 0 0 1 84 55V45A4 4 0 0 1 88 41Z',
  browse: 'M29 25 C22 25 20 29 20 36 L20 66 C20 78 29 84 46 84 C63 84 72 78 72 66 L72 36 C72 29 70 25 63 25 Z M72 39 C91 35 93 64 72 65 L72 57 C83 57 83 46 72 47 Z',
  skill: 'M50 12 C58 12 62 18 64 23 C70 19 77 19 82 25 C87 31 86 38 81 43 C88 47 90 54 87 61 C84 68 78 71 71 69 C69 77 63 82 55 81 C53 90 47 90 45 81 C37 82 31 77 29 69 C22 71 16 68 13 61 C10 54 12 47 19 43 C14 38 13 31 18 25 C23 19 30 19 36 23 C38 18 42 12 50 12 Z',
  workspace: 'M16 30 C16 24 20 21 26 21 L42 21 C46 21 48 23 51 27 L76 27 C82 27 85 31 85 37 L85 70 C85 78 80 82 72 82 L28 82 C20 82 16 78 16 70 Z',
  round: 'M50 13 C72 13 87 28 87 50 C87 72 72 87 50 87 C28 87 13 72 13 50 C13 28 28 13 50 13 Z',
  cloud: 'M27 76 C14 76 10 65 15 55 C9 42 19 28 33 30 C40 18 56 18 63 29 C78 25 89 36 86 49 C94 62 85 77 72 76 Z',
  tile: 'M25 19 C19 19 16 24 16 30 L16 70 C16 77 20 81 27 81 L73 81 C80 81 84 77 84 70 L84 30 C84 23 80 19 73 19 Z',
  clover: 'M50 14 C60 14 65 22 65 30 C73 25 83 29 86 38 C90 47 85 55 78 58 C82 68 76 78 66 78 C61 78 56 75 53 71 C50 82 42 85 34 80 C28 77 26 70 28 63 C17 64 11 57 13 48 C15 38 23 34 32 35 C30 24 39 14 50 14 Z',
  heart: 'M50 83 C45 83 18 65 14 48 C10 32 20 23 32 23 C40 23 46 27 50 34 C54 27 60 23 68 23 C80 23 90 32 86 48 C82 65 55 83 50 83 Z',
  drop: 'M51 12 C56 12 84 38 84 56 C84 75 70 87 50 87 C30 87 16 75 16 56 C16 40 40 12 51 12 Z',
  oval: 'M28 26 C36 20 64 20 72 26 C83 33 87 42 87 51 C87 66 78 76 66 79 C55 82 42 82 31 78 C19 73 13 64 13 51 C13 40 18 32 28 26 Z',
  triangle: 'M47 16 C50 14 54 15 57 18 L84 65 C89 73 84 80 76 80 L24 80 C16 80 11 73 16 65 L43 18 C44 17 45 16 47 16 Z',
}

const eyeLayouts: Record<BotIdentity, { x: number; y: number; spacing: number; scale: number }> = {
  agent: { x: 50, y: 42, spacing: 16, scale: 1.05 },
  sparkle: { x: 50, y: 50, spacing: 16, scale: 1.05 },
  goal: { x: 50, y: 50, spacing: 15, scale: 1.05 },
  browse: { x: 46, y: 53, spacing: 16, scale: 1.15 },
  skill: { x: 50, y: 50, spacing: 16, scale: 1.05 },
  workspace: { x: 50, y: 51, spacing: 16, scale: 1.05 },
  round: { x: 50, y: 46, spacing: 16, scale: 1.1 },
  cloud: { x: 50, y: 48, spacing: 16, scale: 1.05 },
  tile: { x: 50, y: 46, spacing: 16, scale: 1.05 },
  clover: { x: 50, y: 48, spacing: 16, scale: 1.05 },
  heart: { x: 50, y: 46, spacing: 16, scale: 1.05 },
  drop: { x: 50, y: 50, spacing: 16, scale: 1.05 },
  oval: { x: 50, y: 48, spacing: 16, scale: 1.05 },
  triangle: { x: 50, y: 49, spacing: 16, scale: 1.05 },
}

/**
 * Render a compact, deterministic character avatar for a bot.
 * @param props.name - bot name exposed to assistive technology.
 * @param props.identity - stable character silhouette and expression family.
 * @param props.accent - token-backed color family.
 * @param props.avatar - optional persisted generated image reference.
 * @param props.botId - stable Bot id used by the avatar loader.
 * @param props.loadAvatar - Host-backed loader for the persisted image bytes.
 * @param props.size - completion, roster, or detail avatar size.
 * @param props.status - current bot activity.
 * @returns the character avatar.
 */
export function BotAvatar({ name, identity = 'agent', accent = 'violet', avatar, botId, loadAvatar, size = 'small', status = 'idle' }: {
  name: string
  identity?: BotIdentity | undefined
  accent?: BotAccent | undefined
  avatar?: SharedBotAvatar | undefined
  botId?: string | undefined
  loadAvatar?: ((botId: string, avatar: SharedBotAvatar) => Promise<string>) | undefined
  size?: 'tiny' | 'small' | 'large' | undefined
  status?: BotStatus | undefined
}) {
  const initials = name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'
  const eyes = eyeLayouts[identity]
  const eyeWidth = 5.8 * eyes.scale
  const eyeHeight = 16 * eyes.scale
  const followPointer = (event: MouseEvent<HTMLSpanElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1))
    const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1))
    event.currentTarget.style.setProperty('--eye-x', `${x * 3}px`)
    event.currentTarget.style.setProperty('--eye-y', `${y * 3}px`)
  }
  const resetPointer = (event: MouseEvent<HTMLSpanElement>) => {
    event.currentTarget.style.removeProperty('--eye-x')
    event.currentTarget.style.removeProperty('--eye-y')
  }
  const [avatarURL, setAvatarURL] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    if (avatar === undefined || botId === undefined || loadAvatar === undefined) {
      setAvatarURL(undefined)
      return () => { live = false }
    }
    setAvatarURL(undefined)
    void loadAvatar(botId, avatar).then((url) => {
      if (live) setAvatarURL(url)
    }).catch(() => {
      if (live) setAvatarURL(undefined)
    })
    return () => { live = false }
  }, [avatar, botId, loadAvatar])
  return (
    <span
      className={clsx(css.avatar, size === 'large' ? css.large : size === 'tiny' ? css.tiny : css.small)}
      data-accent={accent}
      data-identity={identity}
      data-status={status}
      data-avatar-loaded={avatarURL === undefined ? 'false' : 'true'}
      role="img"
      aria-label={name || initials}
    >
      {avatarURL === undefined
        ? <span className={css.character} data-character data-identity={identity} data-accent={accent} aria-hidden="true" onMouseMove={followPointer} onMouseLeave={resetPointer}>
          <span className={css.volume}>
            {[4, 3, 2, 1].map(depth => <svg key={depth} viewBox="0 0 100 100" className={css.layer} data-character-part="depth" style={{ transform: `translateZ(${-depth}px) scale(${1 - depth * 0.012})` }}>
              <path d={silhouettes[identity]} />
            </svg>)}
            <svg viewBox="0 0 100 100" className={css.drawing}>
              <path data-character-part="body" d={silhouettes[identity]} />
              <g className={css.gaze}><g className={css.eyes} data-character-part="face">
                <rect data-character-part="eye" x={eyes.x - eyes.spacing / 2 - eyeWidth / 2} y={eyes.y - eyeHeight / 2} width={eyeWidth} height={eyeHeight} rx={eyeWidth / 2} />
                <rect data-character-part="eye" x={eyes.x + eyes.spacing / 2 - eyeWidth / 2} y={eyes.y - eyeHeight / 2} width={eyeWidth} height={eyeHeight} rx={eyeWidth / 2} />
              </g></g>
            </svg>
          </span>
        </span>
        : <img className={css.image} src={avatarURL} alt="" aria-hidden="true" />}
    </span>
  )
}
