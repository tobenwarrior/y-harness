/**
 * Site marks for well-known external link hosts. {@link LinkIconMedium} renders one in
 * the leading glyph seat, so a familiar destination leads with its own mark
 * instead of the generic globe. The marks are the `simple-icons` artwork set
 * (CC0-1.0), pinned by this package's dependency on it; each mark takes the
 * link's `currentColor` rather than the brand fill that set records.
 */
import type { ReactElement } from 'react'
import {
  siAliexpress,
  siApple,
  siBaidu,
  siBilibili,
  siCsdn,
  siDuckduckgo,
  siEbay,
  siFacebook,
  siGithub,
  siGitlab,
  siGoogle,
  siGooglecalendar,
  siGoogledrive,
  siLinear,
  siNotion,
  siInstagram,
  siJuejin,
  siMdnwebdocs,
  siNetflix,
  siNpm,
  siPypi,
  siQq,
  siQuora,
  siReddit,
  siSinaweibo,
  siSpotify,
  siStackoverflow,
  siTaobao,
  siTelegram,
  siTiktok,
  siV2ex,
  siWechat,
  siWhatsapp,
  siWikipedia,
  siX,
  siYcombinator,
  siYoutube,
  siZhihu,
} from 'simple-icons'
import type { SimpleIcon } from 'simple-icons'

/**
 * Host suffix to site mark, covering the developer sites the transcript
 * usually cites plus the mainstream search, video, social, shopping, and
 * reference sites a general audience links. A host matches a suffix when it
 * equals it or is a subdomain of it, and the longest matching suffix wins, so
 * `weixin.qq.com` keeps WeChat while `qq.com` keeps QQ and `gist.github.com`
 * needs no entry of its own.
 */
const SITE_HOSTS: Readonly<Record<string, SimpleIcon>> = {
  'github.com': siGithub,
  'github.io': siGithub,
  'raw.githubusercontent.com': siGithub,
  'gitlab.com': siGitlab,
  'npmjs.com': siNpm,
  'pypi.org': siPypi,
  'stackoverflow.com': siStackoverflow,
  'developer.mozilla.org': siMdnwebdocs,
  'wikipedia.org': siWikipedia,
  'news.ycombinator.com': siYcombinator,
  'youtube.com': siYoutube,
  'youtu.be': siYoutube,
  'x.com': siX,
  'twitter.com': siX,
  'bilibili.com': siBilibili,
  'zhihu.com': siZhihu,
  'juejin.cn': siJuejin,
  'csdn.net': siCsdn,
  'google.com': siGoogle,
  'baidu.com': siBaidu,
  'duckduckgo.com': siDuckduckgo,
  'tiktok.com': siTiktok,
  'netflix.com': siNetflix,
  'spotify.com': siSpotify,
  'facebook.com': siFacebook,
  'instagram.com': siInstagram,
  'reddit.com': siReddit,
  'telegram.org': siTelegram,
  't.me': siTelegram,
  'weixin.qq.com': siWechat,
  'qq.com': siQq,
  'whatsapp.com': siWhatsapp,
  'wa.me': siWhatsapp,
  'weibo.com': siSinaweibo,
  'taobao.com': siTaobao,
  'aliexpress.com': siAliexpress,
  'ebay.com': siEbay,
  'quora.com': siQuora,
  'v2ex.com': siV2ex,
  'apple.com': siApple,
}

/**
 * Slack and Microsoft Teams are hidden from the current `simple-icons` runtime
 * export, although their CC0 Simple Icons artwork remains available. Keep the
 * two small paths local instead of bundling the full Iconify JSON catalogue.
 */
