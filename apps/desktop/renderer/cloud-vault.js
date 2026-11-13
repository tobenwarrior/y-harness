/** The shell-owned form clears the secret field before making its write-only request. */
const api = window.yhCloudVault
const element = id => document.getElementById(id)
const main = document.querySelector('main')
const service = element('service')
const secretList = element('secrets')
const editor = element('editor')
const nameInput = element('name')
const valueInput = element('value')
const request = element('request')
const requestEditor = element('request-editor')
const requestValue = element('request-value')
const requestOutcome = element('request-outcome')
const confirmation = element('confirmation')
const notice = element('notice')

let messages
let mode
let requestId
let requestState
let services = []
let editing
let revoking
let busy = false
let ready = false

function setNotice(key, tone = '') {
  notice.textContent = key === undefined ? '' : messages[key]
  notice.dataset.tone = tone
}

function setRequestOutcome(key, tone = '') {
  requestOutcome.textContent = key === undefined ? '' : messages[key]
  requestOutcome.dataset.tone = tone
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRequestMode(value) {
  return record(value) && Object.keys(value).length === 2 && value.kind === 'request'
    && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)
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

function acknowledged(value) {
  return record(value) && Object.keys(value).length === 1 && value.ok === true
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
  service.disabled = busy || !ready
  element('add').disabled = busy || !ready
  element('refresh').disabled = busy
  for (const button of secretList.querySelectorAll('button')) button.disabled = busy || !ready
  for (const input of editor.querySelectorAll('input, button')) input.disabled = busy || !ready
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

function revoke(unit, name) {
  if (busy || !ready) return
  revoking = { action: 'revoke', unit, name }
  setNotice()
  element('confirm-title').textContent = messages.cloudVaultConfirm.replace('{name}', () => name)
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

async function refresh() {
  if (busy) return
  closeEditor()
  busy = true
  availability()
  setNotice('cloudVaultLoading')
  const loaded = await readInventory()
  busy = false
  availability()
  if (!loaded) setNotice('cloudVaultUnavailable', 'error')
  else setNotice(services.length === 0 ? 'cloudVaultNoServices' : undefined)
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
element('confirm-cancel').addEventListener('click', () => { confirmation.close() })
confirmation.addEventListener('close', () => { revoking = undefined })
element('confirm-revoke').addEventListener('click', () => {
  const request = revoking
  confirmation.close()
  if (request !== undefined) void change(request)
})
requestEditor.addEventListener('submit', event => {
  event.preventDefault()
  if (busy || !ready || requestState !== 'pending') return
  void saveRequest(requestValue.value)
})
element('request-cancel').addEventListener('click', () => { void dismissRequest() })
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || confirmation.open) return
  event.preventDefault()
  if (mode?.kind === 'request') { void api.close().catch(() => {}); return }
  if (editor.hidden || busy) void api.close().catch(() => {})
  else { closeEditor(); element('add').focus() }
})
window.addEventListener('pagehide', () => { closeEditor(); requestValue.value = '' }, { once: true })

void Promise.all([api.messages(), api.mode()]).then(([copy, presentation]) => {
  messages = copy
  mode = presentation
  document.title = copy.cloudVault
  for (const [id, key] of [
    ['title', 'cloudVault'], ['hint', 'cloudVaultHint'], ['service-label', 'cloudVaultService'], ['names', 'cloudVaultNames'],
    ['empty', 'cloudVaultEmpty'], ['add-label', 'cloudVaultAdd'], ['name-label', 'cloudVaultName'], ['value-label', 'cloudVaultValue'],
    ['save', 'cloudVaultSave'], ['editor-cancel', 'cancel'], ['apply', 'cloudVaultApply'], ['refresh', 'cloudVaultRefresh'],
    ['confirm-cancel', 'cancel'], ['confirm-revoke', 'cloudVaultRevoke'], ['confirm-detail', 'cloudVaultApply'],
    ['request-service-label', 'cloudVaultRequestService'], ['request-name-label', 'cloudVaultRequestName'],
    ['request-value-label', 'cloudVaultRequestValue'], ['request-cancel', 'cloudVaultRequestCancel'],
    ['request-save', 'cloudVaultRequestSave'],
  ]) element(id).textContent = copy[key]
  if (validRequestMode(mode)) {
    requestId = mode.id
    document.title = copy.cloudVaultRequestTitle
    element('title').textContent = copy.cloudVaultRequestTitle
    element('hint').textContent = copy.cloudVaultRequestHint
    request.hidden = false
    element('services').hidden = true
    element('apply').parentElement.hidden = true
    notice.hidden = true
    main.hidden = false
    return loadRequest()
  }
  if (!record(mode) || Object.keys(mode).length !== 1 || mode.kind !== 'manage') throw new Error('Invalid Vault mode')
  request.hidden = true
  main.hidden = false
  return refresh()
}).catch(() => { void api.close().catch(() => {}) })
