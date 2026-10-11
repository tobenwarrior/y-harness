import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  env: Record<string, string>
  jobs: Record<'preview' | 'deploy', {
    'runs-on': string
    if?: string
    needs?: string
    permissions?: Record<string, string>
    steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }>
  }>
}
const preview = workflow.jobs.preview
const deployment = workflow.jobs.deploy

describe('PR preview workflow', () => {
  it('keeps every PR author on the selected GitHub-hosted runner', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview', 'deploy'])
    expect(preview['runs-on']).toBe('ubuntu-24.04')
    expect(deployment['runs-on']).toBe('ubuntu-24.04')
    expect(preview.if).toBeUndefined()
    expect(preview.permissions).toBeUndefined()
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v6')?.with).toEqual({ 'persist-credentials': false })
  })

  it('keeps the immutable full build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(JSON.stringify({ env: workflow.env, preview })).not.toMatch(
      /secrets\.|CLOUDFLARE_API_TOKEN|CF_ACCESS_CLIENT_SECRET|pages deploy|gh pr comment/,
    )
    const commands = preview.steps.map(step => step.run)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'))
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v4')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it('retains per-PR deployment, protected image verification, and idempotent URL comments', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    expect(workflow.env.CF_PROJECT).toBe('dsh-build-preview')
    expect(deployment.if).toBe("github.repository == 'deepseek-harness/deepseek-harness'")
    expect(deployment.needs).toBe('preview')
    expect(deployment.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    const shape = preview.steps.find(step => step.name === 'Shape the upload')!
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const retained = preview.steps.find(step => step.uses === 'actions/upload-artifact@v4')!
    expect(retained.with).toEqual({
      name: 'preview-pr-${{ github.event.pull_request.number }}',
      path: 'apps/web/dist',
      'if-no-files-found': 'error',
      'retention-days': 7,
    })
    const consumed = deployment.steps.find(step => step.uses === 'actions/download-artifact@v4')!
    expect(consumed.with).toEqual({ name: retained.with?.name, path: retained.with?.path })
    const deploy = deployment.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    expect(deploy.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(deploy.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    const verify = deployment.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = deployment.steps.find(step => step.name === 'Comment the preview URL')!
    expect(comment.env?.GH_REPO).toBe('${{ github.repository }}')
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
  })
})
