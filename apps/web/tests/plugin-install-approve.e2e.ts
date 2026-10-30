// A real Host/Remote/browser composition with a controllable package-manager process:
// pnpm leaves an install script undecided, the dialog offers approval, and the retry runs with it.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('offers approval for blocked install scripts and installs once they are allowed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-approve-'))
  const overlay = join(scratch, 'cordis.patch.yml')
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
    const browser = await chromium.launch()
    try {
      const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
      const policyPath = join(profile, 'pnpm-workspace.yaml')
      // Node stands in for pnpm: `view` answers the check, and `add` first leaves the script undecided in the
      // profile policy the way pnpm 11 does and fails; once the policy allows it, the same `add` installs the package.
      await writeFile(join(profile, 'view'), 'console.log(JSON.stringify({ name: "native-package", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }))\n')
      await writeFile(join(profile, 'add'), `
        import('node:fs').then(fs => {
        const policy = fs.readFileSync('pnpm-workspace.yaml', 'utf8');
        if (!/native-package: true/.test(policy)) {
          const pending = '  native-package: set this to true or false\\n';
          fs.writeFileSync('pnpm-workspace.yaml', /^allowBuilds:/m.test(policy)
            ? policy.replace(/^allowBuilds:\\n/m, 'allowBuilds:\\n' + pending)
            : policy + 'allowBuilds:\\n' + pending);
          console.error('ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: native-package');
          process.exitCode = 1;
          return;
        }
        fs.mkdirSync('node_modules/native-package', { recursive: true });
        fs.writeFileSync('node_modules/native-package/package.json', JSON.stringify({ name: 'native-package', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
        fs.writeFileSync('node_modules/native-package/cordis.patch.yml', '[]\\n');
        fs.writeFileSync('package.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('package.json', 'utf8')), dependencies: { 'native-package': '1.0.0' } }));
        console.log('Built native-package');
        });
      `)
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      if (await page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' }).count() > 0) await page.keyboard.press('Escape')
      await page.getByRole('navigation', { name: '\u{5168}\u{5C40}\u{9762}\u{677F}' }).getByRole('button', { name: '\u{63D2}\u{4EF6}', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{63D2}\u{4EF6}', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox').fill('native-package')
      await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}', exact: true }).click()
      // pnpm's refusal becomes the approval block, naming the package whose script waits; plain retry is not offered.
      const approval = dialog.getByRole('group', { name: '\u{9700}\u{8981}\u{5141}\u{8BB8}\u{5B89}\u{88C5}\u{811A}\u{672C}' })
      await approval.waitFor({ timeout: 20_000 })
      await expect.poll(() => approval.getByText('native-package', { exact: true }).count()).toBe(1)
      expect(await dialog.getByRole('button', { name: '\u{91CD}\u{8BD5}', exact: true }).count()).toBe(0)
      expect(await readFile(policyPath, 'utf8')).toContain('native-package: set this to true or false')
      const snapshot = (await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd))
        .split(process.execPath).join('{{node}}')
        .split(scaffold.harnessHome).join('{{harnessHome}}')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-install-approve/blocked.expected.md', import.meta.url)), snapshot, webSnapshotMode())
      await approval.getByRole('button', { name: '\u{5141}\u{8BB8}\u{8FD9}\u{4E9B}\u{811A}\u{672C}\u{5E76}\u{91CD}\u{8BD5}', exact: true }).click()
      // The Host saved the permission before running pnpm again, and the installed screen says so.
      await dialog.getByRole('button', { name: '\u{7ACB}\u{5373}\u{542F}\u{7528}', exact: true }).waitFor({ timeout: 20_000 })
      await dialog.getByText('\u{5DF2}\u{5141}\u{8BB8}\u{8FD0}\u{884C}\u{5B89}\u{88C5}\u{811A}\u{672C}：native-package', { exact: true }).waitFor()
      expect(await readFile(policyPath, 'utf8')).toMatch(/native-package: true/)
      expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { 'native-package': '1.0.0' } })
      expect(tripwire.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally {
    await scaffold?.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
