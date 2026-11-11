import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@yharness/client-store'
import { ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE } from './icons/index.tsx'
import type { IconProps } from './icons/props.ts'
import {
  BrowseOutlineArtwork, ChatLinesOutlineArtwork, FolderCloseArtwork,
} from './icons/shared-artwork.tsx'
import { IconSidebarBotsOutlineMedium, IconSidebarBotsOutlineRegular } from './icons/sidebar-artwork.tsx'

/** Reference domains with distinct composer and transcript glyphs. */
export type ReferenceIconKind = 'session' | 'file' | 'folder' | 'bot'

/** Display inputs for a source-owned inline reference icon. */
export interface InlineReferenceIconProps {
  readonly reference: string
  readonly label: string
}

/**
 * Bind an inline icon to its live display data.
 * @param source - observable state owned by the reference provider.
 * @param select - read the icon's value by reference, with stable identity until it changes.
 * @param Icon - presentation component receiving the selected value.
 * @returns an inline icon that updates when its selected value changes.
 */
export function bindInlineReferenceIcon<State, Value>(
  source: ObservableSnapshot<State>,
  select: (state: State, reference: string) => Value,
  Icon: ComponentType<InlineReferenceIconProps & { readonly value: Value }>,
): ComponentType<InlineReferenceIconProps> {
  const subscribe = (listener: () => void) => source.subscribe(listener)
  return function BoundReferenceIcon(props) {
    const snapshot = () => select(source.getSnapshot(), props.reference)
    const value = useSyncExternalStore(subscribe, snapshot, snapshot)
    return <Icon {...props} value={value} />
  }
}

/** Props shared by inline reference glyphs. */
export interface ReferenceIconProps extends IconProps {
  kind: ReferenceIconKind
}

interface WeightedReferenceIconProps extends ReferenceIconProps {
  strokeWidth: number
}

/**
 * Render the icon that identifies one inline reference domain.
 * @param props - Reference kind, optional size, and optional CSS class.
 * @returns The corresponding decorative current-color SVG glyph.
 */
function ReferenceIconArtwork({ kind, size = 16, className, strokeWidth }: WeightedReferenceIconProps): ReactNode {
  switch (kind) {
    case 'session': return <ChatLinesOutlineArtwork size={size} className={className} strokeWidth={strokeWidth} />
    case 'file': return <BrowseOutlineArtwork size={size} className={className} strokeWidth={strokeWidth} />
    case 'folder': return <FolderCloseArtwork size={size} className={className} strokeWidth={strokeWidth} />
    case 'bot': return strokeWidth === ICON_REGULAR_STROKE
      ? <IconSidebarBotsOutlineRegular size={size} className={className} />
      : <IconSidebarBotsOutlineMedium size={size} className={className} />
  }
}

/**
 * Render a regular one-pixel reference icon.
 * @param props - Reference kind, size, and optional class.
 * @returns The regular decorative reference glyph.
 */
export function ReferenceIconRegular(props: ReferenceIconProps): ReactNode {
  return <ReferenceIconArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render a medium 1.3px reference icon.
 * @param props - Reference kind, size, and optional class.
 * @returns The medium decorative reference glyph.
 */
export function ReferenceIconMedium(props: ReferenceIconProps): ReactNode {
  return <ReferenceIconArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}
