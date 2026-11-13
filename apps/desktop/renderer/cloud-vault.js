/** The shell-owned form clears secret fields before each write-only request. */
const api = window.yhCloudVault
const element = id => document.getElementById(id)
const main = document.querySelector('main')
const management = element('management')
const apiKeysPanel = element('api-keys-panel')
const websitesPanel = element('websites-panel')
const service = element('service')
const secretList = element('secrets')
const editor = element('editor')
const nameInput = element('name')
const valueInput = element('value')
const request = element('request')
const loginUse = element('login-use')
const requestEditor = element('request-editor')
const requestValue = element('request-value')
const requestOutcome = element('request-outcome')
const loginUseOriginValue = element('login-use-origin')
const loginUseDestinationValue = element('login-use-destination')
const loginChoice = element('login-choice')
const loginUseEmpty = element('login-use-empty')
const loginUseApprove = element('login-use-approve')
const loginUseDecline = element('login-use-decline')
const loginUseOutcome = element('login-use-outcome')
const confirmation = element('confirmation')
const notice = element('notice')
const websitesNotice = element('websites-notice')
const loginList = element('logins')
const loginEditor = element('login-editor')
const loginOriginInput = element('login-origin')
const loginLabelInput = element('login-label')
const loginUsernameInput = element('login-username')
const loginPasswordInput = element('login-password')

let messages
let mode
let requestId
let requestState
let loginUseLogins = []
let loginUseReady = false
let services = []
let logins = []
let editing
let editingLogin
let revoking
let removingLogin
let busy = false
let ready = false
let websitesReady = false
let activeSection = 'api-keys'

function setNotice(key, tone = '') {
  notice.textContent = key === undefined ? '' : messages[key]
  notice.dataset.tone = tone
}

function setWebsitesNotice(key, tone = '') {
  websitesNotice.textContent = key === undefined ? '' : messages[key]
  websitesNotice.dataset.tone = tone
}

function setRequestOutcome(key, tone = '') {
  requestOutcome.textContent = key === undefined ? '' : messages[key]
  requestOutcome.dataset.tone = tone
}

function setLoginUseOutcome(key, tone = '') {
  loginUseOutcome.textContent = key === undefined ? '' : messages[key]
  loginUseOutcome.dataset.tone = tone
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRequestMode(value) {
  return record(value) && Object.keys(value).length === 2 && value.kind === 'request'
    && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)
}

function validLoginUseMode(value) {
  return record(value) && Object.keys(value).length === 2 && value.kind === 'login-use'
    && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)
}

function loginUseOrigin(value) {
  if (typeof value !== 'string' || value.trim() !== value) return
  let url
  try { url = new URL(value) }
  catch { return }
  const labels = url.hostname.split('.')
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '' || url.origin !== value || labels.length < 2
    || labels.at(-1)?.match(/^\d+$/u) || /(?:^|\.)(?:local|localhost|localdomain)$/u.test(url.hostname)) return
  return value
}

function loginUseDestination(value, origin) {
  if (typeof value !== 'string' || value.trim() !== value || origin === undefined
    || !/^[\x21-\x7e]+$/.test(value) || /[?#\\]/u.test(value) || !value.startsWith(`${origin}/`)) return
  let url
  try { url = new URL(value) }
  catch { return }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.origin !== origin
    || url.search !== '' || url.hash !== '' || url.href !== value) return
  return value
}

function loginUseMetadata(value) {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.request)) return
  const item = value.request
  if (Object.keys(item).length !== 4 || typeof item.id !== 'string' || item.id !== requestId) return
  const origin = loginUseOrigin(item.origin)
  const destination = loginUseDestination(item.destination, origin)
  if (origin === undefined || destination === undefined || !Array.isArray(item.logins) || item.logins.length > 64) return
  const ids = new Set()
  const logins = []
  for (const login of item.logins) {
    if (!record(login) || Object.keys(login).length !== 3 || typeof login.id !== 'string'
      || !/^[a-f0-9]{32}$/.test(login.id) || typeof login.label !== 'string'
      || login.label.trim() !== login.label || login.label.length === 0 || [...login.label].length > 80
      || typeof login.generation !== 'string' || !/^[a-f0-9]{64}$/.test(login.generation)
      || ids.has(login.id)) return
    ids.add(login.id)
    logins.push({ id: login.id, label: login.label, generation: login.generation })
  }
  return { id: item.id, origin, destination, logins }
}

