import { BrandWordmark, YHarnessLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Y mark with the presentation requested by a non-header host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the shared Y mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <YHarnessLogo size={size} />
}

/**
 * Render the configured display name or official artwork without its independently slotted mark.
 * @returns the display name or official wordmark.
 */
export function OfficialBrandName() {
  const displayName = process.env.DSH_CLIENT_DISPLAY_NAME
  return displayName === undefined ? <BrandWordmark includeMark={false} /> : <span>{displayName}</span>
}
