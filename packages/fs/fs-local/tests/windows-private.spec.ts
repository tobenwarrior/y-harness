/** Host-independent tests for the synchronous owner-private Win32 policy. */

import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir as systemTmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativePtr } from '@yharness/win32-process'

const INHERITED_ACE = 0x10
const FILE_ADD_FILE = 0x2
const FILE_ADD_SUBDIRECTORY = 0x4
const HARMLESS_ANCESTOR_MASK = 0x001200A9 | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY

function tmpdir(): string {
  return process.platform === 'darwin' ? '/private/tmp' : systemTmpdir()
}

interface SecurityState {
  owner: NativePtr
  dacl: NativePtr | null
  descriptor: NativePtr
  protected: boolean
}

interface AclState {
  aces: NativePtr[]
  bytesInUse: number
}

interface NativeFixture {
  currentSid: NativePtr
  systemSid: NativePtr
  administratorsSid: NativePtr
  security: SecurityState
  aclStates: Map<NativePtr, AclState>
  memory: Map<NativePtr, Buffer>
  pointerSlots: Map<NativePtr, NativePtr | null>
  uintSlots: Map<NativePtr, number>
  nextPointer: bigint
  closed: NativePtr[]
  freed: NativePtr[]
  koffiAllocated: Set<NativePtr>
  koffiFreed: Set<NativePtr>
  koffiAllocationCount: number
  koffiThrowAt: number | undefined
  setEntries: Buffer[]
  createDirectoryAttributes: Buffer[]
  createDirectoryPaths: string[]
  events: string[]
  reparseComponents: Set<string>
  behavior: NativeBehavior
  koffi: {
    pointer: (name: string | object) => string
    alloc: (type: string, length: number) => NativePtr
    free: (pointer: NativePtr) => void
    decode: (value: NativePtr | Buffer, offsetOrType: number | string | object, maybeType?: string | object) => number | bigint | null
  }
  allocateSlot(): NativePtr
  allocateUint(): NativePtr
  allocateMemory(value: Buffer): NativePtr
  makeSid(subAuthorities: readonly number[]): NativePtr
  makeAcl(aces: readonly { type: number; sid: NativePtr; flags?: number; mask?: number }[]): NativePtr
}

interface NativeBehavior {
  openProcess: NativePtr | null
  openProcessTokenResult: number
  tokenHandle: NativePtr | null
  tokenInformationLength: number
  tokenInformationResult: number
  tokenSid: NativePtr | null
  convertResult: Map<string, { result: number; pointer: NativePtr | null }>
  getNamedSecurityResult: number
  securityOwner: NativePtr | null
  securityDacl: NativePtr | null
  securityDescriptor: NativePtr | null
  securityByPath: Map<string, { owner: NativePtr | null; dacl: NativePtr | null; descriptor: NativePtr | null }>
  getSecurityDescriptorControlResult: number
  initializeSecurityDescriptorResult: number
  setSecurityDescriptorOwnerResult: number
  setSecurityDescriptorDaclResult: number
  setSecurityDescriptorControlResult: number
  createDirectoryResult: number
  createDirectoryError: number
  createDirectoryRaceCreatesPath: boolean
  getAclInformationResult: number
  getAceResult: number
  getAcePointer: NativePtr | null | undefined
  setEntriesResult: number
  setEntriesPointer: NativePtr | null
  localFreeResult: NativePtr | null
  localFreeFailurePointer: NativePtr | null
  closeHandleThrows: boolean
  closeHandleResult: number
  fileAttributesResult: number | undefined
  fileAttributesThrow: string | undefined
}

interface NativeFunctions {
  CreateDirectoryW: (path: string, securityAttributes: Buffer) => number
  OpenProcess: () => NativePtr | null
  OpenProcessToken: (process: NativePtr, access: number, slot: NativePtr) => number
  GetTokenInformation: (token: NativePtr, informationClass: number, output: Buffer | null, length: number, needed: NativePtr) => number
  ConvertStringSidToSidW: (text: string, slot: NativePtr) => number
  InitializeSecurityDescriptor: (descriptor: NativePtr, revision: number) => number
  SetSecurityDescriptorOwner: (descriptor: NativePtr, owner: NativePtr, ownerDefaulted: number) => number
  SetSecurityDescriptorDacl: (descriptor: NativePtr, daclPresent: number, dacl: NativePtr, daclDefaulted: number) => number
  SetSecurityDescriptorControl: (descriptor: NativePtr, controlBitsOfInterest: number, controlBitsToSet: number) => number
  GetNamedSecurityInfoW: (
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ) => number
  GetSecurityDescriptorControl: (descriptor: NativePtr, control: NativePtr, revision: NativePtr) => number
  GetAclInformation: (acl: NativePtr, information: Buffer, length: number, informationClass: number) => number
  GetAce: (acl: NativePtr, index: number, slot: NativePtr) => number
  SetEntriesInAclW: (count: number, entries: Buffer, oldAcl: NativePtr | null, slot: NativePtr) => number
  LocalFree: (pointer: NativePtr) => NativePtr | null
  GetFileAttributesW: (path: string) => number
  CloseHandle: (handle: NativePtr) => number
  GetLastError: () => number
  FormatMessageW: (flags: number, source: null, id: number, language: number, buffer: Buffer, size: number, args: null) => number
}

interface FsOverrides {
  lstatSync?(path: Parameters<typeof lstatSync>[0]): ReturnType<typeof lstatSync>
}

function fixtureAcl(fixture: NativeFixture): AclState {
  const pointer = fixture.security.dacl
  if (pointer === null) throw new Error('missing ACL fixture')
  const state = fixture.aclStates.get(pointer)
  if (state === undefined) throw new Error('missing ACL fixture')
  return state
}

