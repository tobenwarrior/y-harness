/** Synchronous Windows owner-private directory and file checks for local storage. */

import { lstatSync } from 'node:fs'
import { dirname, resolve, toNamespacedPath } from 'node:path'
import {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32 as decodeSlotUint32,
  extendWin32ProcessBindings,
  isNullPtr,
  throwLastError,
  throwWin32,
} from '@yharness/win32-process'
import type { NativePtr, Win32ProcessBindings } from '@yharness/win32-process'
import { createLazyRequire } from '@yharness/lazy-require'

type Koffi = typeof import('koffi')['default']
type KoffiPointer = ReturnType<Koffi['pointer']>

const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)

interface FileSecurityBindings extends Win32ProcessBindings {
  createDirectoryW(path: string, securityAttributes: Buffer): number
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr | null
  openProcessToken(processHandle: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number
  getTokenInformation(token: NativePtr, informationClass: number, information: Buffer | null, length: number, needed: NativePtr): number
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number
  initializeSecurityDescriptor(descriptor: NativePtr, revision: number): number
  setSecurityDescriptorOwner(descriptor: NativePtr, owner: NativePtr, ownerDefaulted: number): number
  setSecurityDescriptorDacl(descriptor: NativePtr, daclPresent: number, dacl: NativePtr, daclDefaulted: number): number
  setSecurityDescriptorControl(descriptor: NativePtr, controlBitsOfInterest: number, controlBitsToSet: number): number
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number
  getSecurityDescriptorControl(descriptor: NativePtr, control: NativePtr, revision: NativePtr): number
  getAclInformation(acl: NativePtr, information: Buffer, length: number, informationClass: number): number
  getAce(acl: NativePtr, index: number, ace: NativePtr): number
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number
  localFree(memory: NativePtr): NativePtr | null
  getFileAttributesW(path: string): number
}

const PROCESS_QUERY_INFORMATION = 0x0400
const TOKEN_QUERY = 0x0008
const TOKEN_USER = 1
const SE_FILE_OBJECT = 1
const OWNER_SECURITY_INFORMATION = 0x00000001
const DACL_SECURITY_INFORMATION = 0x00000004
const SE_DACL_PROTECTED = 0x1000
const ACL_SIZE_INFORMATION = 2
const ACCESS_ALLOWED_ACE_TYPE = 0
const ACCESS_DENIED_ACE_TYPE = 1
const INHERITED_ACE = 0x10
const INHERIT_ONLY_ACE = 0x08
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400
const INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF
const ERROR_SUCCESS = 0
const ERROR_ALREADY_EXISTS = 183
const GRANT_ACCESS = 1
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
const TRUSTEE_IS_SID = 0
const TRUSTEE_IS_UNKNOWN = 0
const NO_MULTIPLE_TRUSTEE = 0
const FILE_ALL_ACCESS = 0x1F01FF
const EXPLICIT_ACCESS_W_SIZE = 48
const SID_MAX_SUB_AUTHORITIES = 15
const ACL_HEADER_SIZE = 8
const SECURITY_DESCRIPTOR_REVISION = 1
const SECURITY_DESCRIPTOR_SIZE = 40
const SECURITY_ATTRIBUTES_SIZE = 24
const SECURITY_ATTRIBUTES_DESCRIPTOR_OFFSET = 8
const SECURITY_ATTRIBUTES_INHERIT_OFFSET = 16
const TRUSTED_INSTALLER_SID = (() => {
  const sid = Buffer.alloc(32)
  sid.writeUInt8(1, 0)
  sid.writeUInt8(6, 1)
  sid.writeUInt8(5, 7)
  const subAuthorities = [
    80,
    956008885,
    3418522649,
    1831038044,
    1853292631,
    2271478464,
  ]
  subAuthorities.forEach((value, index) => sid.writeUInt32LE(value, 8 + index * 4))
  return sid
})()

const FILE_LIST_DIRECTORY = 0x00000001
const FILE_ADD_FILE = 0x00000002
const FILE_ADD_SUBDIRECTORY = 0x00000004
const FILE_READ_EA = 0x00000008
const FILE_TRAVERSE = 0x00000020
const FILE_READ_ATTRIBUTES = 0x00000080
const READ_CONTROL = 0x00020000
const SYNCHRONIZE = 0x00100000
const GENERIC_EXECUTE = 0x20000000
const GENERIC_READ = 0x80000000
const ANCESTOR_SAFE_MASK = (
  FILE_LIST_DIRECTORY
  | FILE_ADD_FILE
  | FILE_ADD_SUBDIRECTORY
  | FILE_READ_EA
  | FILE_TRAVERSE
  | FILE_READ_ATTRIBUTES
  | READ_CONTROL
  | SYNCHRONIZE
  | GENERIC_EXECUTE
  | GENERIC_READ
) >>> 0

/** A path kind accepted by {@link assertOwnerPrivateWin32}. */
export type OwnerPrivatePathKind = 'file' | 'directory'

let cachedBindings: FileSecurityBindings | undefined
let cachedPointerType: KoffiPointer | undefined

function pointerType(): KoffiPointer {
  if (cachedPointerType !== undefined) return cachedPointerType
  return cachedPointerType = requireKoffi().pointer('void')
}

function allocNativeBytes(length: number): NativePtr {
  return requireKoffi().alloc('uint8', length) as NativePtr
}

function freeNative(pointer: NativePtr | undefined): void {
  if (pointer !== undefined) requireKoffi().free(pointer)
}

function bindings(): FileSecurityBindings {
  if (cachedBindings !== undefined) return cachedBindings
  cachedBindings = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    createDirectoryW: bind(kernel32, 'CreateDirectoryW', 'int', ['str16', pointerType()]),
    openProcess: bind(kernel32, 'OpenProcess', pointerType(), ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [pointerType(), 'uint32', requireKoffi().pointer(pointerType())]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [
      pointerType(), 'int', pointerType(), 'uint32', requireKoffi().pointer('uint32'),
    ]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', requireKoffi().pointer(pointerType())]),
    initializeSecurityDescriptor: bind(advapi32, 'InitializeSecurityDescriptor', 'int', [pointerType(), 'uint32']),
    setSecurityDescriptorOwner: bind(advapi32, 'SetSecurityDescriptorOwner', 'int', [pointerType(), pointerType(), 'int']),
    setSecurityDescriptorDacl: bind(advapi32, 'SetSecurityDescriptorDacl', 'int', [pointerType(), 'int', pointerType(), 'int']),
    setSecurityDescriptorControl: bind(advapi32, 'SetSecurityDescriptorControl', 'int', [pointerType(), 'uint16', 'uint16']),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', requireKoffi().pointer(pointerType()), requireKoffi().pointer(pointerType()),
      requireKoffi().pointer(pointerType()), requireKoffi().pointer(pointerType()), requireKoffi().pointer(pointerType()),
    ]),
    getSecurityDescriptorControl: bind(advapi32, 'GetSecurityDescriptorControl', 'int', [
      pointerType(), requireKoffi().pointer('uint16'), requireKoffi().pointer('uint32'),
    ]),
    getAclInformation: bind(advapi32, 'GetAclInformation', 'int', [pointerType(), pointerType(), 'uint32', 'int']),
    getAce: bind(advapi32, 'GetAce', 'int', [pointerType(), 'uint32', requireKoffi().pointer(pointerType())]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', [
      'uint32', pointerType(), pointerType(), requireKoffi().pointer(pointerType()),
    ]),
    localFree: bind(kernel32, 'LocalFree', pointerType(), [pointerType()]),
    getFileAttributesW: bind(kernel32, 'GetFileAttributesW', 'uint32', ['str16']),
  })) as FileSecurityBindings
  return cachedBindings
}

