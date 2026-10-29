import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { BotAvatar as SharedBotAvatar } from '@deepseek-ai/dsh-bots/client'
import portraits from './bot-portraits.png'
import css from './BotAvatar.module.css'
import type { BotAccent, BotIdentity } from './types.ts'

/**
 * Render a compact, deterministic character avatar for a bot.
 * @param props.name - bot name exposed to assistive technology.
 * @param props.identity - stable character silhouette and expression family.
 * @param props.accent - token-backed color family.
 * @param props.avatar - optional persisted generated image reference.
 * @param props.botId - stable Bot id used by the avatar loader.
 * @param props.loadAvatar - Host-backed loader for the persisted image bytes.
 * @param props.size - roster or detail avatar size.
 * @returns the character avatar.
 */
export function BotAvatar({ name, identity = 'agent', accent = 'violet', avatar, botId, loadAvatar, size = 'small' }: {
  name: string
  identity?: BotIdentity | undefined
  accent?: BotAccent | undefined
  avatar?: SharedBotAvatar | undefined
  botId?: string | undefined
  loadAvatar?: ((botId: string, avatar: SharedBotAvatar) => Promise<string>) | undefined
  size?: 'small' | 'large' | undefined
}) {
  const initials = name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'
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
      className={clsx(css.avatar, size === 'large' ? css.large : css.small)}
      data-accent={accent}
      data-identity={identity}
      data-avatar-loaded={avatarURL === undefined ? 'false' : 'true'}
      role="img"
      aria-label={name || initials}
    >
      {avatarURL === undefined
        ? <span className={css.portrait} style={{ backgroundImage: `url("${portraits}")` }} aria-hidden="true" />
        : <img className={css.image} src={avatarURL} alt="" aria-hidden="true" />}
    </span>
  )
}