function createFixture(): NativeFixture {
  const fixture = {} as NativeFixture
  fixture.memory = new Map()
  fixture.pointerSlots = new Map()
  fixture.uintSlots = new Map()
  fixture.aclStates = new Map()
  fixture.nextPointer = 100n
  fixture.closed = []
  fixture.freed = []
  fixture.koffiAllocated = new Set()
  fixture.koffiFreed = new Set()
  fixture.koffiAllocationCount = 0
  fixture.koffiThrowAt = undefined
  fixture.setEntries = []
  fixture.createDirectoryAttributes = []
  fixture.createDirectoryPaths = []
  fixture.events = []
  fixture.reparseComponents = new Set()
  fixture.allocateMemory = (value) => {
    const pointer = fixture.nextPointer as NativePtr
    fixture.nextPointer += 1n
    fixture.memory.set(pointer, value)
    return pointer
  }
  const allocateKoffiMemory = (length: number): NativePtr => {
    fixture.koffiAllocationCount += 1
    if (fixture.koffiThrowAt === fixture.koffiAllocationCount) throw new Error('synthetic Koffi allocation failure')
    const pointer = fixture.allocateMemory(Buffer.alloc(length))
    fixture.koffiAllocated.add(pointer)
    return pointer
  }
  fixture.allocateSlot = () => {
    const pointer = allocateKoffiMemory(8)
    fixture.pointerSlots.set(pointer, null)
    return pointer
  }
  fixture.allocateUint = () => {
    const pointer = allocateKoffiMemory(4)
    fixture.uintSlots.set(pointer, 0)
    return pointer
  }
  fixture.makeSid = (subAuthorities) => {
    const sid = Buffer.alloc(8 + subAuthorities.length * 4)
    sid.writeUInt8(1, 0)
    sid.writeUInt8(subAuthorities.length, 1)
    sid.writeUInt8(5, 7)
    subAuthorities.forEach((value, index) => sid.writeUInt32LE(value, 8 + index * 4))
    return fixture.allocateMemory(sid)
  }
  fixture.makeAcl = (aces) => {
    const pointers = aces.map(({ type, sid, flags = 0, mask = 0x1F01FF }) => {
      const sidBytes = fixture.memory.get(sid)
      if (sidBytes === undefined) throw new Error('missing SID fixture')
      const ace = Buffer.alloc(8 + sidBytes.length)
      ace.writeUInt8(type, 0)
      ace.writeUInt8(flags, 1)
      ace.writeUInt16LE(ace.length, 2)
      ace.writeUInt32LE(mask, 4)
      sidBytes.copy(ace, 8)
      return fixture.allocateMemory(ace)
    })
    const acl = fixture.allocateMemory(Buffer.alloc(8))
    fixture.aclStates.set(acl, {
      aces: pointers,
      bytesInUse: 8 + pointers.reduce((total, pointer) => total + (fixture.memory.get(pointer)?.length ?? 0), 0),
    })
    return acl
  }
  fixture.currentSid = fixture.makeSid([21, 42, 1001])
  fixture.systemSid = fixture.makeSid([18])
  fixture.administratorsSid = fixture.makeSid([32, 544])
  const trustedAcl = fixture.makeAcl([
    { type: 0, sid: fixture.currentSid },
    { type: 0, sid: fixture.systemSid },
    { type: 0, sid: fixture.administratorsSid },
  ])
  fixture.security = {
    owner: fixture.currentSid,
    dacl: trustedAcl,
    descriptor: fixture.allocateMemory(Buffer.alloc(8)),
    protected: true,
  }
  fixture.behavior = {
    openProcess: 10n as NativePtr,
    openProcessTokenResult: 1,
    tokenHandle: 11n as NativePtr,
    tokenInformationLength: 16,
    tokenInformationResult: 1,
    tokenSid: fixture.currentSid,
    convertResult: new Map(),
    getNamedSecurityResult: 0,
    securityOwner: fixture.security.owner,
    securityDacl: fixture.security.dacl,
    securityDescriptor: fixture.security.descriptor,
    securityByPath: new Map(),
    getSecurityDescriptorControlResult: 1,
    initializeSecurityDescriptorResult: 1,
    setSecurityDescriptorOwnerResult: 1,
    setSecurityDescriptorDaclResult: 1,
    setSecurityDescriptorControlResult: 1,
    createDirectoryResult: 1,
    createDirectoryError: 5,
    createDirectoryRaceCreatesPath: false,
    getAclInformationResult: 1,
    getAceResult: 1,
    getAcePointer: undefined,
    setEntriesResult: 0,
    setEntriesPointer: fixture.security.dacl,
    localFreeResult: null,
    localFreeFailurePointer: null,
    closeHandleThrows: false,
    closeHandleResult: 1,
    fileAttributesResult: undefined,
    fileAttributesThrow: undefined,
  }
  fixture.koffi = {
    pointer: () => 'void-pointer',
    alloc: (_type, length) => allocateKoffiMemory(length),
    free: (pointer) => {
      if (!fixture.koffiAllocated.has(pointer)) throw new Error(`unexpected Koffi free ${String(pointer)}`)
      if (fixture.koffiFreed.has(pointer)) throw new Error(`duplicate Koffi free ${String(pointer)}`)
      fixture.koffiFreed.add(pointer)
    },
    decode: (value, offsetOrType, maybeType) => {
      const offset = typeof offsetOrType === 'number' ? offsetOrType : 0
      const type = typeof offsetOrType === 'number' ? maybeType : offsetOrType
      const bytes = Buffer.isBuffer(value) ? value : fixture.memory.get(value)
      if (bytes === undefined) throw new Error(`missing native memory ${String(value)}`)
      if (type === 'void-pointer') return bytes.readBigUInt64LE(offset)
      if (type === 'uint8') return bytes.readUInt8(offset)
      if (type === 'uint16') return bytes.readUInt16LE(offset)
      if (type === 'uint32') return bytes.readUInt32LE(offset)
      const typeName = typeof type === 'string' ? type : 'pointer'
      throw new Error(`unexpected decode type ${typeName}`)
    },
  }
  return fixture
}