function decodePointer(buffer: Buffer, offset: number): NativePtr | null {
  const value = requireKoffi().decode(buffer, offset, pointerType()) as NativePtr | null
  return isNullPtr(value) ? null : value
}

type SidPointer = NativePtr | Buffer

function decodeUint8(pointer: SidPointer, offset: number): number {
  return requireKoffi().decode(pointer, offset, 'uint8') as number
}

function decodeUint16(pointer: NativePtr, offset: number): number {
  return requireKoffi().decode(pointer, offset, 'uint16') as number
}

function decodeNativeUint32(pointer: SidPointer, offset: number): number {
  return requireKoffi().decode(pointer, offset, 'uint32') as number
}

function policyError(path: string, detail: string): Error {
  return new Error(`unsafe Windows private path: ${path} (${detail})`)
}

function operationFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Windows operation failed'
}

function freeLocal(api: FileSecurityBindings, pointer: NativePtr, detail: string): void {
  const result = api.localFree(pointer)
  if (!isNullPtr(result)) throw new Error(`LocalFree failed for ${detail}`)
}

function closeHandleBestEffort(api: FileSecurityBindings, handle: NativePtr | null, failures: unknown[]): void {
  if (handle === null) return
  try {
    if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle')
  } catch (error) {
    failures.push(error)
  }
}