const CONNECTED_APP_MARKS: Readonly<Record<string, Pick<SimpleIcon, 'path'>>> = {
  github: siGithub,
  gitlab: siGitlab,
  google_calendar: siGooglecalendar,
  google_drive: siGoogledrive,
  linear: siLinear,
  notion: siNotion,
  slack: {
    path: 'M5.042 15.165a2.53 2.53 0 0 1-2.52 2.523A2.53 2.53 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52a2.527 2.527 0 0 1 2.521 2.52v6.313A2.53 2.53 0 0 1 8.834 24a2.53 2.53 0 0 1-2.521-2.522zM8.834 5.042a2.53 2.53 0 0 1-2.521-2.52A2.53 2.53 0 0 1 8.834 0a2.53 2.53 0 0 1 2.521 2.522v2.52zm0 1.271a2.53 2.53 0 0 1 2.521 2.521a2.53 2.53 0 0 1-2.521 2.521H2.522A2.53 2.53 0 0 1 0 8.834a2.53 2.53 0 0 1 2.522-2.521zm10.122 2.521a2.53 2.53 0 0 1 2.522-2.521A2.53 2.53 0 0 1 24 8.834a2.53 2.53 0 0 1-2.522 2.521h-2.522zm-1.268 0a2.53 2.53 0 0 1-2.523 2.521a2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.53 2.53 0 0 1 2.523 2.522zm-2.523 10.122a2.53 2.53 0 0 1 2.523 2.522A2.53 2.53 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522zm0-1.268a2.527 2.527 0 0 1-2.52-2.523a2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.53 2.53 0 0 1-2.522 2.523z',
  },
  microsoft_teams: {
    path: 'M20.625 8.127q-.55 0-1.025-.205t-.832-.563t-.563-.832T18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563q.474-.205 1.025-.205q.54 0 1.02.205t.837.563q.358.357.563.837t.205 1.02q0 .55-.205 1.025t-.563.832q-.357.358-.837.563t-1.02.205m0-3.75q-.469 0-.797.328t-.328.797t.328.797t.797.328t.797-.328t.328-.797t-.328-.797t-.797-.328M24 10.002v5.578q0 .774-.293 1.46t-.803 1.194q-.51.51-1.195.803q-.686.293-1.459.293q-.445 0-.908-.105q-.463-.106-.85-.329q-.293.95-.855 1.729t-1.319 1.336t-1.67.861t-1.898.305q-1.148 0-2.162-.398q-1.014-.399-1.805-1.102t-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5q0-.727.275-1.365q.276-.639.75-1.114q.475-.474 1.114-.75q.638-.275 1.365-.275t1.365.275t1.114.75q.474.475.75 1.114q.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113q-.475.475-1.114.75q-.638.276-1.365.276q-.188 0-.375-.024q-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328t.328.797M12.75 2.373q-.41 0-.78.158q-.368.158-.638.434q-.27.275-.428.639q-.158.363-.158.773t.158.78q.159.368.428.638q.27.27.639.428t.779.158t.773-.158q.364-.159.64-.428q.274-.27.433-.639t.158-.779t-.158-.773q-.159-.364-.434-.64q-.275-.275-.639-.433q-.363-.158-.773-.158M6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5q.405.691.985 1.19q.58.497 1.318.779q.738.281 1.582.281q.926 0 1.746-.352q.82-.351 1.436-.966q.615-.616.966-1.43q.352-.815.352-1.752m5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452q.387.146.809.146q.469 0 .879-.176q.41-.175.715-.48q.304-.305.48-.715t.176-.879',
  },
}

/**
 * Resolve the mark named by an external destination.
 * @param href - The link destination; only an absolute http(s) URL can name a host.
 * @returns The matched site mark, or undefined when the host is unknown or not http(s).
 */
function siteIcon(href: string): SimpleIcon | undefined {
  let host: string
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    host = url.hostname.toLowerCase()
  } catch {
    // Not an absolute URL: nothing here can name a host.
    return undefined
  }
  let match: SimpleIcon | undefined
  let matched = 0
  for (const [suffix, icon] of Object.entries(SITE_HOSTS)) {
    if ((host === suffix || host.endsWith(`.${suffix}`)) && suffix.length > matched) {
      match = icon
      matched = suffix.length
    }
  }
  return match
}

/** Props for {@link siteGlyph}: the destination plus the shared icon sizing seat. */
interface SiteGlyphProps {
  /** The link destination; only an absolute http(s) URL can name a host. */
  href: string | undefined
  /** Square edge in px. */
  size: number
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the site mark for a known external destination.
 * @param props - The destination and the icon sizing seat.
 * @returns The site's mark riding currentColor, or undefined for an unknown site.
 */
export function siteGlyph({ href, size, className }: SiteGlyphProps): ReactElement | undefined {
  const icon = href === undefined ? undefined : siteIcon(href)
  if (icon === undefined) return undefined
  return (
    // Simple Icons fill their 24-unit box edge to edge; the -2 inset leaves the
    // same ~8% margin the 20-unit ic_ds_* glyphs draw inside their own box.
    <svg width={size} height={size} className={className} viewBox="-2 -2 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}

/** Props for {@link connectedAppGlyph}: a stable app id and shared icon size. */
export interface ConnectedAppGlyphProps {
  /** Connected-app catalog id, such as `github` or `google_drive`. */
  readonly appId: string
  /** Square edge in px. */
  readonly size: number
  /** Extra class for layout placement. */
  readonly className?: string | undefined
}

/**
 * Render a known connected-app brand mark without using its brand fill.
 *
 * Unknown app ids return undefined so the owning surface can provide a
 * readable name-derived fallback for integrations outside this catalog.
 * @param props - The app id, size, and optional class name.
 * @returns The current-color app mark, or undefined for an unknown app.
 */
export function connectedAppGlyph({ appId, size, className }: ConnectedAppGlyphProps): ReactElement | undefined {
  const icon = CONNECTED_APP_MARKS[appId.toLocaleLowerCase()]
  if (icon === undefined) return undefined
  return (
    <svg width={size} height={size} className={className} viewBox="-2 -2 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}