function requestMetadata(value) {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.request)) return
  const item = value.request
  if (Object.keys(item).length !== 4 || typeof item.id !== 'string' || item.id !== requestId
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/.test(item.unit)
    || item.unit.endsWith('@.service') || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.name)
    || !['pending', 'saved', 'cancelled'].includes(item.state)) return
  return item
}

function loginMetadata(value) {
  if (!record(value) || Object.keys(value).length !== 3 || typeof value.id !== 'string'
    || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.origin !== 'string'
    || !/^https:\/\/[^/?#]+(?::\d+)?$/.test(value.origin) || typeof value.label !== 'string'
    || value.label.trim() !== value.label || value.label.length === 0 || [...value.label].length > 80) return
  return value
}

function acknowledged(value) {
  return record(value) && Object.keys(value).length === 1 && value.ok === true
}

function selectSection(section) {
  activeSection = section
  const apiActive = section === 'api-keys'
  element('api-keys-tab').setAttribute('aria-selected', String(apiActive))
  element('websites-tab').setAttribute('aria-selected', String(!apiActive))
  apiKeysPanel.hidden = !apiActive
  websitesPanel.hidden = apiActive
}

function availability() {
  main.setAttribute('aria-busy', String(busy))
  if (mode?.kind === 'request') {
    const active = ready && requestState === 'pending'
    requestValue.disabled = busy || !active
    element('request-save').disabled = busy || !active
    element('request-cancel').disabled = busy || !active
    return
  }
  if (mode?.kind === 'login-use') {
    const active = loginUseReady && loginUseLogins.length > 0
    loginChoice.disabled = busy || !active
    loginUseApprove.disabled = busy || !active
    loginUseDecline.disabled = busy
    return
  }
  service.disabled = busy || !ready
  element('add').disabled = busy || !ready
  element('refresh').disabled = busy
  for (const button of secretList.querySelectorAll('button')) button.disabled = busy || !ready
  for (const input of editor.querySelectorAll('input, button')) input.disabled = busy || !ready
  element('add-login').disabled = busy || !websitesReady
  for (const button of loginList.querySelectorAll('button')) button.disabled = busy || !websitesReady
  for (const input of loginEditor.querySelectorAll('input, button')) input.disabled = busy || !websitesReady
}

function selectedService() {
  return services.find(item => item.unit === service.value)
}

function closeEditor() {
  editing = undefined
  editor.reset()
  nameInput.readOnly = false
  editor.hidden = true
}

function openEditor(action, name = '') {
  const selected = selectedService()
  if (busy || !ready || selected === undefined) return
  editing = { action, unit: selected.unit }
  element('editor-title').textContent = messages[action === 'add' ? 'cloudVaultAdd' : 'cloudVaultReplace']
  nameInput.value = name
  nameInput.readOnly = action === 'replace'
  valueInput.value = ''
  editor.hidden = false
  setNotice()
  const input = nameInput.readOnly ? valueInput : nameInput
  input.focus({ preventScroll: true })
  editor.scrollIntoView({ block: 'nearest' })
}

function closeLoginEditor() {
  editingLogin = undefined
  loginEditor.reset()
  loginOriginInput.readOnly = false
  loginEditor.hidden = true
  element('logins-empty').hidden = logins.length > 0 || !websitesReady
}

function openLoginEditor(action, login) {
  if (busy || !websitesReady) return
  editingLogin = action === 'add' ? { action } : { action, id: login.id }
  element('login-editor-title').textContent = messages[action === 'add'
    ? 'cloudVaultWebsiteEditorAdd' : 'cloudVaultWebsiteEditorReplace']
  loginOriginInput.value = action === 'add' ? '' : login.origin
  loginOriginInput.readOnly = action === 'replace'
  loginLabelInput.value = action === 'add' ? '' : login.label
  // Rotation intentionally starts with blank credentials; the Vault never reads them back.
  loginUsernameInput.value = ''
  loginPasswordInput.value = ''
  loginEditor.hidden = false
  element('logins-empty').hidden = true
  setWebsitesNotice()
  const input = action === 'add' ? loginOriginInput : loginLabelInput
  input.focus({ preventScroll: true })
  loginEditor.scrollIntoView({ block: 'nearest' })
}

function revoke(unit, name) {
  if (busy || !ready) return
  revoking = { action: 'revoke', unit, name }
  removingLogin = undefined
  setNotice()
  element('confirm-title').textContent = messages.cloudVaultConfirm.replace('{name}', () => name)
  element('confirm-detail').textContent = messages.cloudVaultApply
  element('confirm-revoke').textContent = messages.cloudVaultRevoke
  confirmation.showModal()
}

function removeLogin(login) {
  if (busy || !websitesReady) return
  removingLogin = login
  revoking = undefined
  setWebsitesNotice()
  element('confirm-title').textContent = messages.cloudVaultWebsiteConfirm.replace('{origin}', () => login.origin)
  element('confirm-detail').textContent = messages.cloudVaultWebsiteConfirmDetail
  element('confirm-revoke').textContent = messages.cloudVaultWebsiteRemove
  confirmation.showModal()
}

function actionButton(key, name, callback, className = '') {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = messages[key]
  button.setAttribute('aria-label', `${messages[key]} ${name}`)
  button.className = className
  button.addEventListener('click', callback)
  return button
}

function renderNames() {
  const selected = selectedService()
  const rows = selected?.names.map(name => {
    const row = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = name
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.append(actionButton('cloudVaultReplace', name, () => openEditor('replace', name)),
      actionButton('cloudVaultRevoke', name, () => revoke(selected.unit, name), 'danger'))
    row.append(label, actions)
    return row
  }) ?? []
  secretList.replaceChildren(...rows)
  element('empty').hidden = rows.length > 0
  availability()
}

function renderLogins() {
  const rows = logins.map(login => {
    const row = document.createElement('li')
    const details = document.createElement('span')
    details.className = 'login-details'
    const label = document.createElement('span')
    label.textContent = login.label
    const origin = document.createElement('span')
    origin.textContent = login.origin
    details.append(label, origin)
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.append(actionButton('cloudVaultWebsiteReplace', login.label,
      () => openLoginEditor('replace', login)),
    actionButton('cloudVaultWebsiteRemove', login.label, () => removeLogin(login), 'danger'))
    row.append(details, actions)
    return row
  })
  loginList.replaceChildren(...rows)
  element('logins-empty').hidden = rows.length > 0 || !websitesReady || !loginEditor.hidden
  availability()
}

async function send(request) {
  try { return await api.request(request) }
  catch { return { ok: false, reason: 'unavailable' } }
}

async function readInventory() {
  const reply = await send({ action: 'list' })
  ready = reply.ok && Array.isArray(reply.services)
  if (!ready) return false
  const selected = service.value
  services = reply.services
  service.replaceChildren(...services.map(item => new Option(item.unit, item.unit)))
  if (services.some(item => item.unit === selected)) service.value = selected
  element('services').hidden = services.length === 0
  renderNames()
  return true
}

async function readLogins() {
  const reply = await send({ action: 'list-logins' })
  if (!reply.ok || !Array.isArray(reply.logins) || !reply.logins.every(loginMetadata)) {
    websitesReady = false
    logins = []
    renderLogins()
    return false
  }
  websitesReady = true
  logins = reply.logins
  renderLogins()
  return true
}

async function refresh() {
  if (busy) return
  closeEditor()
  closeLoginEditor()
  busy = true
  availability()
  setNotice('cloudVaultLoading')
  setWebsitesNotice('cloudVaultLoading')
  // The native bridge serializes SSH requests for this window.
  const loaded = await readInventory()
  const websitesLoaded = await readLogins()
  busy = false
  availability()
  if (!loaded) setNotice('cloudVaultUnavailable', 'error')
  else setNotice(services.length === 0 ? 'cloudVaultNoServices' : undefined)
  setWebsitesNotice(websitesLoaded ? undefined : 'cloudVaultWebsitesUnavailable', websitesLoaded ? '' : 'error')
}

async function change(request) {
  if (busy || !ready) return
  busy = true
  availability()
  setNotice('cloudVaultSaving')
  const result = await send(request)
  if (!result.ok) {
    if (result.reason !== 'invalid') { ready = false; closeEditor() }
    busy = false
    availability()
    setNotice(result.reason === 'invalid' ? 'cloudVaultInvalid' : 'cloudVaultFailed', 'error')
    if (ready && !editor.hidden) valueInput.focus()
    else element('refresh').focus()
    return
  }
  closeEditor()
  const loaded = await readInventory()
  busy = false
  availability()
  if (!loaded) setNotice('cloudVaultUnavailable', 'error')
  else setNotice(request.action === 'revoke' ? 'cloudVaultRevoked' : 'cloudVaultSaved')
  element(loaded ? 'add' : 'refresh').focus()
}

async function changeLogin(request) {
  if (busy || !websitesReady) return
  busy = true
  loginPasswordInput.value = ''
  availability()
  setWebsitesNotice('cloudVaultSaving')
  const result = await send(request)
  if (!acknowledged(result)) {
    if (result.reason !== 'invalid') { websitesReady = false; closeLoginEditor() }
    busy = false
    availability()
    setWebsitesNotice(result.reason === 'invalid' ? 'cloudVaultWebsiteInvalid' : 'cloudVaultFailed', 'error')
    if (websitesReady && !loginEditor.hidden) loginLabelInput.focus()
    else element('websites-tab').focus()
    return
  }
  closeLoginEditor()
  const loaded = await readLogins()
  busy = false
  availability()
  setWebsitesNotice(loaded ? 'cloudVaultWebsiteSaved' : 'cloudVaultWebsitesUnavailable', loaded ? '' : 'error')
  element(loaded ? 'add-login' : 'websites-tab').focus()
}

async function removeLoginRequest(login) {
  if (busy || !websitesReady) return
  busy = true
  availability()
  setWebsitesNotice('cloudVaultSaving')
  const result = await send({ action: 'remove-login', id: login.id })
  if (!acknowledged(result)) {
    if (result.reason !== 'invalid') websitesReady = false
    busy = false
    availability()
    setWebsitesNotice(result.reason === 'invalid' ? 'cloudVaultWebsiteInvalid' : 'cloudVaultFailed', 'error')
    element('websites-tab').focus()
    return
  }
  const loaded = await readLogins()
  busy = false
  availability()
  setWebsitesNotice(loaded ? 'cloudVaultWebsiteRemoved' : 'cloudVaultWebsitesUnavailable', loaded ? '' : 'error')
  element(loaded ? 'add-login' : 'websites-tab').focus()
}

async function loadRequest() {
  busy = true
  setRequestOutcome('cloudVaultRequestInspecting')
  availability()
  const reply = await send({ action: 'inspect-request', id: requestId })
  const item = requestMetadata(reply)
  if (item === undefined) {
    busy = false
    ready = false
    requestEditor.hidden = true
    setRequestOutcome('cloudVaultRequestUnavailable', 'error')
    availability()
    return
  }
  requestState = item.state
  busy = false
  element('request-unit').textContent = item.unit
  element('request-name').textContent = item.name
  if (item.state === 'pending') {
    ready = true
    requestEditor.hidden = false
    setRequestOutcome()
    availability()
    requestValue.focus({ preventScroll: true })
    return
  }
  ready = false
  requestEditor.hidden = true
  setRequestOutcome(item.state === 'saved' ? 'cloudVaultRequestSaved' : 'cloudVaultRequestCancelled')
  availability()
}

function renderLoginUseChoices() {
  loginChoice.replaceChildren(...loginUseLogins.map(login => new Option(login.label, login.id)))
  loginChoice.hidden = loginUseLogins.length === 0
  loginUseEmpty.hidden = loginUseLogins.length > 0
  availability()
}

async function loadLoginUse() {
  busy = true
  setLoginUseOutcome('cloudVaultLoginUseInspecting')
  availability()
  const reply = await send({ action: 'inspect-login-use', id: requestId })
  const item = loginUseMetadata(reply)
  if (item === undefined) {
    busy = false
    loginUseReady = false
    setLoginUseOutcome('cloudVaultLoginUseUnavailable', 'error')
    availability()
    return
  }
  loginUseOriginValue.textContent = item.origin
  loginUseDestinationValue.textContent = item.destination
  loginUseLogins = item.logins
  renderLoginUseChoices()
  loginUseReady = true
  busy = false
  setLoginUseOutcome()
  availability()
  if (loginUseLogins.length > 0) loginChoice.focus({ preventScroll: true })
}

async function approveLoginUse() {
  if (busy || !loginUseReady || loginUseLogins.length === 0 || loginChoice.value === '') return
  busy = true
  availability()
  setLoginUseOutcome('cloudVaultLoginUseApproving')
  const selected = loginUseLogins.find(login => login.id === loginChoice.value)
  if (selected === undefined) {
    busy = false
    availability()
    setLoginUseOutcome('cloudVaultLoginUseUnavailable', 'error')
    return
  }
  const result = await send({ action: 'approve-login-use', id: requestId, loginId: selected.id, generation: selected.generation })
  loginUseReady = false
  busy = false
  if (record(result) && Object.keys(result).length === 1 && result.state === 'submitted') {
    setLoginUseOutcome('cloudVaultLoginUseSubmitted')
  } else if (record(result) && Object.keys(result).length === 1 && result.state === 'needs-owner') {
    setLoginUseOutcome('cloudVaultLoginUseNeedsOwner', 'error')
  } else {
    setLoginUseOutcome('cloudVaultLoginUseUnavailable', 'error')
  }
  availability()
}

async function declineLoginUse() {
  if (busy || !loginUseReady) return
  busy = true
  availability()
  setLoginUseOutcome('cloudVaultLoginUseDeclining')
  const result = await send({ action: 'decline-login-use', id: requestId })
  loginUseReady = false
  busy = false
  if (record(result) && Object.keys(result).length === 1 && result.state === 'unavailable') {
    setLoginUseOutcome('cloudVaultLoginUseUnavailable')
  } else {
    setLoginUseOutcome('cloudVaultLoginUseFailed', 'error')
  }
  availability()
}

async function saveRequest(value) {
  if (busy || !ready || requestState !== 'pending') return
  busy = true
  availability()
  setRequestOutcome('cloudVaultRequestSaving')
  requestValue.value = ''
  const result = await send({ action: 'save-request', id: requestId, value })
  if (acknowledged(result)) {
    requestState = 'saved'
    ready = false
    busy = false
    requestEditor.hidden = true
    setRequestOutcome('cloudVaultRequestSaved')
    availability()
    return
  }
  requestState = undefined
  ready = false
  busy = false
  requestEditor.hidden = true
  setRequestOutcome('cloudVaultRequestFailed', 'error')
  availability()
}

async function dismissRequest() {
  if (busy || !ready || requestState !== 'pending') return
  busy = true
  requestValue.value = ''
  availability()
  setRequestOutcome('cloudVaultRequestCancelling')
  const result = await send({ action: 'dismiss-request', id: requestId })
  if (record(result) && Object.keys(result).length === 1 && (result.state === 'saved' || result.state === 'cancelled')) {
    requestState = result.state
    ready = false
    busy = false
    requestEditor.hidden = true
    setRequestOutcome(requestState === 'saved' ? 'cloudVaultRequestSaved' : 'cloudVaultRequestCancelled')
    availability()
    return
  }
  busy = false
  setRequestOutcome('cloudVaultRequestDismissFailed', 'error')
  availability()
  element('request-cancel').focus()
}

element('refresh').addEventListener('click', () => { void refresh() })
element('api-keys-tab').addEventListener('click', () => { if (!busy) selectSection('api-keys') })
element('websites-tab').addEventListener('click', () => { if (!busy) selectSection('websites') })
service.addEventListener('change', () => { closeEditor(); setNotice(); renderNames() })
element('add').addEventListener('click', () => openEditor('add'))
element('editor-cancel').addEventListener('click', () => { closeEditor(); element('add').focus() })
editor.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !ready || editing === undefined) return
  const request = { ...editing, name: nameInput.value.trim(), value: valueInput.value }
  valueInput.value = ''
  void change(request)
})
element('add-login').addEventListener('click', () => openLoginEditor('add'))
element('login-editor-cancel').addEventListener('click', () => { closeLoginEditor(); element('add-login').focus() })
loginEditor.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !websitesReady || editingLogin === undefined) return
  const request = editingLogin.action === 'add'
    ? { action: 'add-login', origin: loginOriginInput.value, label: loginLabelInput.value.trim(), username: loginUsernameInput.value, password: loginPasswordInput.value }
    : { action: 'replace-login', id: editingLogin.id, label: loginLabelInput.value.trim(), username: loginUsernameInput.value, password: loginPasswordInput.value }
  loginPasswordInput.value = ''
  void changeLogin(request)
})
element('confirm-cancel').addEventListener('click', () => { confirmation.close() })
confirmation.addEventListener('close', () => { revoking = undefined; removingLogin = undefined })
element('confirm-revoke').addEventListener('click', () => {
  const request = revoking
  const login = removingLogin
  confirmation.close()
  if (request !== undefined) void change(request)
  else if (login !== undefined) void removeLoginRequest(login)
})
requestEditor.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !ready || requestState !== 'pending') return
  void saveRequest(requestValue.value)
})
element('request-cancel').addEventListener('click', () => { void dismissRequest() })
loginUseApprove.addEventListener('click', () => { void approveLoginUse() })
loginUseDecline.addEventListener('click', () => { void declineLoginUse() })
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || confirmation.open) return
  event.preventDefault()
  if (mode?.kind === 'request' || mode?.kind === 'login-use') { void api.close().catch(() => {}); return }
  if (editor.hidden && loginEditor.hidden || busy) void api.close().catch(() => {})
  else if (activeSection === 'websites') { closeLoginEditor(); element('add-login').focus() }
  else { closeEditor(); element('add').focus() }
})
window.addEventListener('pagehide', () => {
  closeEditor()
  closeLoginEditor()
  requestValue.value = ''
  loginChoice.replaceChildren()
  loginPasswordInput.value = ''
}, { once: true })