interface CurrentSid {
  readonly pointer: NativePtr
  readonly buffer: Buffer
}

function currentUserSid(api: FileSecurityBindings): CurrentSid {
  const processHandle = api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)
  let tokenSlot: NativePtr | undefined
  let tokenHandle: NativePtr | null = null
  let needed: NativePtr | undefined
  let operationFailed = false
  try {
    tokenSlot = allocPtrSlot()
    const tokenPointerSlot = tokenSlot
    if (api.openProcessToken(processHandle, TOKEN_QUERY, tokenPointerSlot) === 0) {
      const win32Code = api.getLastError()
      throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
    }
    tokenHandle = decodePtr(tokenPointerSlot)
    if (tokenHandle === null) throw new Error('OpenProcessToken returned a NULL token handle')
    needed = allocUint32()
    api.getTokenInformation(tokenHandle, TOKEN_USER, null, 0, needed)
    const length = decodeSlotUint32(needed)
    if (length < 8) throwLastError(api, 'GetTokenInformation', 'TokenUser size query')
    const buffer = Buffer.alloc(length)
    if (api.getTokenInformation(tokenHandle, TOKEN_USER, buffer, buffer.length, needed) === 0) {
      throwLastError(api, 'GetTokenInformation', 'TokenUser')
    }
    const pointer = decodePointer(buffer, 0)
    if (pointer === null || !validSid(pointer)) throw new Error('GetTokenInformation returned an invalid TokenUser SID')
    return { pointer, buffer }
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    const cleanupFailures: unknown[] = []
    closeHandleBestEffort(api, tokenHandle, cleanupFailures)
    closeHandleBestEffort(api, processHandle, cleanupFailures)
    freeNative(needed)
    freeNative(tokenSlot)
    if (!operationFailed && cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Windows handle cleanup failed')
  }
}
function validSid(pointer: NativePtr): boolean {
  const revision = decodeUint8(pointer, 0)
  const count = decodeUint8(pointer, 1)
  return revision === 1 && count <= SID_MAX_SUB_AUTHORITIES
}

function sameSid(left: SidPointer, leftOffset: number, right: SidPointer, rightOffset: number): boolean {
  if (decodeUint8(left, leftOffset) !== decodeUint8(right, rightOffset)) return false
  const leftCount = decodeUint8(left, leftOffset + 1)
  const rightCount = decodeUint8(right, rightOffset + 1)
  if (leftCount !== rightCount) return false
  for (let index = 0; index < 6; index += 1) {
    if (decodeUint8(left, leftOffset + 2 + index) !== decodeUint8(right, rightOffset + 2 + index)) return false
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (decodeNativeUint32(left, leftOffset + 8 + index * 4) !== decodeNativeUint32(right, rightOffset + 8 + index * 4)) return false
  }
  return true
}

