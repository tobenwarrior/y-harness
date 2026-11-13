/** Script-free controls for the desktop-owned Cloud workspace. */
import type { DesktopMessages } from './locale.ts'

const CONTROL_ORIGIN = 'https://workspace.invalid'

/** Connection state rendered by the workspace controls. */
export type CloudWorkspaceStatus = 'setup' | 'connecting' | 'online' | 'offline'

type CloudAction = { type: 'mac' | 'configure' | 'retry' | 'vault' } | { type: 'connect'; target: string }

/**
 * Decode a navigation initiated by the trusted workspace controls.
 * @param destination - navigation URL from the controls view.
 * @returns the requested action, if supported.
 */
export function cloudAction(destination: string): CloudAction | undefined {
  const url = new URL(destination)
  if (url.origin !== CONTROL_ORIGIN || url.username || url.password) return undefined
  switch (url.pathname) {
    case '/mac': return { type: 'mac' }
    case '/configure': return { type: 'configure' }
    case '/retry': return { type: 'retry' }
    case '/vault': return { type: 'vault' }
    case '/connect': return { type: 'connect', target: url.searchParams.get('target')?.trim() ?? '' }
    default: return undefined
  }
}

/**
 * Confine Cloud requests to the authenticated loopback forward, including its WebSocket endpoint.
 * @param origin - loopback HTTP origin owned by this connection.
 * @param destination - request URL from the isolated remote view.
 * @returns whether the request can reach the forward.
 */
export function cloudRequestAllowed(origin: string, destination: string): boolean {
  const url = new URL(destination)
  if (url.username || url.password) return false
  return url.origin === origin || (url.protocol === 'ws:' && `http://${url.host}` === origin)
}

/**
 * Convert the VPS sign-in response into a host-only Electron session cookie.
 * @param origin - private loopback origin for this connection.
 * @param response - response to the one-time sign-in URL without following its redirect.
 * @returns the isolated browser cookie when sign-in succeeded.
 */
export function cloudSignInCookie(origin: string, response: Pick<Response, 'status' | 'headers'>): Electron.CookiesSetDetails | undefined {
  const location = response.headers.get('location')
  if (response.status !== 303 || location === null || new URL(location, origin).href !== origin + '/') return undefined
  const header = response.headers.get('set-cookie')
  const session = header?.match(/^(dsh-auth-[A-Za-z0-9_-]{43})=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+);/u)
  const name = session?.[1]
  const value = session?.[2]
  if (name === undefined || value === undefined) return undefined
  return { url: origin, name, value, path: '/', httpOnly: true, sameSite: 'strict' }
}

const macIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="9" rx="1.5"/><path d="M2.5 16h15"/></svg>'
const cloudIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 14.5a3.5 3.5 0 1 1 .5-7 4.1 4.1 0 0 1 7.9 1.1 3 3 0 0 1-.5 5.9Z"/></svg>'
const settingsIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 14h12"/><circle cx="8" cy="6" r="2"/><circle cx="12" cy="14" r="2"/></svg>'
const vaultIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="8.5" width="12" height="8" rx="2"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5M10 12v1.5"/></svg>'

