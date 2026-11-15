/** The shell-owned form clears secret fields before each write-only request. */
const api = window.yhCloudVault
const element = id => document.getElementById(id)
const main = document.querySelector('main')
const management = element('management')
const sections = ['api-keys', 'bot-access', 'websites']
const grantList = element('grants')
const grantEditor = element('grant-editor')
const grantBot = element('grant-bot')
const grantService = element('grant-service')
const grantName = element('grant-name')
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
const loginUseEntry = element('login-use-entry')
const loginUseUsername = element('login-use-username')
const loginUsePassword = element('login-use-password')
const loginUseSave = element('login-use-save')
const loginUseSaveLabel = element('login-use-save-label')
const loginUseSubmit = element('login-use-submit')
const loginUseToggle = element('login-use-toggle')
const loginUseClose = element('login-use-close')
const loginUseOutcome = element('login-use-outcome')
const confirmation = element('confirmation')
const notice = element('notice')
const grantNotice = element('grant-notice')
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
let loginUseRequest
let enteringLogin = false
let services = []
let logins = []
let grantAccess
let grantBots
let editing
let editingLogin
let revoking
let removingLogin
let removingGrant
let busy = false
let ready = false
let websitesReady = false
let grantsReady = false
let activeSection = 'api-keys'

function setNotice(key, tone = '') {
  const target = activeSection === 'bot-access' ? grantNotice : notice
  target.textContent = key === undefined ? '' : messages[key]
  target.dataset.tone = tone
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
  const acceptsCredentials = item.acceptsCredentials === true
  if (Object.keys(item).length !== (acceptsCredentials ? 5 : 4) || item.id !== requestId) return
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
  return { origin, destination, logins, acceptsCredentials }
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
  for (const item of sections) {
    const active = item === section
    const tab = element(`${item}-tab`)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    element(`${item}-panel`).hidden = !active
  }
  element('apply').hidden = section !== 'api-keys'
  notice.hidden = section === 'bot-access'
  grantNotice.hidden = section !== 'bot-access'
}

function activateSection(section) {
  if (busy || section === activeSection) return
  closeEditor()
  closeLoginEditor()
  closeGrantEditor()
  selectSection(section)
  if (section === 'bot-access') void refreshGrants()
  else if (section === 'websites') setNotice()
  else setNotice(!ready ? 'cloudVaultUnavailable' : services.length === 0 ? 'cloudVaultNoServices' : undefined, ready ? '' : 'error')
}