interface TrustedSids {
  readonly current: CurrentSid
  readonly system: NativePtr
  readonly administrators: NativePtr
}

function convertSid(api: FileSecurityBindings, text: string): NativePtr {
  const slot = allocPtrSlot()
  try {
    if (api.convertStringSidToSidW(text, slot) === 0) throwLastError(api, 'ConvertStringSidToSidW', text)
    const pointer = decodePtr(slot)
    if (pointer === null) throw new Error(`ConvertStringSidToSidW returned a NULL SID for ${text}`)
    if (!validSid(pointer)) {
      freeLocal(api, pointer, `${text} SID`)
      throw new Error(`ConvertStringSidToSidW returned an invalid SID for ${text}`)
    }
    return pointer
  } finally {
    freeNative(slot)
  }
}

function trustedSids(api: FileSecurityBindings): TrustedSids {
  const current = currentUserSid(api)
  let system: NativePtr | undefined
  try {
    system = convertSid(api, 'S-1-5-18')
    const administrators = convertSid(api, 'S-1-5-32-544')
    return { current, system, administrators }
  } catch (error) {
    const cleanupFailures: unknown[] = []
    if (system !== undefined) freeLocalBestEffort(api, system, 'SYSTEM SID', cleanupFailures)
    if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], 'Windows SID cleanup failed')
    throw error
  }
}

function releaseTrustedSids(api: FileSecurityBindings, sids: TrustedSids): void {
  const cleanupFailures: unknown[] = []
  freeLocalBestEffort(api, sids.system, 'SYSTEM SID', cleanupFailures)
  freeLocalBestEffort(api, sids.administrators, 'Administrators SID', cleanupFailures)
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Windows SID cleanup failed')
}

function freeLocalBestEffort(api: FileSecurityBindings, pointer: NativePtr, detail: string, failures: unknown[]): void {
  try { freeLocal(api, pointer, detail) } catch (error) { failures.push(error) }
}

function assertNoReparsePath(api: FileSecurityBindings, path: string): void {
  let current = resolve(path)
  for (;;) {
    const attributes = api.getFileAttributesW(toNamespacedPath(current))
    if (attributes === INVALID_FILE_ATTRIBUTES) throwLastError(api, 'GetFileAttributesW', current)
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw policyError(path, `reparse path component ${current}`)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function createPrivateDirectoryPath(api: FileSecurityBindings, path: string, sids: TrustedSids): void {
  const target = resolve(path)
  const missing: string[] = []
  let current = target
  for (;;) {
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory()) throw policyError(path, `parent is not a directory: ${current}`)
      assertNoReparsePath(api, current)
      break
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) throw policyError(path, `missing filesystem root: ${current}`)
      current = parent
    }
  }
  const existingParent = missing.length === 0 ? dirname(target) : current
  if (existingParent !== target) assertPrivateAncestry(api, existingParent, sids)
  for (const directory of missing.reverse()) {
    assertNoReparsePath(api, dirname(directory))
    createPrivateDirectory(api, directory, sids)
    assertNoReparsePath(api, directory)
    assertOwnerPrivateWith(api, directory, 'directory', true, sids)
  }
}

