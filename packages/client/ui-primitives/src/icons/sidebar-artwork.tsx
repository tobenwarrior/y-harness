/** Hand-drawn marks for the shell's primary navigation on a shared 16-unit grid. */
import type { ReactNode } from 'react'
import type { IconProps } from './props.ts'
import { ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE } from './stroke.ts'

interface ArtworkProps extends IconProps {
  readonly children: ReactNode
  readonly strokeWidth: number
}

function Artwork({ size = 16, className, children, strokeWidth }: ArtworkProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

function codeArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="m5.65 3.7-3.1 4.3 3.1 4.3" /><path d="m10.35 3.7 3.1 4.3-3.1 4.3" /><path d="m8.9 2.65-1.8 10.7" /><circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none" /></Artwork>
}

/** Code mode: paired brackets and a precise center slash at regular weight. */
export function IconSidebarCodeOutlineRegular(props: IconProps): ReactNode { return codeArtwork(props, ICON_REGULAR_STROKE) }

/** Code mode: paired brackets and a precise center slash at medium weight. */
export function IconSidebarCodeOutlineMedium(props: IconProps): ReactNode { return codeArtwork(props, ICON_MEDIUM_STROKE) }

function botsArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M8 3.45V1.8" /><circle cx="8" cy="1.45" r=".75" fill="currentColor" stroke="none" /><rect x="4.25" y="3.45" width="7.5" height="6.55" rx="2.1" /><circle cx="6.75" cy="6.5" r=".7" fill="currentColor" stroke="none" /><circle cx="9.25" cy="6.5" r=".7" fill="currentColor" stroke="none" /><path d="M6.2 8.15h3.6" /><path d="m4.5 8.7-1.65 1.6M11.5 8.7l1.65 1.6" /><circle cx="2.35" cy="11.15" r="1.05" /><circle cx="13.65" cy="11.15" r="1.05" /></Artwork>
}

/** Bots mode: a bot face connected to two small worker nodes at regular weight. */
export function IconSidebarBotsOutlineRegular(props: IconProps): ReactNode { return botsArtwork(props, ICON_REGULAR_STROKE) }

/** Bots mode: a bot face connected to two small worker nodes at medium weight. */
export function IconSidebarBotsOutlineMedium(props: IconProps): ReactNode { return botsArtwork(props, ICON_MEDIUM_STROKE) }

function pluginsArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><rect x="5.05" y="5.05" width="5.9" height="5.9" rx="1.65" /><path d="M8 2.1v2.95M8 10.95v2.95M2.1 8h2.95M10.95 8h2.95" /><path d="m6.55 8 1.45-1.45L9.45 8 8 9.45 6.55 8Z" fill="currentColor" stroke="none" /></Artwork>
}

/** Plugins: a modular hub with four deliberate attachment points at regular weight. */
export function IconSidebarPluginsOutlineRegular(props: IconProps): ReactNode { return pluginsArtwork(props, ICON_REGULAR_STROKE) }

/** Plugins: a modular hub with four deliberate attachment points at medium weight. */
export function IconSidebarPluginsOutlineMedium(props: IconProps): ReactNode { return pluginsArtwork(props, ICON_MEDIUM_STROKE) }

function skillsArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M3.15 2.35h6.7l3 3v8.3h-9.7V2.35Z" /><path d="M9.85 2.35v3h3" /><path d="m5.25 9 1.55 1.55L10.1 7.25" /><path d="M5.25 12h4.9" /></Artwork>
}

/** Skills: a folded field guide with a small completion spark at regular weight. */
export function IconSidebarSkillsOutlineRegular(props: IconProps): ReactNode { return skillsArtwork(props, ICON_REGULAR_STROKE) }

/** Skills: a folded field guide with a small completion spark at medium weight. */
export function IconSidebarSkillsOutlineMedium(props: IconProps): ReactNode { return skillsArtwork(props, ICON_MEDIUM_STROKE) }

function automationArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M4.2 5.15a4.55 4.55 0 1 1-.65 5.4" /><path d="M3.8 2.9v2.8H1" /><path d="M11.8 10.85a4.55 4.55 0 0 1-5.1 1.05" /><path d="m7.05 6.25 3 1.75-3 1.75V6.25Z" fill="currentColor" stroke="none" /></Artwork>
}

/** Automation: a looping route with a clear play cue at regular weight. */
export function IconSidebarAutomationOutlineRegular(props: IconProps): ReactNode { return automationArtwork(props, ICON_REGULAR_STROKE) }

/** Automation: a looping route with a clear play cue at medium weight. */
export function IconSidebarAutomationOutlineMedium(props: IconProps): ReactNode { return automationArtwork(props, ICON_MEDIUM_STROKE) }

function codeMapArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="m2.45 3.55 3.45-1.3 3.7 1.35 3.95-1.3v10.15l-3.95 1.3-3.7-1.35-3.45 1.3V3.55Z" /><path d="M5.9 2.25V12.4M9.6 3.6v10.15" /><path d="m4.1 7.25 2 1.15 3.45-2.25 2.25 1.15" /><circle cx="4.1" cy="7.25" r=".85" fill="currentColor" stroke="none" /><circle cx="9.55" cy="6.15" r=".85" fill="currentColor" stroke="none" /><circle cx="11.8" cy="7.3" r=".85" fill="currentColor" stroke="none" /></Artwork>
}

/** Code map: a folded map whose route connects three code nodes at regular weight. */
export function IconSidebarCodeMapOutlineRegular(props: IconProps): ReactNode { return codeMapArtwork(props, ICON_REGULAR_STROKE) }

/** Code map: a folded map whose route connects three code nodes at medium weight. */
export function IconSidebarCodeMapOutlineMedium(props: IconProps): ReactNode { return codeMapArtwork(props, ICON_MEDIUM_STROKE) }

function newSessionArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M3.2 3.15h7.05a2.55 2.55 0 0 1 2.55 2.55v3.3a2.55 2.55 0 0 1-2.55 2.55H7l-2.4 1.7.35-1.7H3.2A2.55 2.55 0 0 1 .65 9V5.7A2.55 2.55 0 0 1 3.2 3.15Z" /><path d="M9.8 5.5v3.7M7.95 7.35h3.7" /></Artwork>
}

/** New Session: a conversation tile with a small creation spark at regular weight. */
export function IconSidebarNewSessionOutlineRegular(props: IconProps): ReactNode { return newSessionArtwork(props, ICON_REGULAR_STROKE) }

/** New Session: a conversation tile with a small creation spark at medium weight. */
export function IconSidebarNewSessionOutlineMedium(props: IconProps): ReactNode { return newSessionArtwork(props, ICON_MEDIUM_STROKE) }

function collapseArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><rect x="1.65" y="2.05" width="12.7" height="11.9" rx="2.05" /><path d="M5.45 2.2v11.6" /><path d="m10.5 5.55-2.25 2.45 2.25 2.45" /></Artwork>
}

/** Sidebar collapse: a framed rail with an inward-facing chevron at regular weight. */
export function IconSidebarCollapseOutlineRegular(props: IconProps): ReactNode { return collapseArtwork(props, ICON_REGULAR_STROKE) }

/** Sidebar collapse: a framed rail with an inward-facing chevron at medium weight. */
export function IconSidebarCollapseOutlineMedium(props: IconProps): ReactNode { return collapseArtwork(props, ICON_MEDIUM_STROKE) }

function searchArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><circle cx="6.35" cy="6.35" r="4.05" /><path d="m9.25 9.25 4.15 4.15" /><circle cx="6.35" cy="6.35" r=".7" fill="currentColor" stroke="none" /></Artwork>
}

/** Search: a tuned lens with a centered point at regular weight. */
export function IconSidebarSearchOutlineRegular(props: IconProps): ReactNode { return searchArtwork(props, ICON_REGULAR_STROKE) }

/** Search: a tuned lens with a centered point at medium weight. */
export function IconSidebarSearchOutlineMedium(props: IconProps): ReactNode { return searchArtwork(props, ICON_MEDIUM_STROKE) }

function filterArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M2.15 3.05h11.7L9.35 7.9v4.45l-2.7 1.45V7.9L2.15 3.05Z" /><path d="M5.05 4.85h5.9" /></Artwork>
}

/** View filters: a compact funnel with a deliberate inset ridge at regular weight. */
export function IconSidebarFilterOutlineRegular(props: IconProps): ReactNode { return filterArtwork(props, ICON_REGULAR_STROKE) }

/** View filters: a compact funnel with a deliberate inset ridge at medium weight. */
export function IconSidebarFilterOutlineMedium(props: IconProps): ReactNode { return filterArtwork(props, ICON_MEDIUM_STROKE) }

function workspaceFolderArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M2.2 5.05V3.65c0-.63.5-1.13 1.13-1.13h3.05l1.2 1.42h5.1c.63 0 1.13.5 1.13 1.13v.2" /><path d="M2.2 5.05h11.6l-1.18 6.03a1.43 1.43 0 0 1-1.4 1.16H3.78a1.43 1.43 0 0 1-1.4-1.16L1.4 5.05h.8Z" /></Artwork>
}

