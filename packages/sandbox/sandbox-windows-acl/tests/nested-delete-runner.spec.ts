/** Native regression for ambient parent-delete authority below another session's granted roots. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import { describe, expect, it } from 'vitest'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { AclWriteGrant, tempWriteSid, workspaceWriteSid } from '../src/index.ts'
import { allocPtrSlot, decodePtr, win32 } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
const nativeWindows = process.platform === 'win32'
  && spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true']).status === 0
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

function pwsh(script: string): string {
  const result = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 15_000,
  })
  expect(result.status, `fixture stderr: ${result.stderr}`).toBe(0)
  return result.stdout
}

/** Read the mandatory label independently of localized icacls display text. */
async function hasLowNoWriteUpLabel(path: string): Promise<boolean> {
  const api = await win32()
  const owner = allocPtrSlot(); const group = allocPtrSlot(); const dacl = allocPtrSlot()
  const sacl = allocPtrSlot(); const descriptor = allocPtrSlot()
  const result = api.getNamedSecurityInfoW(path, abi.SE_FILE_OBJECT, abi.LABEL_SECURITY_INFORMATION,
    owner, group, dacl, sacl, descriptor)
  expect(result, `mandatory label read: ${path}`).toBe(abi.ERROR_SUCCESS)
  const pointer = decodePtr(sacl); const allocation = decodePtr(descriptor)
  try {
    if (pointer === null) return false
    const size = koffi.decode(pointer, 2, 'uint16') as number
    for (let offset = 8; offset + 20 <= size;) {
      const aceSize = koffi.decode(pointer, offset + 2, 'uint16') as number
      expect(aceSize).toBeGreaterThanOrEqual(20)
      const type = koffi.decode(pointer, offset, 'uint8') as number
      const mask = koffi.decode(pointer, offset + 4, 'uint32') as number
      const sid = koffi.decode(pointer, offset + 8, 'uint8[12]') as number[]
      if (type === abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE && (mask & abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP) !== 0
        && Buffer.from(sid).equals(Buffer.from([1, 1, 0, 0, 0, 0, 0, 16, 0, 16, 0, 0]))) return true
      offset += aceSize
    }
    return false
  } finally {
    if (allocation !== null) api.localFree(allocation)
  }
}