function canGrantAccess() {
  return grantsReady && grantAccess.services.length > 0 && (grantBots?.length ?? 0) > 0
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
    const active = !busy && loginUseRequest !== undefined
    loginChoice.disabled = !active || loginUseApprove.hidden
    loginUseApprove.disabled = loginChoice.disabled
    loginUseDecline.disabled = !active
    loginUseToggle.disabled = !active
    loginUseSubmit.disabled = !active || loginUseSubmit.hidden
    for (const input of loginUseEntry.querySelectorAll('input')) input.disabled = loginUseSubmit.disabled || input.hidden
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
  element('add-grant').disabled = busy || !canGrantAccess()
  for (const button of grantList.querySelectorAll('button')) button.disabled = busy || !grantsReady
  for (const input of grantEditor.querySelectorAll('input, select, button')) input.disabled = busy || !canGrantAccess()
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
  removingGrant = undefined
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
  removingGrant = undefined
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

function botName(id) {
  return grantBots?.find(bot => bot.id === id)?.name ?? id
}

function closeGrantEditor() {
  grantEditor.reset()
  grantEditor.hidden = true
  element('add-grant').hidden = false
}

function openGrantEditor() {
  if (busy || !canGrantAccess()) return
  closeGrantEditor()
  const names = new Map()
  for (const bot of grantBots) names.set(bot.name, (names.get(bot.name) ?? 0) + 1)
  grantBot.replaceChildren(...grantBots.map(bot => new Option(
    names.get(bot.name) > 1 ? `${bot.name} (${bot.id})` : bot.name, bot.id,
  )))
  grantService.replaceChildren(...grantAccess.services.map(unit => new Option(unit, unit)))
  grantEditor.hidden = false
  element('add-grant').hidden = true
  element('grants-empty').hidden = true
  setNotice()
  grantBot.focus({ preventScroll: true })
  grantEditor.scrollIntoView?.({ block: 'nearest' })
}

function confirmGrantRemoval(grant) {
  if (busy || !grantsReady) return
  removingGrant = grant
  revoking = undefined
  removingLogin = undefined
  setNotice()
  element('confirm-title').textContent = messages.cloudVaultBotAccessConfirm.replace('{bot}', () => botName(grant.bot))
  element('confirm-detail').textContent = messages.cloudVaultBotAccessConfirmDetail
  element('confirm-revoke').textContent = messages.cloudVaultBotAccessRemove
  confirmation.showModal()
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

function renderGrants() {
  const rows = grantAccess?.grants.map(grant => {
    const row = document.createElement('li')
    const details = document.createElement('span')
    details.className = 'grant-details'
    const bot = document.createElement('span')
    const key = document.createElement('span')
    bot.textContent = botName(grant.bot)
    key.textContent = `${grant.unit} · ${grant.name}`
    details.append(bot, key)
    row.append(details, actionButton('cloudVaultBotAccessRemove', `${bot.textContent} ${grant.name}`,
      () => confirmGrantRemoval(grant), 'subtle'))
    return row
  }) ?? []
  grantList.replaceChildren(...rows)
  const empty = element('grants-empty')
  empty.hidden = !grantsReady || rows.length > 0 || !grantEditor.hidden
  empty.textContent = messages[grantAccess?.services.length === 0 ? 'cloudVaultNoServices' : 'cloudVaultBotAccessEmpty']
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

async function readGrantAccess() {
  const reply = await send({ action: 'list-grants' })
  grantsReady = reply.ok === true && record(reply.access)
  if (grantsReady) {
    grantAccess = reply.access
    grantBots = reply.bots
  }
  renderGrants()
}

function grantInventoryNotice(success) {
  if (!grantsReady) setNotice('cloudVaultBotAccessUnavailable', 'error')
  else if (success !== undefined) setNotice(success)
  else if (grantBots === undefined) setNotice('cloudVaultBotAccessRosterUnavailable', 'error')
  else setNotice(grantBots.length === 0 && grantAccess.services.length > 0 ? 'cloudVaultBotAccessNoBots' : undefined)
}

async function refreshGrants() {
  if (busy) return
  closeGrantEditor()
  busy = true
  availability()
  setNotice('cloudVaultLoading')
  await readGrantAccess()
  busy = false
  availability()
  grantInventoryNotice()
}

async function refresh() {
  if (busy) return
  if (activeSection === 'bot-access') return refreshGrants()
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

async function changeGrant(request) {
  if (busy || !grantsReady) return
  busy = true
  availability()
  setNotice('cloudVaultSaving')
  const result = await send(request)
  if (acknowledged(result)) {
    closeGrantEditor()
    await readGrantAccess()
    grantInventoryNotice(request.action === 'add-grant' ? 'cloudVaultBotAccessGranted' : 'cloudVaultBotAccessRemoved')
  } else {
    if (result.reason !== 'invalid') grantsReady = false
    setNotice(result.reason === 'invalid' ? 'cloudVaultBotAccessInvalid' : 'cloudVaultFailed', 'error')
  }
  busy = false
  availability()
  if (canGrantAccess() && !grantEditor.hidden) grantName.focus()
  else element(canGrantAccess() ? 'add-grant' : 'refresh').focus()
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

function showLoginUseSaveLabel() {
  const save = loginUseSave.checked
  element('login-use-save-label-text').hidden = !save
  loginUseSaveLabel.hidden = !save
  loginUseSaveLabel.required = save
  availability()
}

function renderLoginUseForm() {
  const hasSaved = (loginUseRequest?.logins.length ?? 0) > 0
  const canEnter = loginUseRequest?.acceptsCredentials === true
  element('login-use-saved').hidden = !hasSaved || enteringLogin
  loginUseEmpty.hidden = loginUseRequest === undefined || hasSaved || canEnter
  loginUseEntry.hidden = !canEnter || !enteringLogin
  loginUseDecline.hidden = loginUseRequest === undefined
  loginUseApprove.hidden = !hasSaved || enteringLogin
  loginUseSubmit.hidden = loginUseEntry.hidden
  loginUseToggle.hidden = !hasSaved || !canEnter
  loginUseToggle.textContent = messages[enteringLogin ? 'cloudVaultLoginUseChoose' : 'cloudVaultLoginUseEnter']
  loginUseClose.hidden = busy || loginUseRequest !== undefined
  showLoginUseSaveLabel()
}

function focusLoginUseForm() {
  if (!loginUseEntry.hidden) loginUseUsername.focus({ preventScroll: true })
  else if (!loginUseApprove.hidden) loginChoice.focus({ preventScroll: true })
  else if (!loginUseDecline.hidden) loginUseDecline.focus({ preventScroll: true })
  else loginUseClose.focus({ preventScroll: true })
}

async function loadLoginUse() {
  busy = true
  setLoginUseOutcome('cloudVaultLoginUseInspecting')
  renderLoginUseForm()
  loginUseRequest = loginUseMetadata(await send({ action: 'inspect-login-use', id: requestId, form: 'entry' }))
    ?? loginUseMetadata(await send({ action: 'inspect-login-use', id: requestId }))
  if (loginUseRequest === undefined) {
    setLoginUseOutcome('cloudVaultLoginUseUnavailable', 'error')
  } else {
    loginUseOriginValue.textContent = loginUseRequest.origin
    loginUseDestinationValue.textContent = loginUseRequest.destination
    loginChoice.replaceChildren(...loginUseRequest.logins.map(login => new Option(login.label, login.id)))
    enteringLogin = loginUseRequest.acceptsCredentials && loginUseRequest.logins.length === 0
    setLoginUseOutcome()
  }
  busy = false
  renderLoginUseForm()
  focusLoginUseForm()
}

function toggleLoginUseEntry() {
  if (busy || loginUseRequest?.acceptsCredentials !== true || loginUseRequest.logins.length === 0) return
  enteringLogin = !enteringLogin
  loginUseEntry.reset()
  setLoginUseOutcome()
  renderLoginUseForm()
  focusLoginUseForm()
}

async function submitLoginUse(request) {
  busy = true
  availability()
  setLoginUseOutcome('cloudVaultLoginUseApproving')
  loginUseEntry.reset()
  const result = await send(request)
  busy = false
  if (request.action === 'enter-login-use' && record(result) && result.ok === false && result.reason === 'invalid') {
    setLoginUseOutcome('cloudVaultLoginUseInvalid', 'error')
    renderLoginUseForm()
    focusLoginUseForm()
    return
  }
  loginUseRequest = undefined
  if (record(result) && result.state === 'submitted') {
    if (request.saveLabel === undefined) setLoginUseOutcome('cloudVaultLoginUseSubmitted')
    else if (result.saved === true) setLoginUseOutcome('cloudVaultLoginUseSubmittedSaved')
    else setLoginUseOutcome('cloudVaultLoginUseSaveFailed', 'error')
  } else if (record(result) && result.state === 'needs-owner') {
    setLoginUseOutcome('cloudVaultLoginUseNeedsOwner', 'error')
  } else {
    setLoginUseOutcome('cloudVaultLoginUseUnavailable', 'error')
  }
  renderLoginUseForm()
  focusLoginUseForm()
}

async function declineLoginUse() {
  if (busy || loginUseRequest === undefined) return
  busy = true
  availability()
  setLoginUseOutcome('cloudVaultLoginUseDeclining')
  loginUseEntry.reset()
  const result = await send({ action: 'decline-login-use', id: requestId })
  loginUseRequest = undefined
  busy = false
  if (record(result) && Object.keys(result).length === 1 && result.state === 'unavailable') {
    setLoginUseOutcome('cloudVaultLoginUseUnavailable')
  } else {
    setLoginUseOutcome('cloudVaultLoginUseFailed', 'error')
  }
  renderLoginUseForm()
  focusLoginUseForm()
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
for (const [index, section] of sections.entries()) {
  const tab = element(`${section}-tab`)
  tab.addEventListener('click', () => activateSection(section))
  tab.addEventListener('keydown', event => {
    const to = { ArrowRight: (index + 1) % sections.length, ArrowLeft: (index + sections.length - 1) % sections.length,
      Home: 0, End: sections.length - 1 }[event.key]
    if (busy || to === undefined) return
    event.preventDefault()
    activateSection(sections[to])
    element(`${sections[to]}-tab`).focus()
  })
}
element('add-grant').addEventListener('click', openGrantEditor)
element('grant-editor-cancel').addEventListener('click', () => { closeGrantEditor(); renderGrants(); element('add-grant').focus() })
grantEditor.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !canGrantAccess() || grantEditor.hidden) return
  const request = { action: 'add-grant', bot: grantBot.value, unit: grantService.value, name: grantName.value.trim() }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(request.name) || !grantBots.some(bot => bot.id === request.bot)
    || !grantAccess.services.includes(request.unit)) { setNotice('cloudVaultBotAccessInvalid', 'error'); return }
  void changeGrant(request)
})
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
confirmation.addEventListener('close', () => { revoking = undefined; removingLogin = undefined; removingGrant = undefined })
element('confirm-revoke').addEventListener('click', () => {
  const request = revoking
  const login = removingLogin
  const grant = removingGrant
  confirmation.close()
  if (request !== undefined) void change(request)
  else if (login !== undefined) void removeLoginRequest(login)
  else if (grant !== undefined) void changeGrant({ action: 'remove-grant', ...grant })
})
requestEditor.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !ready || requestState !== 'pending') return
  void saveRequest(requestValue.value)
})
element('request-cancel').addEventListener('click', () => { void dismissRequest() })
loginUseApprove.addEventListener('click', () => {
  if (busy || enteringLogin) return
  const selected = loginUseRequest?.logins.find(login => login.id === loginChoice.value)
  if (selected !== undefined) {
    void submitLoginUse({ action: 'approve-login-use', id: requestId, loginId: selected.id, generation: selected.generation })
  }
})
loginUseToggle.addEventListener('click', toggleLoginUseEntry)
loginUseSave.addEventListener('change', showLoginUseSaveLabel)
loginUseEntry.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !enteringLogin || loginUseRequest?.acceptsCredentials !== true) return
  void submitLoginUse({
    action: 'enter-login-use', id: requestId, origin: loginUseRequest.origin, destination: loginUseRequest.destination,
    username: loginUseUsername.value, password: loginUsePassword.value,
    ...(loginUseSave.checked ? { saveLabel: loginUseSaveLabel.value.trim() } : {}),
  })
})
loginUseDecline.addEventListener('click', () => { void declineLoginUse() })
loginUseClose.addEventListener('click', () => { void api.close().catch(() => {}) })
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || confirmation.open) return
  event.preventDefault()
  if (mode?.kind === 'request' || mode?.kind === 'login-use') { void api.close().catch(() => {}); return }
  if ((editor.hidden && loginEditor.hidden && grantEditor.hidden) || busy) void api.close().catch(() => {})
  else if (activeSection === 'websites') { closeLoginEditor(); element('add-login').focus() }
  else if (activeSection === 'bot-access') { closeGrantEditor(); renderGrants(); element('add-grant').focus() }
  else { closeEditor(); element('add').focus() }
})
window.addEventListener('pagehide', () => {
  closeEditor()
  closeLoginEditor()
  closeGrantEditor()
  requestValue.value = ''
  loginChoice.replaceChildren()
  loginUseEntry.reset()
  loginPasswordInput.value = ''
}, { once: true })