void Promise.all([api.messages(), api.mode()]).then(([copy, presentation]) => {
  messages = copy
  mode = presentation
  document.title = copy.cloudVault
  for (const [id, key] of [
    ['title', 'cloudVault'], ['hint', 'cloudVaultHint'], ['api-keys-tab', 'cloudVaultApiKeys'], ['websites-tab', 'cloudVaultWebsites'],
    ['websites-hint', 'cloudVaultWebsitesHint'], ['logins-title', 'cloudVaultWebsites'], ['add-login-label', 'cloudVaultWebsiteAdd'],
    ['logins-empty', 'cloudVaultWebsitesEmpty'], ['login-origin-label', 'cloudVaultWebsiteOrigin'], ['login-label-label', 'cloudVaultWebsiteLabel'],
    ['login-username-label', 'cloudVaultWebsiteUsername'], ['login-password-label', 'cloudVaultWebsitePassword'],
    ['login-save', 'cloudVaultWebsiteSave'], ['login-editor-cancel', 'cancel'],
    ['service-label', 'cloudVaultService'], ['names', 'cloudVaultNames'], ['empty', 'cloudVaultEmpty'], ['add-label', 'cloudVaultAdd'],
    ['name-label', 'cloudVaultName'], ['value-label', 'cloudVaultValue'], ['save', 'cloudVaultSave'], ['editor-cancel', 'cancel'],
    ['apply', 'cloudVaultApply'], ['refresh', 'cloudVaultRefresh'], ['confirm-cancel', 'cancel'], ['confirm-revoke', 'cloudVaultRevoke'],
    ['confirm-detail', 'cloudVaultApply'], ['request-service-label', 'cloudVaultRequestService'], ['request-name-label', 'cloudVaultRequestName'],
    ['request-value-label', 'cloudVaultRequestValue'], ['request-cancel', 'cloudVaultRequestCancel'], ['request-save', 'cloudVaultRequestSave'],
    ['login-use-origin-label', 'cloudVaultLoginUseOrigin'], ['login-use-destination-label', 'cloudVaultLoginUseDestination'],
    ['login-use-login-label', 'cloudVaultLoginUseLogin'], ['login-use-empty', 'cloudVaultLoginUseEmpty'],
    ['login-use-approve', 'cloudVaultLoginUseApprove'], ['login-use-decline', 'cloudVaultLoginUseDecline'],
  ]) element(id).textContent = copy[key]
  if (validRequestMode(mode)) {
    requestId = mode.id
    document.title = copy.cloudVaultRequestTitle
    element('title').textContent = copy.cloudVaultRequestTitle
    element('hint').textContent = copy.cloudVaultRequestHint
    request.hidden = false
    management.hidden = true
    element('apply').parentElement.hidden = true
    notice.hidden = true
    main.hidden = false
    return loadRequest()
  }
  if (validLoginUseMode(mode)) {
    requestId = mode.id
    document.title = copy.cloudVaultLoginUseTitle
    element('title').textContent = copy.cloudVaultLoginUseTitle
    element('hint').textContent = copy.cloudVaultLoginUseHint
    loginUse.hidden = false
    management.hidden = true
    request.hidden = true
    element('apply').parentElement.hidden = true
    notice.hidden = true
    main.hidden = false
    return loadLoginUse()
  }
  if (!record(mode) || Object.keys(mode).length !== 1 || mode.kind !== 'manage') throw new Error('Invalid Vault mode')
  request.hidden = true
  management.hidden = false
  selectSection('api-keys')
  main.hidden = false
  return refresh()
}).catch(() => { void api.close().catch(() => {}) })