/** Workspace folder: a tabbed, softly rounded container at regular weight. */
export function IconSidebarWorkspaceFolderOutlineRegular(props: IconProps): ReactNode {
  return workspaceFolderArtwork(props, ICON_REGULAR_STROKE)
}

/** Workspace folder: a tabbed, softly rounded container at medium weight. */
export function IconSidebarWorkspaceFolderOutlineMedium(props: IconProps): ReactNode {
  return workspaceFolderArtwork(props, ICON_MEDIUM_STROKE)
}

function workspaceFolderOpenArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M2.2 5.55V3.65c0-.63.5-1.13 1.13-1.13h3.05l1.2 1.42h4.05" /><path d="m2.2 5.55 2.08-1.05h9.3l-1.57 6.46a1.43 1.43 0 0 1-1.38 1.1H3.8a1.43 1.43 0 0 1-1.38-1.1L1.4 5.55h.8Z" /></Artwork>
}

/** Expanded workspace folder: the same tab geometry with a lifted front edge at regular weight. */
export function IconSidebarWorkspaceFolderOpenOutlineRegular(props: IconProps): ReactNode {
  return workspaceFolderOpenArtwork(props, ICON_REGULAR_STROKE)
}

/** Expanded workspace folder: the same tab geometry with a lifted front edge at medium weight. */
export function IconSidebarWorkspaceFolderOpenOutlineMedium(props: IconProps): ReactNode {
  return workspaceFolderOpenArtwork(props, ICON_MEDIUM_STROKE)
}

function workspaceAddArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M1.65 5.25V3.8c0-.58.47-1.05 1.05-1.05h2.85l1.18 1.38h3.85c.58 0 1.05.47 1.05 1.05v.16" /><path d="M1.65 5.25h8.1l-.8 4.33a1.4 1.4 0 0 1-1.38 1.15H3.2a1.4 1.4 0 0 1-1.38-1.15L1.05 5.25h.6Z" /><path d="M12.35 9.15v4.2M10.25 11.25h4.2" /></Artwork>
}

/** Add workspace: a folder silhouette paired with a crisp creation mark at regular weight. */
export function IconSidebarWorkspaceAddOutlineRegular(props: IconProps): ReactNode {
  return workspaceAddArtwork(props, ICON_REGULAR_STROKE)
}

/** Add workspace: a folder silhouette paired with a crisp creation mark at medium weight. */
export function IconSidebarWorkspaceAddOutlineMedium(props: IconProps): ReactNode { return workspaceAddArtwork(props, ICON_MEDIUM_STROKE) }

function botAddArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="M6.45 3.25V1.8" /><circle cx="6.45" cy="1.45" r=".65" fill="currentColor" stroke="none" /><rect x="2.35" y="3.25" width="8.2" height="6.8" rx="2" /><circle cx="5.1" cy="6.2" r=".62" fill="currentColor" stroke="none" /><circle cx="7.8" cy="6.2" r=".62" fill="currentColor" stroke="none" /><path d="M4.9 8h3.1M12.3 9.25v4.2M10.2 11.35h4.2" /></Artwork>
}

/** Add bot: a small agent face with a separate creation cue at regular weight. */
export function IconSidebarBotAddOutlineRegular(props: IconProps): ReactNode { return botAddArtwork(props, ICON_REGULAR_STROKE) }

/** Add bot: a small agent face with a separate creation cue at medium weight. */
export function IconSidebarBotAddOutlineMedium(props: IconProps): ReactNode { return botAddArtwork(props, ICON_MEDIUM_STROKE) }

function settingsArtwork(props: IconProps, strokeWidth: number): ReactNode {
  return <Artwork {...props} strokeWidth={strokeWidth}><path d="m8 2.15 1.28.8 1.5-.15.68 1.38 1.35.7-.18 1.5.82 1.25-.82 1.25.18 1.5-1.35.7-.68 1.38-1.5-.15-1.28.8-1.28-.8-1.5.15-.68-1.38-1.35-.7.18-1.5L2.55 8l.82-1.25-.18-1.5 1.35-.7.68-1.38 1.5.15L8 2.15Z" /><circle cx="8" cy="8" r="2.05" /><path d="M8 6.95v2.1M6.95 8h2.1" /></Artwork>
}

/** Settings: a compact control dial with a stable center at regular weight. */
export function IconSidebarSettingsOutlineRegular(props: IconProps): ReactNode { return settingsArtwork(props, ICON_REGULAR_STROKE) }

/** Settings: a compact control dial with a stable center at medium weight. */
export function IconSidebarSettingsOutlineMedium(props: IconProps): ReactNode { return settingsArtwork(props, ICON_MEDIUM_STROKE) }