function nativeFunctions(fixture: NativeFixture): NativeFunctions {
  return {
    CreateDirectoryW: (path, securityAttributes) => {
      fixture.events.push('CreateDirectoryW')
      fixture.createDirectoryPaths.push(path)
      fixture.createDirectoryAttributes.push(Buffer.from(securityAttributes))
      if (fixture.behavior.createDirectoryResult !== 0) {
        mkdirSync(path)
        return fixture.behavior.createDirectoryResult
      }
      if (fixture.behavior.createDirectoryRaceCreatesPath) mkdirSync(path)
      return 0
    },
    OpenProcess: () => {
      fixture.events.push('OpenProcess')
      return fixture.behavior.openProcess
    },
    OpenProcessToken: (_process, _access, slot) => {
      fixture.pointerSlots.set(slot, fixture.behavior.tokenHandle)
      return fixture.behavior.openProcessTokenResult
    },
    GetTokenInformation: (_token, _class, output, _length, needed) => {
      fixture.uintSlots.set(needed, fixture.behavior.tokenInformationLength)
      if (output !== null && fixture.behavior.tokenSid !== null) output.writeBigUInt64LE(fixture.behavior.tokenSid, 0)
      return output === null ? 0 : fixture.behavior.tokenInformationResult
    },
    ConvertStringSidToSidW: (text, slot) => {
      const configured = fixture.behavior.convertResult.get(text)
      if (configured !== undefined) {
        fixture.pointerSlots.set(slot, configured.pointer)
        return configured.result
      }
      const sid = text === 'S-1-5-18' ? fixture.systemSid : fixture.administratorsSid
      fixture.pointerSlots.set(slot, sid)
      return 1
    },
    InitializeSecurityDescriptor: (_descriptor, _revision) => {
      fixture.events.push('InitializeSecurityDescriptor')
      return fixture.behavior.initializeSecurityDescriptorResult
    },
    SetSecurityDescriptorOwner: (_descriptor, _owner, _ownerDefaulted) => {
      fixture.events.push('SetSecurityDescriptorOwner')
      return fixture.behavior.setSecurityDescriptorOwnerResult
    },
    SetSecurityDescriptorDacl: (_descriptor, _daclPresent, _dacl, _daclDefaulted) => {
      fixture.events.push('SetSecurityDescriptorDacl')
      return fixture.behavior.setSecurityDescriptorDaclResult
    },
    SetSecurityDescriptorControl: (_descriptor, _interest, _set) => {
      fixture.events.push('SetSecurityDescriptorControl')
      return fixture.behavior.setSecurityDescriptorControlResult
    },
    GetNamedSecurityInfoW: (path, _objectType, _information, owner, group, dacl, sacl, descriptor) => {
      const security = fixture.behavior.securityByPath.get(path)
      fixture.pointerSlots.set(owner, security?.owner ?? fixture.behavior.securityOwner)
      fixture.pointerSlots.set(group, null)
      fixture.pointerSlots.set(dacl, security?.dacl ?? fixture.behavior.securityDacl)
      fixture.pointerSlots.set(sacl, null)
      fixture.pointerSlots.set(descriptor, security?.descriptor ?? fixture.behavior.securityDescriptor)
      return fixture.behavior.getNamedSecurityResult
    },
    GetSecurityDescriptorControl: (_descriptor, control) => {
      fixture.uintSlots.set(control, fixture.security.protected ? 0x1000 : 0)
      return fixture.behavior.getSecurityDescriptorControlResult
    },
    GetAclInformation: (acl, information) => {
      if (fixture.behavior.getAclInformationResult === 0) return 0
      const state = fixture.aclStates.get(acl)
      if (state === undefined) return 0
      information.writeUInt32LE(state.aces.length, 0)
      information.writeUInt32LE(state.bytesInUse, 4)
      information.writeUInt32LE(0, 8)
      return 1
    },
    GetAce: (acl, index, slot) => {
      if (fixture.behavior.getAceResult === 0) return 0
      const pointer = fixture.behavior.getAcePointer !== undefined
        ? fixture.behavior.getAcePointer
        : fixture.aclStates.get(acl)?.aces[index]
      fixture.pointerSlots.set(slot, pointer ?? null)
      return pointer === undefined ? 0 : 1
    },
    SetEntriesInAclW: (_count, entries, _oldAcl, slot) => {
      fixture.events.push('SetEntriesInAclW')
      fixture.setEntries.push(Buffer.from(entries))
      fixture.pointerSlots.set(slot, fixture.behavior.setEntriesPointer)
      return fixture.behavior.setEntriesResult
    },
    LocalFree: (pointer) => {
      fixture.freed.push(pointer)
      return fixture.behavior.localFreeFailurePointer === null || fixture.behavior.localFreeFailurePointer === pointer
        ? fixture.behavior.localFreeResult
        : null
    },
    GetFileAttributesW: (path) => {
      if (fixture.behavior.fileAttributesThrow !== undefined) throw fixture.behavior.fileAttributesThrow
      return fixture.behavior.fileAttributesResult
        ?? (fixture.reparseComponents.has(path) ? 0x400 : 0)
    },
    CloseHandle: (handle) => {
      fixture.closed.push(handle)
      if (fixture.behavior.closeHandleThrows) throw new Error('synthetic CloseHandle failure')
      return fixture.behavior.closeHandleResult
    },
    GetLastError: () => fixture.behavior.createDirectoryError,
    FormatMessageW: (_flags, _source, _id, _language, _buffer, _size, _args) => 0,
  }
}

function nativeFunction(native: NativeFunctions, name: string): NativeFunctions[keyof NativeFunctions] {
  switch (name) {
    case 'CreateDirectoryW': return native.CreateDirectoryW
    case 'OpenProcess': return native.OpenProcess
    case 'OpenProcessToken': return native.OpenProcessToken
    case 'GetTokenInformation': return native.GetTokenInformation
    case 'ConvertStringSidToSidW': return native.ConvertStringSidToSidW
    case 'InitializeSecurityDescriptor': return native.InitializeSecurityDescriptor
    case 'SetSecurityDescriptorOwner': return native.SetSecurityDescriptorOwner
    case 'SetSecurityDescriptorDacl': return native.SetSecurityDescriptorDacl
    case 'SetSecurityDescriptorControl': return native.SetSecurityDescriptorControl
    case 'GetNamedSecurityInfoW': return native.GetNamedSecurityInfoW
    case 'GetSecurityDescriptorControl': return native.GetSecurityDescriptorControl
    case 'GetAclInformation': return native.GetAclInformation
    case 'GetAce': return native.GetAce
    case 'SetEntriesInAclW': return native.SetEntriesInAclW
    case 'LocalFree': return native.LocalFree
    case 'GetFileAttributesW': return native.GetFileAttributesW
    default: throw new Error(`unexpected native function ${name}`)
  }
}

function nodeError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

function invalidSid(fixture: NativeFixture, revision = 2, count = 0): NativePtr {
  const sid = Buffer.alloc(8 + count * 4)
  sid.writeUInt8(revision, 0)
  sid.writeUInt8(count, 1)
  for (let index = 0; index < count; index += 1) sid.writeUInt32LE(index, 8 + index * 4)
  return fixture.allocateMemory(sid)
}