function readSecurity(
  api: FileSecurityBindings,
  path: string,
): { readonly owner: NativePtr; readonly dacl: NativePtr; readonly descriptor: NativePtr } {
  let owner: NativePtr | undefined
  let group: NativePtr | undefined
  let dacl: NativePtr | undefined
  let sacl: NativePtr | undefined
  let descriptor: NativePtr | undefined
  try {
    owner = allocPtrSlot()
    group = allocPtrSlot()
    dacl = allocPtrSlot()
    sacl = allocPtrSlot()
    descriptor = allocPtrSlot()
    const result = api.getNamedSecurityInfoW(
      toNamespacedPath(path),
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      owner,
      group,
      dacl,
      sacl,
      descriptor,
    )
    if (result !== ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', result, path)
    const ownerPointer = decodePtr(owner)
    const daclPointer = decodePtr(dacl)
    const descriptorPointer = decodePtr(descriptor)
    if (ownerPointer === null || daclPointer === null || descriptorPointer === null) {
      if (descriptorPointer !== null) freeLocal(api, descriptorPointer, `security descriptor for ${path}`)
      throw policyError(path, ownerPointer === null ? 'NULL owner' : 'NULL DACL')
    }
    return { owner: ownerPointer, dacl: daclPointer, descriptor: descriptorPointer }
  } finally {
    freeNative(descriptor)
    freeNative(sacl)
    freeNative(dacl)
    freeNative(group)
    freeNative(owner)
  }
}

function assertDacl(
  api: FileSecurityBindings,
  path: string,
  dacl: NativePtr,
  trusted: readonly SidPointer[],
  requireProtected: boolean,
  descriptor: NativePtr,
  allowHarmlessUntrusted = false,
): void {
  if (requireProtected) {
    let control: NativePtr | undefined
    let revision: NativePtr | undefined
    try {
      control = allocUint32()
      revision = allocUint32()
      if (api.getSecurityDescriptorControl(descriptor, control, revision) === 0) {
        throwLastError(api, 'GetSecurityDescriptorControl', path)
      }
      if ((decodeSlotUint32(control) & SE_DACL_PROTECTED) === 0) throw policyError(path, 'DACL inheritance is not protected')
    } finally {
      freeNative(revision)
      freeNative(control)
    }
  }

  const information = Buffer.alloc(12)
  if (api.getAclInformation(dacl, information, information.length, ACL_SIZE_INFORMATION) === 0) {
    throwLastError(api, 'GetAclInformation', path)
  }
  const aceCount = information.readUInt32LE(0)
  const aclBytesInUse = information.readUInt32LE(4)
  if (aclBytesInUse < ACL_HEADER_SIZE) throw policyError(path, 'malformed ACL')
  let bytesSeen = ACL_HEADER_SIZE
  for (let index = 0; index < aceCount; index += 1) {
    const aceSlot = allocPtrSlot()
    try {
      if (api.getAce(dacl, index, aceSlot) === 0) throwLastError(api, 'GetAce', `${path} ACE ${index}`)
      const ace = decodePtr(aceSlot)
      if (ace === null) throw policyError(path, `NULL ACE ${index}`)
      const type = decodeUint8(ace, 0)
      const flags = decodeUint8(ace, 1)
      const size = decodeUint16(ace, 2)
      if (size < ACL_HEADER_SIZE || size % 4 !== 0 || bytesSeen + size > aclBytesInUse) {
        throw policyError(path, `malformed ACE ${index}`)
      }
      if (type !== ACCESS_ALLOWED_ACE_TYPE && type !== ACCESS_DENIED_ACE_TYPE) {
        throw policyError(path, `unrecognized ACE type ${type}`)
      }
      if (requireProtected && (flags & INHERITED_ACE) !== 0) throw policyError(path, `inherited ACE ${index}`)
      const sidCount = decodeUint8(ace, 9)
      const sidLength = 8 + sidCount * 4
      if (sidCount > SID_MAX_SUB_AUTHORITIES || 8 + sidLength > size || !validSidAt(ace, 8)) {
        throw policyError(path, `malformed ACE SID ${index}`)
      }
      const sidOffset = 8
      if (!trusted.some(trustedSid => sameSid(ace, sidOffset, trustedSid, 0))) {
        const accessMask = decodeNativeUint32(ace, 4) >>> 0
        const harmless = (flags & INHERIT_ONLY_ACE) !== 0
          || type === ACCESS_DENIED_ACE_TYPE
          || (accessMask & (~ANCESTOR_SAFE_MASK >>> 0)) === 0
        if (!allowHarmlessUntrusted || !harmless) {
          throw policyError(path, `untrusted ACE ${index}`)
        }
      }
      bytesSeen += size
    } finally {
      freeNative(aceSlot)
    }
  }
  if (bytesSeen !== aclBytesInUse) throw policyError(path, 'malformed ACL')
}

function validSidAt(pointer: NativePtr, offset: number): boolean {
  return decodeUint8(pointer, offset) === 1 && decodeUint8(pointer, offset + 1) <= SID_MAX_SUB_AUTHORITIES
}

function assertOwnerPrivateWith(
  api: FileSecurityBindings,
  path: string,
  kind: OwnerPrivatePathKind,
  requireProtected: boolean,
  sids: TrustedSids,
  ancestor = false,
): void {
  assertNoReparsePath(api, path)
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { throw policyError(path, 'missing path') }
  if ((kind === 'directory' && !stat.isDirectory()) || (kind === 'file' && !stat.isFile())) {
    throw policyError(path, `expected ${kind}`)
  }
  const security = readSecurity(api, path)
  let operationFailed = false
  try {
    const ownerTrusted = [sids.current.pointer, sids.system, sids.administrators, TRUSTED_INSTALLER_SID]
      .some(trustedSid => sameSid(security.owner, 0, trustedSid, 0))
    if (!ownerTrusted) {
      throw policyError(path, ancestor ? 'ancestor owner is not trusted' : 'owner is not the current user')
    }
    if (!ancestor && !sameSid(security.owner, 0, sids.current.pointer, 0)) {
      throw policyError(path, 'owner is not the current user')
    }
    const trusted = ancestor
      ? [sids.current.pointer, sids.system, sids.administrators, TRUSTED_INSTALLER_SID]
      : [sids.current.pointer, sids.system, sids.administrators]
    assertDacl(
      api,
      path,
      security.dacl,
      trusted,
      requireProtected,
      security.descriptor,
      ancestor,
    )
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    try {
      freeLocal(api, security.descriptor, `security descriptor for ${path}`)
    } catch (error) {
      if (!operationFailed) throw error
    }
  }
}

function assertPrivateAncestry(api: FileSecurityBindings, path: string, sids: TrustedSids): void {
  let current = resolve(path)
  for (;;) {
    assertOwnerPrivateWith(api, current, 'directory', false, sids, true)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function buildOwnerPrivateDacl(api: FileSecurityBindings, path: string, sids: TrustedSids): NativePtr {
  const entries = Buffer.alloc(EXPLICIT_ACCESS_W_SIZE * 3)
  const trustees = [sids.current.pointer, sids.system, sids.administrators]
  trustees.forEach((sid, index) => {
    const offset = index * EXPLICIT_ACCESS_W_SIZE
    entries.writeUInt32LE(FILE_ALL_ACCESS, offset)
    entries.writeUInt32LE(GRANT_ACCESS, offset + 4)
    entries.writeUInt32LE(SUB_CONTAINERS_AND_OBJECTS_INHERIT, offset + 8)
    entries.writeUInt32LE(NO_MULTIPLE_TRUSTEE, offset + 24)
    entries.writeUInt32LE(TRUSTEE_IS_SID, offset + 28)
    entries.writeUInt32LE(TRUSTEE_IS_UNKNOWN, offset + 32)
    entries.writeBigUInt64LE(sid, offset + 40)
  })
  const newAclSlot = allocPtrSlot()
  try {
    const mergeResult = api.setEntriesInAclW(3, entries, null, newAclSlot)
    if (mergeResult !== ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', mergeResult, path)
    const newAcl = decodePtr(newAclSlot)
    if (newAcl === null) throw policyError(path, 'SetEntriesInAclW returned a NULL DACL')
    return newAcl
  } finally {
    freeNative(newAclSlot)
  }
}

function createPrivateDirectory(api: FileSecurityBindings, path: string, sids: TrustedSids): void {
  const dacl = buildOwnerPrivateDacl(api, path, sids)
  let descriptor: NativePtr | undefined
  let operationFailed = false
  try {
    descriptor = allocNativeBytes(SECURITY_DESCRIPTOR_SIZE)
    const securityAttributes = Buffer.alloc(SECURITY_ATTRIBUTES_SIZE)
    securityAttributes.writeUInt32LE(SECURITY_ATTRIBUTES_SIZE, 0)
    securityAttributes.writeBigUInt64LE(descriptor, SECURITY_ATTRIBUTES_DESCRIPTOR_OFFSET)
    securityAttributes.writeUInt32LE(0, SECURITY_ATTRIBUTES_INHERIT_OFFSET)
    if (api.initializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION) === 0) {
      throwLastError(api, 'InitializeSecurityDescriptor', path)
    }
    if (api.setSecurityDescriptorOwner(descriptor, sids.current.pointer, 0) === 0) {
      throwLastError(api, 'SetSecurityDescriptorOwner', path)
    }
    if (api.setSecurityDescriptorDacl(descriptor, 1, dacl, 0) === 0) {
      throwLastError(api, 'SetSecurityDescriptorDacl', path)
    }
    if (api.setSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED) === 0) {
      throwLastError(api, 'SetSecurityDescriptorControl', path)
    }
    if (api.createDirectoryW(toNamespacedPath(path), securityAttributes) !== 0) return
    const win32Code = api.getLastError()
    if (win32Code === ERROR_ALREADY_EXISTS) return
    return throwWin32(api, 'CreateDirectoryW', win32Code, path)
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    freeNative(descriptor)
    try {
      freeLocal(api, dacl, `new DACL for ${path}`)
    } catch (error) {
      if (!operationFailed) throw error
    }
  }
}

/**
 * Assert that an existing Windows path is owned by the current user and has a
 * DACL containing only the current user, SYSTEM, and local Administrators.
 *
 * The caller must invoke this only for Windows paths. The check is synchronous
 * so it can guard the synchronous overlay read API. A protected DACL is
 * required when `requireProtected` is true; that mode is used for the overlay
 * root, while descendants may carry the same trusted entries as inherited ACEs.
 * Reparse components, NULL DACLs, malformed ACLs, and unknown ACE types fail
 * closed.
 * @param path - existing path to validate.
 * @param kind - whether the path must be a file or directory.
 * @param requireProtected - require a protected root DACL and no inherited ACEs.
 */
export function assertOwnerPrivateWin32(path: string, kind: OwnerPrivatePathKind, requireProtected = false): void {
  const api = bindings()
  const sids = trustedSids(api)
  let operationError: unknown
  try {
    assertNoReparsePath(api, path)
    assertPrivateAncestry(api, dirname(resolve(path)), sids)
    assertOwnerPrivateWith(api, path, kind, requireProtected, sids)
  } catch (error) {
    operationError = error
    throw error
  } finally {
    try {
      releaseTrustedSids(api, sids)
    } catch (error) {
      if (operationError !== undefined) {
        throw new AggregateError([operationError, error], `${operationFailureMessage(operationError)}; Windows SID cleanup failed`)
      }
      throw error
    }
  }
}
/**
 * Create or validate an owner-private overlay root and install its protected
 * trusted-only DACL before any overlay content is written. When the path is
 * absent, every existing ancestor must prevent untrusted replacement; harmless
 * inherited read/traverse/create-child ACEs are accepted, and existing parents
 * are never rewritten.
 * @param path - overlay root directory to create or validate.
 */
export function createOwnerPrivateDirectoryWin32(path: string): void {
  const api = bindings()
  const sids = trustedSids(api)
  let operationError: unknown
  try {
    createPrivateDirectoryPath(api, path, sids)
    assertOwnerPrivateWith(api, path, 'directory', true, sids)
  } catch (error) {
    operationError = error
    throw error
  } finally {
    try {
      releaseTrustedSids(api, sids)
    } catch (error) {
      if (operationError !== undefined) {
        throw new AggregateError([operationError, error], `${operationFailureMessage(operationError)}; Windows SID cleanup failed`)
      }
      throw error
    }
  }
}