function html(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * Render the native workspace bar and its setup and reconnect states.
 * @param messages - resolved Desktop dictionary.
 * @param status - connection state.
 * @param invalidTarget - whether the submitted SSH name needs correction.
 * @returns a local document URL with no script or remote resources.
 */
export function cloudDocument(messages: DesktopMessages, status: CloudWorkspaceStatus, invalidTarget = false): string {
  const t = (key: keyof DesktopMessages): string => html(messages[key])
  const connected = status === 'online'
  const title = status === 'setup' ? 'cloudSetupTitle' : status === 'offline' ? 'cloudOffline' : 'cloudConnecting'
  const state = status === 'online' ? 'cloudConnected' : status === 'setup' ? 'cloudSetup' : title
  const body = connected ? '' : `
    <main><section>
      <div class="mark">${cloudIcon}</div>
      <h1>${t(title)}</h1>
      <p>${t(status === 'offline' ? 'cloudOfflineHelp' : 'cloudWorkspaceHelp')}</p>
      ${status === 'setup' ? `
        <form method="get" action="${CONTROL_ORIGIN}/connect">
          <label for="target">${t('cloudTarget')}</label>
          <input id="target" name="target" maxlength="128" required autocomplete="off" spellcheck="false" aria-invalid="${invalidTarget}">
          ${invalidTarget ? `<p class="error" role="alert">${t('cloudInvalidTarget')}</p>` : ''}
          <button type="submit">${t('cloudConnect')}</button>
        </form>` : ''}
      ${status === 'offline' ? `
        <div class="actions"><a class="primary" href="${CONTROL_ORIGIN}/retry">${t('cloudRetry')}</a>
        <a href="${CONTROL_ORIGIN}/configure">${t('cloudChangeServer')}</a></div>` : ''}
    </section></main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
    <html lang="en"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${CONTROL_ORIGIN}; base-uri 'none'">
    <title>${t('cloudWorkspace')}</title>
    <style>
      :root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; --bg: #f6f6f7; --panel: #fff; --ink: #26262b; --muted: #62646f; --line: #dedee3; --accent: #24644f; --button: #25252b; --button-ink: #fff; --error: #a42932 }
      @media (prefers-color-scheme: dark) { :root { --bg: #1b1b1e; --panel: #232326; --ink: #f0f0f2; --muted: #aaaab2; --line: #36363c; --accent: #72c6a7; --button: #efeff2; --button-ink: #222226; --error: #ff9199 } }
      * { box-sizing: border-box }
      body { margin: 0; background: var(--bg); color: var(--ink) }
      header { height: 50px; padding: 0 16px 0 86px; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; -webkit-app-region: drag }
      nav { grid-column: 2; display: flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 9px; -webkit-app-region: no-drag }
      nav > * { min-width: 67px; height: 26px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; border-radius: 6px }
      nav a, .actions a { text-decoration: none; color: var(--muted) }
      nav a:hover, nav [aria-current] { background: var(--panel); color: var(--ink) }
      nav [aria-current] { box-shadow: 0 0 0 1px var(--line) }
      svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; flex: none }
      .status { justify-self: end; display: flex; align-items: center; gap: 8px; color: var(--muted); white-space: nowrap }
      .status i { border-radius: 50%; width: 6px; height: 6px; background: var(--muted) }
      .status.online i { background: var(--accent) }
      .settings { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: inherit; -webkit-app-region: no-drag }
      .settings:hover { background: var(--panel); color: var(--ink) }
      .settings circle { fill: var(--bg) }
      main { min-height: calc(100vh - 50px); padding: 32px; display: grid; place-items: center }
      section { width: min(100%, 340px); text-align: center }
      .mark { width: 50px; height: 50px; display: grid; place-items: center; margin: 0 auto 17px; border: 1px solid var(--line); background: var(--panel); border-radius: 15px; color: var(--accent) }
      .mark svg { width: 26px; height: 26px }
      h1 { margin: 0; font-size: 21px; font-weight: 600; letter-spacing: -.025em }
      p { margin: 9px 0 0; line-height: 1.6; color: var(--muted) }
      form { display: grid; gap: 8px; text-align: left; margin-top: 23px }
      input, button, .actions a { font: inherit; min-height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px }
      input { color: var(--ink); background: var(--panel) }
      button, .actions .primary { color: var(--button-ink); background: var(--button); border-color: transparent; cursor: pointer }
      button { margin-top: 5px }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
      .error { color: var(--error); margin: 0 }
      .actions { display: flex; justify-content: center; gap: 8px; margin-top: 20px }
      .actions a { display: inline-flex; align-items: center }
    </style>
    <header>
      <nav aria-label="${t('cloudWorkspace')}">
        <a href="${CONTROL_ORIGIN}/mac">${macIcon}<span>${t('cloudMac')}</span></a>
        <span aria-current="page">${cloudIcon}<span>${t('cloudLabel')}</span></span>
      </nav>
      <div class="status ${status}"><i></i>${t(state)}
        ${connected ? `<a class="settings" aria-label="${t('cloudVault')}" title="${t('cloudVault')}" href="${CONTROL_ORIGIN}/vault">${vaultIcon}</a>
          <a class="settings" aria-label="${t('cloudChangeServer')}" title="${t('cloudChangeServer')}" href="${CONTROL_ORIGIN}/configure">${settingsIcon}</a>` : ''}
      </div>
    </header>${body}
  </html>`)}`
}
