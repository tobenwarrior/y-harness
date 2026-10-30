import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@yharness/loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/y-harness-badge/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/y-harness-badge/cordis.yml', import.meta.url))
const defaultConfigPath = fileURLToPath(new URL('./fixtures/y-harness-badge/default.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const badgeAssetsPath = fileURLToPath(new URL('../../../packages/skill/skill-badge/assets/', import.meta.url))

describe('Y Harness badge assembled snapshot', () => {
  it('advertises and loads the opt-in bundled skill through the shipped app', async () => {
    const disabled = await runLoaderSmoke({
      label: 'disabled Y Harness badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-y-harness-badge-disabled-',
      binScript,
      libBinScript: binScript,
      configPath: defaultConfigPath,
      tsconfigPath,
    })
    const enabled = await runLoaderSmoke({
      label: 'Y Harness badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-y-harness-badge-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
    })
    const legacy = await runLoaderSmoke({
      label: 'legacy Y Harness badge skill alias snapshot',
      tempDirPrefix: 'headless-snapshot-y-harness-badge-legacy-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'dsh-badge'],
      tsconfigPath,
    })
    const disabledSnapshot: unknown = JSON.parse(disabled.stdout)
    const enabledSnapshot: unknown = JSON.parse(
      enabled.stdout.replaceAll(badgeAssetsPath, '{{badgeAssetsPath}}'),
    )
    const legacySnapshot: { directLoad?: unknown } = JSON.parse(
      legacy.stdout.replaceAll(badgeAssetsPath, '{{badgeAssetsPath}}'),
    )

    expect(disabled.stderr).toBe('')
    expect(enabled.stderr).toBe('')
    expect(legacy.stderr).toBe('')
    expect(legacySnapshot).toMatchObject({
      summary: {
        name: 'dsh-badge',
        description: 'Legacy alias for the Y Harness badge skill. Use y-harness-badge for new references.',
        invocation: { modelInvocable: false, userInvocable: true },
        provider: 'y-harness-badge',
      },
      directLoad: {
        name: 'dsh-badge',
        provider: 'y-harness-badge',
        invocation: { modelInvocable: false, userInvocable: true },
      },
    })
    expect(JSON.stringify(legacySnapshot.directLoad)).toContain('# Y Harness Badge')
    expect(disabledSnapshot).toMatchInlineSnapshot(`
      {
        "catalog": [
          {
            "text": "<system-reminder>
      This task-relevant skill shortlist contains metadata only. It replaces earlier suggestions; additional skills may exist.
      <available_skills>
      </available_skills>
      No task-relevant summary matched this query. This does not mean that no skills exist.
      Where the Harness \`skill\` tool is available, load full instructions for an applicable skill before acting. An exact user-requested name may be loaded even when omitted from this shortlist.
      Where the Harness \`search_skills\` tool is available, use a focused metadata query to discover omitted matches.
      A user-explicit <skill_content> block is already loaded; follow it without loading the same skill again. Native runtimes own their tools and skill catalogs.
      </system-reminder>",
            "type": "text",
          },
        ],
        "result": {
          "content": [
            {
              "text": "Error: skill "y-harness-badge" is unknown or no longer available",
              "type": "text",
            },
          ],
          "error": {
            "message": "skill "y-harness-badge" is unknown or no longer available",
          },
          "isError": true,
        },
        "summary": null,
      }
    `)
    expect(enabledSnapshot).toMatchInlineSnapshot(`
      {
        "catalog": [
          {
            "text": "<system-reminder>
      This task-relevant skill shortlist contains metadata only. It replaces earlier suggestions; additional skills may exist.
      <available_skills>
      </available_skills>
      No task-relevant summary matched this query. This does not mean that no skills exist.
      Where the Harness \`skill\` tool is available, load full instructions for an applicable skill before acting. An exact user-requested name may be loaded even when omitted from this shortlist.
      Where the Harness \`search_skills\` tool is available, use a focused metadata query to discover omitted matches.
      A user-explicit <skill_content> block is already loaded; follow it without loading the same skill again. Native runtimes own their tools and skill catalogs.
      </system-reminder>",
            "type": "text",
          },
        ],
        "result": {
          "content": [
            {
              "text": "<skill_content name="y-harness-badge">
      <skill_resources>
      Base directory for this skill: {{badgeAssetsPath}}
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # Y Harness Badge

      Add the official Y Harness badge without recreating or restyling it.

      ## Assets

      - Local SVG: [\`y-harness-badge.svg\`](y-harness-badge.svg), 726×120 source image; render at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-Y_Harness-4D6BFE?style=flat-square\`
      - Project URL: \`https://github.com/tobenwarrior/y-harness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-Y_Harness-4D6BFE?style=flat-square)](https://github.com/tobenwarrior/y-harness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-Y_Harness-4D6BFE?style=flat-square)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For systems that import remote images unreliably, upload \`y-harness-badge.svg\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.

      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# Y Harness Badge

      Add the official Y Harness badge without recreating or restyling it.

      ## Assets

      - Local SVG: [\`y-harness-badge.svg\`](y-harness-badge.svg), 726×120 source image; render at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-Y_Harness-4D6BFE?style=flat-square\`
      - Project URL: \`https://github.com/tobenwarrior/y-harness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-Y_Harness-4D6BFE?style=flat-square)](https://github.com/tobenwarrior/y-harness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-Y_Harness-4D6BFE?style=flat-square)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For systems that import remote images unreliably, upload \`y-harness-badge.svg\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.
      ",
            "name": "y-harness-badge",
            "provider": "y-harness-badge",
            "resourceBase": {
              "kind": "directory",
              "path": "{{badgeAssetsPath}}",
            },
          },
        },
        "summary": {
          "description": "Add the official Y Harness badge to documents, pull requests, merge requests, and other content produced with Y Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Y Harness badge, Y Harness attribution, or a reusable Y Harness badge asset or snippet.",
          "invocation": {
            "modelInvocable": true,
            "userInvocable": true,
          },
          "name": "y-harness-badge",
          "provider": "y-harness-badge",
          "resourceBase": {
            "kind": "directory",
            "path": "{{badgeAssetsPath}}",
          },
          "source": "bundled",
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})
