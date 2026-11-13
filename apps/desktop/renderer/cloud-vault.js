/** The shell-owned form clears the secret field before making its write-only request. */
const api = window.yhCloudVault
const element = id => document.getElementById(id)
const main = document.querySelector('main')
const service = element('service')
const secretList = element('secrets')
const editor = element('editor')
const nameInput = element('name')
const valueInput = element('value')
const confirmation = element('confirmation')
const notice = element('notice')

let messages
let services = []
let editing
let revoking
let busy = false
let ready = false

function setNotice(key, tone = '') {
  notice.textContent = key === undefined ? '' : messages[key]
  notice.dataset.tone = tone
}

function availability() {
  main.setAttribute('aria-busy', String(busy))
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
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || confirmation.open) return
  event.preventDefault()
  if (editor.hidden || busy) void api.close().catch(() => {})
  else { closeEditor(); element('add').focus() }
})
window.addEventListener('pagehide', closeEditor, { once: true })

void api.messages().then(copy => {
  messages = copy
  document.title = copy.cloudVault
  for (const [id, text] of Object.entries({
    title: copy.cloudVault, hint: copy.cloudVaultHint, 'service-label': copy.cloudVaultService, names: copy.cloudVaultNames,
    empty: copy.cloudVaultEmpty, 'add-label': copy.cloudVaultAdd, 'name-label': copy.cloudVaultName, 'value-label': copy.cloudVaultValue,
    save: copy.cloudVaultSave, 'editor-cancel': copy.cancel, apply: copy.cloudVaultApply, refresh: copy.cloudVaultRefresh,
    'confirm-cancel': copy.cancel, 'confirm-revoke': copy.cloudVaultRevoke, 'confirm-detail': copy.cloudVaultApply,
  })) element(id).textContent = text
  main.hidden = false
  return refresh()
}).catch(() => { void api.close().catch(() => {}) })