describe.skipIf(!nativeWindows)('Windows preexisting-directory cross-root delete confinement', () => {
  it.each(['read-only', 'workspace-write'] as const)(
    '%s: keeps foreign workspace/temp victims without own DELETE, with own-session controls', async (mode) => {
      const scratch = mkdtempSync(join(tmpdir(), 'dsh-acl-nested-delete-'))
      const ownWork = join(scratch, 'own-work'); const ownTemp = join(scratch, 'own-temp')
      const foreignWork = join(scratch, 'foreign-work'); const foreignTemp = join(scratch, 'foreign-temp')
      const children = [join(foreignWork, 'preexisting'), join(foreignTemp, 'preexisting')]
      const grants: AclWriteGrant[] = []
      const backups: { path: string; backup: string }[] = []
      const diagnostics: string[] = []
      try {
        for (const root of [ownWork, ownTemp, foreignWork, foreignTemp]) mkdirSync(root)
        for (const child of children) mkdirSync(child)
        // Explicit FullControl precedes the inherited ambient deny when a root is granted later.
        for (const child of children) {
          pwsh(`$ErrorActionPreference='Stop';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$acl=Get-Acl -LiteralPath ${quote(child)};
$acl.SetSecurityDescriptorSddlForm(('D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;'+$sid+')'),
 [System.Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath ${quote(child)} -AclObject $acl;
$after=Get-Acl -LiteralPath ${quote(child)};
if($after.AreAccessRulesProtected){throw 'Child must remain inheritance-enabled'};
$rules=@($after.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier])|
 Where-Object {$_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and
 ([int]$_.FileSystemRights -band 0x40) -ne 0});if($rules.Count -ne 1){throw 'Explicit caller parent-delete allow absent'}`)
        }
        for (const [root, sid] of [[ownWork, workspaceWriteSid(ownWork)], [ownTemp, tempWriteSid(ownTemp)],
          [foreignWork, workspaceWriteSid(foreignWork)], [foreignTemp, tempWriteSid(foreignTemp)]] as const) {
          const grant = AclWriteGrant.create(sid); grants.push(grant); grant.add(root)
        }
        const foreignVictims = children.map(child => join(child, `victim-${mode}.txt`))
        const ownVictims = [join(ownWork, `own-${mode}.txt`), join(ownTemp, `own-${mode}.txt`)]
        for (const victim of [...foreignVictims, ...ownVictims]) writeFileSync(victim, 'fixture victim')
        for (const [index, victim] of foreignVictims.entries()) {
          const child = children[index]; if (child === undefined) throw new Error('Fixture child missing')
          const backup = join(scratch, `victim-${mode}-${index}.acl.sddl`); backups.push({ path: victim, backup })
          // Snapshot before modifying only this fresh fixture's DACL; preserve it for finally recovery.
          diagnostics.push(pwsh(`$ErrorActionPreference='Stop';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$acl=Get-Acl -LiteralPath ${quote(victim)};
$before=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access);
Set-Content -LiteralPath ${quote(backup)} -NoNewline -Value $before;
$acl.SetSecurityDescriptorSddlForm(('D:P(A;;FR;;;'+$sid+')'),[System.Security.AccessControl.AccessControlSections]::Access);
Set-Acl -LiteralPath ${quote(victim)} -AclObject $acl;
& icacls.exe ${quote(victim)} /setintegritylevel L|Out-Null;if($LASTEXITCODE -ne 0){throw 'Low label fixture failed'};
$after=Get-Acl -LiteralPath ${quote(victim)};
$delete=@($after.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|
 Where-Object {$_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x10000) -ne 0});
if(!$after.AreAccessRulesProtected -or $delete.Count -ne 0){throw 'Victim must have no own DELETE allow'};
if((Get-Item -LiteralPath ${quote(victim)}).IsReadOnly){throw 'Readonly victim confounder'};
'CHILD-DACL: '+(Get-Acl -LiteralPath ${quote(child)}).Sddl;
'VICTIM-DACL: '+$after.Sddl`))
          expect(await hasLowNoWriteUpLabel(victim), `Low no-write-up label: ${victim}`).toBe(true)
        }
        const probe = [
          "const fs=require('node:fs');const paths=process.argv.slice(1);",
          "console.log('OWN-READ: '+fs.readFileSync(paths[2],'utf8'));",
          "for(const [i,path] of paths.entries()){try{fs.unlinkSync(path);console.log(i+': DELETED')}catch(e){",
          "console.log(i+': DENIED '+e.code)}}",
        ].join('')
        const result = spawnSync(process.execPath, ['--import', 'tsx/esm', runnerEntry,
          '--workspace', ownWork, '--temp', ownTemp, '--mode', mode,
          ...mode === 'workspace-write' ? ['--write-sid', workspaceWriteSid(ownWork), '--temp-write-sid', tempWriteSid(ownTemp)] : [],
          '--', process.execPath, '-e', probe, ...foreignVictims, ...ownVictims], { encoding: 'utf8', timeout: 30_000 })
        expect(result.status, `mode: ${mode}; stderr: ${result.stderr}`).toBe(0)
        expect(result.stdout, `mode: ${mode}`).toContain('OWN-READ: fixture victim')
        for (const [index, victim] of foreignVictims.entries()) {
          expect(result.stdout, `mode: ${mode}; ${victim}; ${diagnostics.join('\n')}`).toContain(`${index}: DENIED`)
          expect(existsSync(victim), `foreign victim persists, mode: ${mode}`).toBe(true)
          expect(readFileSync(victim, 'utf8')).toBe('fixture victim')
        }
        for (const [index, victim] of ownVictims.entries()) {
          expect(result.stdout, `own-session control, mode: ${mode}`).toContain(
            `${index + foreignVictims.length}: ${mode === 'workspace-write' ? 'DELETED' : 'DENIED'}`)
          expect(existsSync(victim), `own-session control, mode: ${mode}`).toBe(mode === 'read-only')
        }
      } finally {
        const failures: unknown[] = []
        for (const { path, backup } of backups) {
          if (existsSync(path) && existsSync(backup)) {
            try {
              pwsh(`$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath ${quote(path)};
$acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath ${quote(backup)} -Raw),
 [System.Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath ${quote(path)} -AclObject $acl`)
            } catch (error) { failures.push(error) }
          }
        }
        for (const grant of grants.reverse()) { try { grant.dispose() } catch (error) { failures.push(error) } }
        if (failures.length > 0) throw new AggregateError(failures, `Fixture recovery retained at ${scratch}`)
        rmSync(scratch, { recursive: true, force: true })
      }
    }, 90_000)
})