void Promise.all([api.messages(), api.mode()]).then(([copy, presentation]) => {
  messages = copy
  mode = presentation
  document.title = copy.cloudVault
  for (const [id, key] of [
    ['title', 'cloudVault'], ['hint', 'cloudVaultHint'], ['api-keys-tab', 'cloudVaultApiKeys'], ['websites-tab', 'cloudVaultWebsites'],
    ['bot-access-tab', 'cloudVaultBotAccess'], ['grants-hint', 'cloudVaultBotAccessHint'], ['grants-title', 'cloudVaultBotAccessTitle'],
    ['add-grant-label', 'cloudVaultBotAccessAdd'], ['grant-bot-label', 'cloudVaultBotAccessBot'], ['grant-service-label', 'cloudVaultService'],
    ['grant-name-label', 'cloudVaultRequestName'], ['grant-editor-cancel', 'cancel'], ['grant-save', 'cloudVaultBotAccessAdd'],
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
    ['login-use-username-label', 'cloudVaultWebsiteUsername'], ['login-use-password-label', 'cloudVaultWebsitePassword'],
    ['login-use-save-text', 'cloudVaultLoginUseSave'], ['login-use-save-label-text', 'cloudVaultWebsiteLabel'],
    ['login-use-submit', 'cloudVaultLoginUseSignIn'], ['login-use-close', 'cloudVaultLoginUseDone'],
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