async function importWithFixture(fixture: NativeFixture, fsOverrides: FsOverrides = {}): Promise<typeof import('../src/windows-private.ts')> {
  const native = nativeFunctions(fixture)
  vi.resetModules()
  if (Object.keys(fsOverrides).length > 0) {
    vi.doMock('node:fs', async () => ({
      ...await vi.importActual<typeof import('node:fs')>('node:fs'),
      ...fsOverrides,
    }))
  }
  vi.doMock('@yharness/lazy-require', () => ({
    createLazyRequire: () => () => fixture.koffi,
  }))
  vi.doMock('@yharness/win32-process', () => ({
    allocPtrSlot: () => fixture.allocateSlot(),
    allocUint32: () => fixture.allocateUint(),
    decodePtr: (slot: NativePtr) => fixture.pointerSlots.get(slot) ?? null,
    decodeUint32: (slot: NativePtr) => fixture.uintSlots.get(slot) ?? 0,
    extendWin32ProcessBindings: (
      create: (context: {
        kernel32: object
        advapi32: object
        bind: (library: object, name: string) => unknown
      }) => Record<string, unknown>,
    ) => ({
      closeHandle: (handle: NativePtr) => native.CloseHandle(handle),
      getLastError: () => native.GetLastError(),
      formatMessageW: (
        flags: number,
        source: null,
        id: number,
        language: number,
        buffer: Buffer,
        size: number,
        args: null,
      ) => native.FormatMessageW(flags, source, id, language, buffer, size, args),
      ...create({
        kernel32: {},
        advapi32: {},
        bind: (_library, name) => {
          return nativeFunction(native, name)
        },
      }),
    }),
    isNullPtr: (value: NativePtr | null | undefined) => value === null || value === undefined || value === 0n,
    throwLastError: (_api: object, name: string, detail?: string): never => { throw new Error(`${name}: ${detail ?? 'native error'}`) },
    throwWin32: (_api: object, name: string, code: number, detail?: string): never => { throw new Error(`${name} (${code}): ${detail ?? 'native error'}`) },
  }))
  return import('../src/windows-private.ts')
}

function expectNoKoffiLeaks(fixture: NativeFixture): void {
  const outstanding = [...fixture.koffiAllocated].filter(pointer => !fixture.koffiFreed.has(pointer))
  expect(outstanding).toEqual([])
}

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.doUnmock('@yharness/lazy-require')
  vi.doUnmock('@yharness/win32-process')
  vi.resetModules()
})

