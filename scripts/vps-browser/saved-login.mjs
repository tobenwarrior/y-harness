/** Send one reviewed website login from a private Chromium execution world. */

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const ORIGIN = new RegExp(`^https://(${HOST_LABEL}(?:\\.${HOST_LABEL})+)(?::([1-9][0-9]{0,4}))?$`, 'u')
const LOCAL_HOST = /\.(?:localhost|local|localdomain)$/u
const LOGIN_TIMEOUT = 14_000

/** Validate the exact public HTTPS origin and destination shown to the owner. */
export function loginDestination(origin, destination) {
  if (typeof origin !== 'string' || typeof destination !== 'string' || destination.length > 4096
    || !/^[\x21-\x7e]+$/u.test(destination) || /[?#\\]/u.test(destination)) return false
  const match = ORIGIN.exec(origin)
  if (match === null || match[1].length > 253 || LOCAL_HOST.test(match[1]) || /\.\d+$/u.test(match[1])
    || !destination.startsWith(`${origin}/`)) return false
  try {
    const url = new URL(destination)
    return url.origin === origin && url.href === destination
  } catch (error) { void error; return false }
}

/**
 * Run in Chromium's isolated world. The opaque marker and form snapshot stay in
 * that document. The page's inputs and event handlers never receive the values.
 */
function websiteLogin(operation, token, origin, destination, values) {
  const previous = globalThis.yharnessLogin
  globalThis.yharnessLogin = undefined
  if (!isSecureContext || window !== window.top || location.protocol !== 'https:' || document.visibilityState !== 'visible'
    || document.forms.length > 32) return null

  function editable(field) {
    return field.name.length > 0 && field.name.length <= 256 && !field.readOnly && !field.matches(':disabled')
      && field.getClientRects().length > 0 && getComputedStyle(field).visibility === 'visible'
  }

  function selectFields(inputs) {
    const codes = inputs.filter(field => field.autocomplete === 'one-time-code')
    if (codes.length > 0) {
      const [code] = codes
      return codes.length === 1 && ['text', 'tel', 'number', 'password'].includes(code.type) && editable(code)
        ? { controls: codes, purpose: 'verification' } : null
    }
    const passwords = inputs.filter(field => field.type === 'password')
    if (passwords.length === 0 || passwords.length > 2 || passwords.some(field => !editable(field))) return null
    const signup = passwords.every(field => field.autocomplete === 'new-password')
    if (!signup && (passwords.length !== 1 || passwords[0].autocomplete !== 'current-password')) return null
    const identifiers = inputs.filter(field => ['email', 'text', 'tel'].includes(field.type)
      && (field.autocomplete === 'username' || (signup && field.autocomplete === 'email')) && editable(field))
    if (identifiers.length !== 1) return null
    return { controls: [...identifiers, ...passwords], purpose: signup ? 'signup' : undefined }
  }

  function candidate(form) {
    const target = form.target || document.querySelector('base[target]')?.target || '_self'
    const action = new URL(form.action, document.baseURI)
    if (form.method !== 'post' || target.toLowerCase() !== '_self' || form.enctype !== 'application/x-www-form-urlencoded'
      || action.origin !== location.origin || /[?#]/u.test(action.href) || form.elements.length > 32) return null
    const inputs = [...form.elements].filter(field => field instanceof HTMLInputElement)
    const selection = selectFields(inputs)
    if (selection === null) return null
    const { controls, purpose } = selection
    const names = new Set(controls.map(field => field.name))
    if (names.size !== controls.length) return null
    const hidden = new URLSearchParams()
    for (const field of form.elements) {
      if (controls.includes(field) || !field.name || field.matches(':disabled')) continue
      if (!(field instanceof HTMLInputElement) || field.type !== 'hidden' || field.name.length > 256 || field.value.length > 8192
        || names.has(field.name) || hidden.has(field.name)) return null
      hidden.append(field.name, field.value)
    }
    return { form, controls, purpose, action: action.href, hidden: hidden.toString() }
  }

  const candidates = [...document.forms].map(candidate).filter(value => value !== null)
  if (candidates.length !== 1) return null
  const [{ form, controls, purpose, action, hidden }] = candidates
  if (hidden.length > 48_000) return null
  if (operation === 'capture') {
    globalThis.yharnessLogin = {
      token, form, controls, purpose, action, hidden, location: location.href,
      names: controls.map(field => field.name),
    }
    return { origin: location.origin, destination: action, ...(purpose === undefined ? {} : { purpose }) }
  }
  const verification = purpose === 'verification'
  if (previous?.token !== token || previous.form !== form || previous.purpose !== purpose
    || previous.controls.length !== controls.length
    || controls.some((field, index) => previous.controls[index] !== field || previous.names[index] !== field.name)
    || previous.action !== action || previous.hidden !== hidden || previous.location !== location.href
    || origin !== location.origin || destination !== action || values.length !== (verification ? 1 : 2)) return null

  const payload = new URLSearchParams(hidden)
  for (const [index, field] of controls.entries()) {
    const value = index === 0 ? values[0] : values[1]
    if ((verification || (purpose === 'signup' && index > 0)) && (
      (field.minLength >= 0 && value.length < field.minLength) || (field.maxLength >= 0 && value.length > field.maxLength)
    )) return null
    payload.set(field.name, value)
  }
  if (payload.toString().length > 65_536) return null
  return fetch(destination, {
    method: 'POST', body: payload, mode: 'same-origin', credentials: 'same-origin',
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(7000),
  }).then(async response => {
    await response.body?.cancel()
    return response.ok || response.type === 'opaqueredirect' ? 'submitted' : 'needs-owner'
  }, () => 'needs-owner')
}

/** Build fixed login operations on the same private pipe used for this Browser. */
export function savedLoginPage(command, close) {
  const evaluate = async (executionContextId, args) => {
    const response = await command('Runtime.callFunctionOn', {
      functionDeclaration: websiteLogin.toString(), executionContextId,
      arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true,
    })
    return response.exceptionDetails === undefined ? response.result?.value : undefined
  }
  const topFrame = async () => (await command('Page.getFrameTree')).frameTree.frame
  const submit = async (reviewed, values, signal) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(LOGIN_TIMEOUT)])
    bounded.throwIfAborted()
    const abort = () => { void close().catch(error => { void error }) }
    bounded.addEventListener('abort', abort, { once: true })
    try {
      const frame = await topFrame()
      if (frame.id !== reviewed.frame || frame.loaderId !== reviewed.loader || new URL(frame.url).origin !== reviewed.origin) {
        return 'needs-owner'
      }
      await command('Network.setBypassServiceWorker', { bypass: true })
      let result
      try {
        bounded.throwIfAborted()
        result = await evaluate(reviewed.executionContextId, [
          'submit', reviewed.token, reviewed.origin, reviewed.destination, values,
        ])
      } finally {
        if (!bounded.aborted) await command('Network.setBypassServiceWorker', { bypass: false })
      }
      if (result !== 'submitted') return 'needs-owner'
      await command('Page.reload', { loaderId: reviewed.loader }).catch(error => { void error })
      return 'submitted'
    } finally {
      bounded.removeEventListener('abort', abort)
    }
  }
  return {
    async captureLogin(token) {
      const frame = await topFrame()
      if (typeof frame.id !== 'string' || typeof frame.loaderId !== 'string' || frame.loaderId.length === 0
        || typeof frame.url !== 'string' || !frame.url.startsWith('https://')) throw new Error('Login unavailable')
      const { executionContextId } = await command('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'yharness-vault' })
      const details = await evaluate(executionContextId, ['capture', token])
      if (!loginDestination(details?.origin, details?.destination) || new URL(frame.url).origin !== details.origin) {
        throw new Error('Login unavailable')
      }
      return { token, frame: frame.id, loader: frame.loaderId, executionContextId, ...details }
    },
    async submitLogin(reviewed, username, password, signal) {
      return reviewed.purpose === 'verification' ? 'needs-owner' : await submit(reviewed, [username, password], signal)
    },
    async submitVerification(reviewed, code, signal) {
      return reviewed.purpose !== 'verification' ? 'needs-owner' : await submit(reviewed, [code], signal)
    },
  }
}