describe('owner-private Windows security', () => {
  it('accepts a current-user protected ACL containing only trusted trustees', async () => {
    const fixture = createFixture()
    const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(directory, 'directory', true) }).not.toThrow()
      expect(() => { assertOwnerPrivateWin32(directory, 'directory', true) }).not.toThrow()
      expect(fixture.closed).toEqual([11n, 10n, 11n, 10n])
      expect(fixture.freed).toEqual([
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.systemSid,
        fixture.administratorsSid,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.systemSid,
        fixture.administratorsSid,
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects an untrusted ACE and releases the descriptor and converted SIDs', async () => {
    const fixture = createFixture()
    const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const untrusted = fixture.makeSid([32, 545])
    fixture.security.dacl = fixture.makeAcl([{ type: 0, sid: untrusted }])
    fixture.behavior.securityDacl = fixture.security.dacl
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(directory, 'directory') }).toThrow(/untrusted ACE/u)
      expect(fixture.freed).toEqual([fixture.security.descriptor, fixture.systemSid, fixture.administratorsSid])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects NULL DACLs, unprotected roots, and unknown ACE types', async () => {
    const cases = [
      {
        name: 'NULL DACL',
        change: (fixture: NativeFixture) => { fixture.security.dacl = null; fixture.behavior.securityDacl = null },
        expected: /NULL DACL/u,
      },
      {
        name: 'unprotected root',
        change: (fixture: NativeFixture) => { fixture.security.protected = false },
        expected: /DACL inheritance is not protected/u,
      },
      {
        name: 'unknown ACE type',
        change: (fixture: NativeFixture) => {
          fixture.security.dacl = fixture.makeAcl([{ type: 5, sid: fixture.currentSid }])
          fixture.behavior.securityDacl = fixture.security.dacl
        },
        expected: /unrecognized ACE type/u,
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
      testCase.change(fixture)
      try {
        const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
        expect(() => { assertOwnerPrivateWin32(directory, 'directory', true) }, testCase.name).toThrow(testCase.expected)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  it('rejects native security read failures and missing descriptor fields', async () => {
    const cases = [
      {
        name: 'GetNamedSecurityInfoW failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.getNamedSecurityResult = 5 },
        expected: /GetNamedSecurityInfoW/u,
      },
      {
        name: 'NULL owner',
        configure: (fixture: NativeFixture) => { fixture.behavior.securityOwner = null },
        expected: /NULL owner/u,
      },
      {
        name: 'NULL descriptor',
        configure: (fixture: NativeFixture) => { fixture.behavior.securityDescriptor = null },
        expected: /NULL DACL/u,
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
      testCase.configure(fixture)
      try {
        const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
        expect(() => { assertOwnerPrivateWin32(directory, 'directory') }, testCase.name).toThrow(testCase.expected)
        if (testCase.name === 'NULL descriptor') expect(fixture.freed).not.toContain(fixture.security.descriptor)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  it('rejects owner mismatches, identifier-authority mismatches, and close failures safely', async () => {
    const ownerFixture = createFixture()
    const ownerDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    ownerFixture.behavior.securityByPath.set(ownerDirectory, {
      owner: ownerFixture.makeSid([21, 42, 1002]),
      dacl: ownerFixture.security.dacl,
      descriptor: ownerFixture.security.descriptor,
    })
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(ownerFixture)
      expect(() => { assertOwnerPrivateWin32(ownerDirectory, 'directory') }).toThrow(/owner is not the current user/u)
    } finally {
      rmSync(ownerDirectory, { recursive: true, force: true })
    }

    const trustedNonOwnerFixture = createFixture()
    const trustedNonOwnerDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    trustedNonOwnerFixture.behavior.securityByPath.set(trustedNonOwnerDirectory, {
      owner: trustedNonOwnerFixture.systemSid,
      dacl: trustedNonOwnerFixture.security.dacl,
      descriptor: trustedNonOwnerFixture.security.descriptor,
    })
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(trustedNonOwnerFixture)
      expect(() => { assertOwnerPrivateWin32(trustedNonOwnerDirectory, 'directory') }).toThrow(/owner is not the current user/u)
    } finally {
      rmSync(trustedNonOwnerDirectory, { recursive: true, force: true })
    }

    const authorityFixture = createFixture()
    const authorityDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const authoritySid = authorityFixture.makeSid([21, 42, 1001])
    const authorityBytes = authorityFixture.memory.get(authoritySid)
    if (authorityBytes === undefined) throw new Error('missing authority SID fixture')
    authorityBytes.writeUInt8(6, 7)
    authorityFixture.security.dacl = authorityFixture.makeAcl([{ type: 0, sid: authoritySid }])
    authorityFixture.behavior.securityDacl = authorityFixture.security.dacl
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(authorityFixture)
      expect(() => { assertOwnerPrivateWin32(authorityDirectory, 'directory') }).toThrow(/untrusted ACE/u)
    } finally {
      rmSync(authorityDirectory, { recursive: true, force: true })
    }

    const revisionFixture = createFixture()
    const revisionDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const revisionSid = revisionFixture.makeSid([21, 42, 1001])
    const revisionBytes = revisionFixture.memory.get(revisionSid)
    if (revisionBytes === undefined) throw new Error('missing revision SID fixture')
    revisionBytes.writeUInt8(2, 0)
    revisionFixture.behavior.securityByPath.set(revisionDirectory, {
      owner: revisionSid,
      dacl: revisionFixture.security.dacl,
      descriptor: revisionFixture.security.descriptor,
    })
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(revisionFixture)
      expect(() => { assertOwnerPrivateWin32(revisionDirectory, 'directory') }).toThrow(/owner is not the current user/u)
    } finally {
      rmSync(revisionDirectory, { recursive: true, force: true })
    }

    const closeFixture = createFixture()
    const closeDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    closeFixture.behavior.closeHandleResult = 0
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(closeFixture)
      expect(() => { assertOwnerPrivateWin32(closeDirectory, 'directory') }).toThrow(/Windows handle cleanup failed/u)
    } finally {
      rmSync(closeDirectory, { recursive: true, force: true })
    }
  })

  it('reports native file-attribute and ACL inspection failures', async () => {
    const cases = [
      {
        name: 'GetFileAttributesW failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.fileAttributesResult = 0xFFFFFFFF },
        expected: /GetFileAttributesW/u,
      },
      {
        name: 'GetSecurityDescriptorControl failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.getSecurityDescriptorControlResult = 0 },
        expected: /GetSecurityDescriptorControl/u,
      },
      {
        name: 'GetAclInformation failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.getAclInformationResult = 0 },
        expected: /GetAclInformation/u,
      },
      {
        name: 'GetAce failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.getAceResult = 0 },
        expected: /GetAce/u,
      },
      {
        name: 'NULL ACE',
        configure: (fixture: NativeFixture) => { fixture.behavior.getAcePointer = null },
        expected: /NULL ACE/u,
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
      testCase.configure(fixture)
      try {
        const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
        expect(() => { assertOwnerPrivateWin32(directory, 'directory', true) }, testCase.name).toThrow(testCase.expected)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  it('rejects malformed ACL, ACE, SID, and inheritance records', async () => {
    const cases = [
      {
        name: 'ACL shorter than its header',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          state.bytesInUse = 0
        },
        expected: /malformed ACL/u,
      },
      {
        name: 'ACE shorter than its header',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          const ace = state.aces[0]
          if (ace === undefined) throw new Error('missing ACE fixture')
          const bytes = fixture.memory.get(ace)
          if (bytes === undefined) throw new Error('missing ACE memory')
          bytes.writeUInt16LE(4, 2)
        },
        expected: /malformed ACE/u,
      },
      {
        name: 'ACE with unaligned size',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          const ace = state.aces[0]
          if (ace === undefined) throw new Error('missing ACE fixture')
          const bytes = fixture.memory.get(ace)
          if (bytes === undefined) throw new Error('missing ACE memory')
          bytes.writeUInt16LE(10, 2)
        },
        expected: /malformed ACE/u,
      },
      {
        name: 'ACE extending beyond ACL bytes',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          const ace = state.aces[0]
          if (ace === undefined) throw new Error('missing ACE fixture')
          const bytes = fixture.memory.get(ace)
          if (bytes === undefined) throw new Error('missing ACE memory')
          bytes.writeUInt16LE(40, 2)
        },
        expected: /malformed ACE/u,
      },
      {
        name: 'inherited protected-root ACE',
        configure: (fixture: NativeFixture) => {
          const acl = fixture.makeAcl([{ type: 0, sid: fixture.currentSid, flags: 0x10 }])
          fixture.security.dacl = acl
          fixture.behavior.securityDacl = acl
        },
        expected: /inherited ACE/u,
      },
      {
        name: 'SID with too many sub-authorities',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          const ace = state.aces[0]
          if (ace === undefined) throw new Error('missing ACE fixture')
          const bytes = fixture.memory.get(ace)
          if (bytes === undefined) throw new Error('missing ACE memory')
          bytes.writeUInt8(16, 9)
        },
        expected: /malformed ACE SID/u,
      },
      {
        name: 'SID extending beyond ACE',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          const ace = state.aces[0]
          if (ace === undefined) throw new Error('missing ACE fixture')
          const bytes = fixture.memory.get(ace)
          if (bytes === undefined) throw new Error('missing ACE memory')
          bytes.writeUInt8(4, 9)
        },
        expected: /malformed ACE SID/u,
      },
      {
        name: 'SID with an invalid revision',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          const ace = state.aces[0]
          if (ace === undefined) throw new Error('missing ACE fixture')
          const bytes = fixture.memory.get(ace)
          if (bytes === undefined) throw new Error('missing ACE memory')
          bytes.writeUInt8(2, 8)
        },
        expected: /malformed ACE SID/u,
      },
      {
        name: 'ACL with trailing bytes',
        configure: (fixture: NativeFixture) => {
          const state = fixtureAcl(fixture)
          state.bytesInUse += 4
        },
        expected: /malformed ACL/u,
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
      testCase.configure(fixture)
      try {
        const { assertOwnerPrivateWin32 } = await importWithFixture(fixture, {})
        expect(() => { assertOwnerPrivateWin32(directory, 'directory', true) }, testCase.name).toThrow(testCase.expected)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }

    const deniedFixture = createFixture()
    const deniedDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const deniedAcl = deniedFixture.makeAcl([{ type: 1, sid: deniedFixture.currentSid }])
    deniedFixture.security.dacl = deniedAcl
    deniedFixture.behavior.securityDacl = deniedAcl
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(deniedFixture)
      expect(() => { assertOwnerPrivateWin32(deniedDirectory, 'directory', true) }).not.toThrow()
    } finally {
      rmSync(deniedDirectory, { recursive: true, force: true })
    }
  })

  it('does not hide cleanup failures from native descriptor and SID releases', async () => {
    const fixture = createFixture()
    const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    fixture.behavior.localFreeResult = fixture.systemSid
    fixture.behavior.localFreeFailurePointer = fixture.systemSid
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(directory, 'directory') }).toThrow(/Windows SID cleanup failed/u)
      expect(fixture.freed).toEqual([
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.security.descriptor,
        fixture.systemSid,
        fixture.administratorsSid,
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports descriptor cleanup failure after a successful policy check', async () => {
    const fixture = createFixture()
    const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    fixture.behavior.localFreeResult = fixture.systemSid
    fixture.behavior.localFreeFailurePointer = fixture.security.descriptor
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(directory, 'directory') }).toThrow(/security descriptor/u)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports DACL cleanup failure after secure directory creation', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    fixture.behavior.localFreeResult = fixture.systemSid
    fixture.behavior.localFreeFailurePointer = fixture.behavior.setEntriesPointer
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).toThrow(/new DACL/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('reports SID cleanup failure after successful secure creation', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    fixture.behavior.localFreeResult = fixture.systemSid
    fixture.behavior.localFreeFailurePointer = fixture.systemSid
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).toThrow(/Windows SID cleanup failed/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('preserves policy failures when SID cleanup also fails', async () => {
    const cases = [
      {
        name: 'assertion',
        run: async (fixture: NativeFixture, path: string) => {
          const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
          expect(() => { assertOwnerPrivateWin32(path, 'directory') }).toThrow(/untrusted ACE/u)
        },
      },
      {
        name: 'creation',
        run: async (fixture: NativeFixture, path: string) => {
          const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
          expect(() => { createOwnerPrivateDirectoryWin32(path) }).toThrow(/untrusted ACE/u)
        },
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
      const path = testCase.name === 'assertion' ? parent : join(parent, 'overlay')
      if (testCase.name === 'creation') mkdirSync(path)
      fixture.security.dacl = fixture.makeAcl([{ type: 0, sid: fixture.makeSid([32, 545]) }])
      fixture.behavior.securityDacl = fixture.security.dacl
      fixture.behavior.localFreeResult = fixture.systemSid
      try {
        await testCase.run(fixture, path)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    }
  })

  it('normalizes a non-Error native failure while preserving cleanup context', async () => {
    const fixture = createFixture()
    const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    fixture.behavior.fileAttributesThrow = 'synthetic native failure'
    fixture.behavior.localFreeResult = fixture.systemSid
    fixture.behavior.localFreeFailurePointer = fixture.systemSid
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(directory, 'directory') }).toThrow(/Windows operation failed; Windows SID cleanup failed/u)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when CreateDirectoryW rejects a new target', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    fixture.behavior.createDirectoryResult = 0
    fixture.behavior.createDirectoryError = 5
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).toThrow(/CreateDirectoryW/u)
      expect(fixture.freed).toContain(fixture.behavior.setEntriesPointer)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('preserves a CreateDirectoryW failure when DACL cleanup also fails', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    fixture.behavior.createDirectoryResult = 0
    fixture.behavior.createDirectoryError = 5
    fixture.behavior.localFreeResult = fixture.systemSid
    fixture.behavior.localFreeFailurePointer = fixture.behavior.setEntriesPointer
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).toThrow(/CreateDirectoryW/u)
      expect(fixture.freed).toContain(fixture.behavior.setEntriesPointer)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails closed when Windows refuses to install the trusted DACL', async () => {
    const cases = [
      {
        name: 'SetEntriesInAclW failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.setEntriesResult = 5 },
        expected: /SetEntriesInAclW/u,
      },
      {
        name: 'NULL DACL from SetEntriesInAclW',
        configure: (fixture: NativeFixture) => { fixture.behavior.setEntriesPointer = null },
        expected: /returned a NULL DACL/u,
      },
      {
        name: 'InitializeSecurityDescriptor failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.initializeSecurityDescriptorResult = 0 },
        expected: /InitializeSecurityDescriptor/u,
      },
      {
        name: 'SetSecurityDescriptorOwner failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.setSecurityDescriptorOwnerResult = 0 },
        expected: /SetSecurityDescriptorOwner/u,
      },
      {
        name: 'SetSecurityDescriptorDacl failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.setSecurityDescriptorDaclResult = 0 },
        expected: /SetSecurityDescriptorDacl/u,
      },
      {
        name: 'SetSecurityDescriptorControl failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.setSecurityDescriptorControlResult = 0 },
        expected: /SetSecurityDescriptorControl/u,
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
      const directory = join(parent, 'overlay')
      testCase.configure(fixture)
      try {
        const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
        expect(() => { createOwnerPrivateDirectoryWin32(directory) }, testCase.name).toThrow(testCase.expected)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    }
  })

  it('reproduces the pre-fix inherited-ACL admission window', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      createOwnerPrivateDirectoryWin32(directory)
      expect(fixture.events).toEqual([
        'OpenProcess',
        'SetEntriesInAclW',
        'InitializeSecurityDescriptor',
        'SetSecurityDescriptorOwner',
        'SetSecurityDescriptorDacl',
        'SetSecurityDescriptorControl',
        'CreateDirectoryW',
      ])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects reparse components before reading their security descriptor', async () => {
    const fixture = createFixture()
    const directory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const reparsePath = join(directory, 'reparse')
    mkdirSync(reparsePath)
    fixture.reparseComponents.add(reparsePath)
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(reparsePath, 'directory') }).toThrow(/reparse path component/u)
      expect(fixture.freed).toEqual([fixture.systemSid, fixture.administratorsSid])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('creates a root, applies a protected trusted-only DACL, and validates it', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).not.toThrow()
      expect(fixture.setEntries).toHaveLength(1)
      expect(fixture.setEntries[0]).toHaveLength(48 * 3)
      expect(fixture.createDirectoryAttributes).toHaveLength(1)
      expect(fixture.createDirectoryAttributes[0]?.readUInt32LE(0)).toBe(24)
      expect(fixture.createDirectoryAttributes[0]?.readBigUInt64LE(8)).not.toBe(0n)
      expect(fixture.createDirectoryAttributes[0]?.readUInt32LE(16)).toBe(0)
      expect(fixture.freed).toContain(fixture.security.descriptor)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('releases all Koffi-owned allocations on success and native failures', async () => {
    const successFixture = createFixture()
    const successParent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(successFixture)
      createOwnerPrivateDirectoryWin32(join(successParent, 'overlay'))
      expectNoKoffiLeaks(successFixture)
    } finally {
      rmSync(successParent, { recursive: true, force: true })
    }

    const createFailureFixture = createFixture()
    const createFailureParent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    createFailureFixture.behavior.createDirectoryResult = 0
    createFailureFixture.behavior.createDirectoryError = 5
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(createFailureFixture)
      expect(() => { createOwnerPrivateDirectoryWin32(join(createFailureParent, 'overlay')) }).toThrow(/CreateDirectoryW/u)
      expectNoKoffiLeaks(createFailureFixture)
    } finally {
      rmSync(createFailureParent, { recursive: true, force: true })
    }

    const readFailureFixture = createFixture()
    const readFailureDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    readFailureFixture.behavior.getNamedSecurityResult = 5
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(readFailureFixture)
      expect(() => { assertOwnerPrivateWin32(readFailureDirectory, 'directory') }).toThrow(/GetNamedSecurityInfoW/u)
      expectNoKoffiLeaks(readFailureFixture)
    } finally {
      rmSync(readFailureDirectory, { recursive: true, force: true })
    }

    const allocationFailureFixture = createFixture()
    const allocationFailureDirectory = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    allocationFailureFixture.koffiThrowAt = 6
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(allocationFailureFixture)
      expect(() => { assertOwnerPrivateWin32(allocationFailureDirectory, 'directory') }).toThrow(/Koffi allocation failure/u)
      expectNoKoffiLeaks(allocationFailureFixture)
    } finally {
      rmSync(allocationFailureDirectory, { recursive: true, force: true })
    }
  })

  it('creates missing parent directories before applying the protected root policy', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'missing-parent', 'overlay')
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).not.toThrow()
      expect(fixture.setEntries).toHaveLength(2)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses creation and existing-root use below an unsafe parent', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const missingRoot = join(parent, 'missing-overlay')
    const unsafeAcl = fixture.makeAcl([{ type: 0, sid: fixture.makeSid([32, 545]) }])
    fixture.behavior.securityByPath.set(parent, {
      owner: fixture.currentSid,
      dacl: unsafeAcl,
      descriptor: fixture.security.descriptor,
    })
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(missingRoot) }).toThrow(/untrusted ACE/u)
      expect(fixture.createDirectoryPaths).toEqual([])
      mkdirSync(missingRoot)
      expect(() => { createOwnerPrivateDirectoryWin32(missingRoot) }).toThrow(/untrusted ACE/u)
      expect(fixture.createDirectoryPaths).toEqual([])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('allows inherited read-traverse access but checks every existing ancestor', async () => {
    const fixture = createFixture()
    const grandparent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const safeParent = join(grandparent, 'safe-parent')
    const directory = join(safeParent, 'overlay')
    mkdirSync(safeParent)
    const harmlessSid = fixture.makeSid([32, 545])
    const trustedInstaller = fixture.makeSid([80, 956008885, 3418522649, 1831038044, 1853292631, 2271478464])
    const inheritedAcl = fixture.makeAcl([
      { type: 0, sid: fixture.currentSid },
      { type: 0, sid: trustedInstaller },
      { type: 0, sid: harmlessSid, flags: INHERITED_ACE, mask: HARMLESS_ANCESTOR_MASK },
      { type: 1, sid: harmlessSid, flags: INHERITED_ACE },
      { type: 0, sid: harmlessSid, flags: INHERITED_ACE | 0x08 },
    ])
    fixture.behavior.securityByPath.set(safeParent, {
      owner: fixture.currentSid,
      dacl: inheritedAcl,
      descriptor: fixture.security.descriptor,
    })
    fixture.behavior.securityByPath.set(grandparent, {
      owner: trustedInstaller,
      dacl: fixture.security.dacl,
      descriptor: fixture.security.descriptor,
    })
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).not.toThrow()

      const dangerousMasks = [0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000]
      for (const mask of dangerousMasks) {
        const dangerousFixture = createFixture()
        const dangerousSid = dangerousFixture.makeSid([32, 545])
        const dangerousAcl = dangerousFixture.makeAcl([{ type: 0, sid: dangerousSid, mask }])
        dangerousFixture.behavior.securityByPath.set(grandparent, {
          owner: dangerousFixture.currentSid,
          dacl: dangerousAcl,
          descriptor: dangerousFixture.security.descriptor,
        })
        const dangerous = await importWithFixture(dangerousFixture)
        const existing = join(safeParent, `existing-${mask}`)
        mkdirSync(existing)
        expect(() => { dangerous.assertOwnerPrivateWin32(existing, 'directory', true) }).toThrow(/untrusted ACE/u)
        expect(() => { dangerous.createOwnerPrivateDirectoryWin32(join(safeParent, `blocked-${mask}`)) }).toThrow(/untrusted ACE/u)
        expect(dangerousFixture.createDirectoryPaths).toEqual([])
      }

      const ownerFixture = createFixture()
      const untrustedOwner = ownerFixture.makeSid([32, 545])
      ownerFixture.behavior.securityByPath.set(grandparent, {
        owner: untrustedOwner,
        dacl: ownerFixture.security.dacl,
        descriptor: ownerFixture.security.descriptor,
      })
      const ownerModule = await importWithFixture(ownerFixture)
      expect(() => { ownerModule.createOwnerPrivateDirectoryWin32(join(safeParent, 'blocked-owner')) }).toThrow(/ancestor owner is not trusted/u)
    } finally {
      rmSync(grandparent, { recursive: true, force: true })
    }
  })

  it('accepts a concurrent directory creation only when the raced path validates', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'missing-parent', 'overlay')
    fixture.behavior.createDirectoryResult = 0
    fixture.behavior.createDirectoryError = 183
    fixture.behavior.createDirectoryRaceCreatesPath = true
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).not.toThrow()
      expect(fixture.createDirectoryPaths).toHaveLength(2)
      expect(fixture.setEntries).toHaveLength(2)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects a non-directory parent and preserves non-ENOENT filesystem errors', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const fileParent = join(parent, 'file-parent')
    const nonDirectoryTarget = join(fileParent, 'child')
    const deniedTarget = join(parent, 'denied-parent', 'child')
    writeFileSync(fileParent, '{}')
    try {
      const nonDirectoryFixture = createFixture()
      const nonDirectoryFs: FsOverrides = {
        lstatSync: (path) => {
          if (String(path) === nonDirectoryTarget) throw nodeError('ENOENT')
          return lstatSync(path)
        },
      }
      const nonDirectory = await importWithFixture(nonDirectoryFixture, nonDirectoryFs)
      expect(() => { nonDirectory.createOwnerPrivateDirectoryWin32(nonDirectoryTarget) }).toThrow(/parent is not a directory/u)

      const deniedFixture = createFixture()
      const deniedFs: FsOverrides = {
        lstatSync: (path) => {
          if (String(path) === deniedTarget) throw nodeError('EACCES')
          return lstatSync(path)
        },
      }
      const denied = await importWithFixture(deniedFixture, deniedFs)
      expect(() => { denied.createOwnerPrivateDirectoryWin32(deniedTarget) }).toThrow(/EACCES/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails when every filesystem root component is missing', async () => {
    const fixture = createFixture()
    const target = '/synthetic-missing-root'
    const fsOverrides: FsOverrides = {
      lstatSync: () => { throw nodeError('ENOENT') },
    }
    const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture, fsOverrides)
    expect(() => { createOwnerPrivateDirectoryWin32(target) }).toThrow(/missing filesystem root/u)
  })

  it('propagates a non-EEXIST initial directory creation error', async () => {
    const fixture = createFixture()
    fixture.behavior.createDirectoryResult = 0
    fixture.behavior.createDirectoryError = 5
    const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
    expect(() => { createOwnerPrivateDirectoryWin32('/synthetic-denied') }).toThrow(/CreateDirectoryW/u)
  })

  it('refuses an existing unsafe root instead of replacing its DACL', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const directory = join(parent, 'overlay')
    mkdirSync(directory)
    fixture.security.dacl = fixture.makeAcl([{ type: 0, sid: fixture.makeSid([32, 545]) }])
    fixture.behavior.securityDacl = fixture.security.dacl
    try {
      const { createOwnerPrivateDirectoryWin32 } = await importWithFixture(fixture)
      expect(() => { createOwnerPrivateDirectoryWin32(directory) }).toThrow(/untrusted ACE/u)
      expect(fixture.setEntries).toHaveLength(0)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('validates files and rejects the opposite path kinds', async () => {
    const fixture = createFixture()
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-'))
    const file = join(parent, 'current.json')
    writeFileSync(file, '{}')
    try {
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32(file, 'file') }).not.toThrow()
      expect(() => { assertOwnerPrivateWin32(file, 'directory') }).toThrow(/expected directory/u)
      expect(() => { assertOwnerPrivateWin32(parent, 'file') }).toThrow(/expected file/u)
      expect(() => { assertOwnerPrivateWin32(join(parent, 'missing'), 'directory') }).toThrow(/missing path/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails closed when process and token discovery returns unsafe results', async () => {
    const cases = [
      {
        name: 'OpenProcess failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.openProcess = null },
        expected: /OpenProcess/u,
      },
      {
        name: 'OpenProcessToken failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.openProcessTokenResult = 0 },
        expected: /OpenProcessToken/u,
      },
      {
        name: 'NULL token handle',
        configure: (fixture: NativeFixture) => { fixture.behavior.tokenHandle = null },
        expected: /NULL token handle/u,
      },
      {
        name: 'short TokenUser buffer',
        configure: (fixture: NativeFixture) => { fixture.behavior.tokenInformationLength = 4 },
        expected: /TokenUser size query/u,
      },
      {
        name: 'TokenUser query failure',
        configure: (fixture: NativeFixture) => { fixture.behavior.tokenInformationResult = 0 },
        expected: /TokenUser/u,
      },
      {
        name: 'NULL TokenUser SID',
        configure: (fixture: NativeFixture) => { fixture.behavior.tokenSid = null },
        expected: /invalid TokenUser SID/u,
      },
      {
        name: 'invalid TokenUser SID',
        configure: (fixture: NativeFixture) => { fixture.behavior.tokenSid = invalidSid(fixture) },
        expected: /invalid TokenUser SID/u,
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      testCase.configure(fixture)
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32('/synthetic/missing', 'directory') }, testCase.name).toThrow(testCase.expected)
      const expectedClosed: NativePtr[] = []
      if (fixture.behavior.openProcess !== null) {
        if (fixture.behavior.openProcessTokenResult !== 0 && fixture.behavior.tokenHandle !== null) {
          expectedClosed.push(fixture.behavior.tokenHandle)
        }
        expectedClosed.push(fixture.behavior.openProcess)
      }
      expect(fixture.closed).toEqual(expectedClosed)
    }
  })

  it('fails closed on invalid converted trusted SIDs and cleans allocated native memory', async () => {
    const cases = [
      {
        name: 'conversion failure',
        configure: (fixture: NativeFixture) => {
          fixture.behavior.convertResult.set('S-1-5-18', { result: 0, pointer: null })
        },
        expected: /ConvertStringSidToSidW/u,
        freed: () => [],
      },
      {
        name: 'NULL converted SID',
        configure: (fixture: NativeFixture) => {
          fixture.behavior.convertResult.set('S-1-5-18', { result: 1, pointer: null })
        },
        expected: /NULL SID/u,
        freed: () => [],
      },
      {
        name: 'invalid converted SID',
        configure: (fixture: NativeFixture) => {
          fixture.behavior.convertResult.set('S-1-5-18', { result: 1, pointer: invalidSid(fixture) })
        },
        expected: /invalid SID/u,
        freed: (fixture: NativeFixture) => {
          const pointer = fixture.behavior.convertResult.get('S-1-5-18')?.pointer
          return pointer === null || pointer === undefined ? [] : [pointer]
        },
      },
      {
        name: 'administrator conversion failure after SYSTEM allocation',
        configure: (fixture: NativeFixture) => {
          fixture.behavior.convertResult.set('S-1-5-32-544', { result: 0, pointer: null })
        },
        expected: /ConvertStringSidToSidW/u,
        freed: (fixture: NativeFixture) => [fixture.systemSid],
      },
      {
        name: 'administrator conversion cleanup failure',
        configure: (fixture: NativeFixture) => {
          fixture.behavior.convertResult.set('S-1-5-32-544', { result: 0, pointer: null })
          fixture.behavior.localFreeResult = fixture.systemSid
        },
        expected: /Windows SID cleanup failed/u,
        freed: (fixture: NativeFixture) => [fixture.systemSid],
      },
    ]
    for (const testCase of cases) {
      const fixture = createFixture()
      testCase.configure(fixture)
      const { assertOwnerPrivateWin32 } = await importWithFixture(fixture)
      expect(() => { assertOwnerPrivateWin32('/synthetic/missing', 'directory') }, testCase.name).toThrow(testCase.expected)
      expect(fixture.freed).toEqual(testCase.freed(fixture))
    }
  })
})
