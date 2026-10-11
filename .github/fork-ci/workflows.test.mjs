import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'

const upstream = 'deepseek-harness/deepseek-harness'
function workflow(name) {
  return load(readFileSync(new URL(`../workflows/${name}.yml`, import.meta.url), 'utf8'))
}
function runs(job, repository, eventName = 'pull_request', event = {}) {
  assert.equal(typeof job.if, 'string', 'Infrastructure job must declare repository eligibility')
  return runInNewContext(job.if, { github: { repository, event_name: eventName, event } })
}

test('upstream Project jobs refuse fork events before checkout or App token creation', () => {
  const policy = workflow('issue-policy')
  const lifecycle = workflow('issue-lifecycle')
  for (const [config, job] of [[policy, policy.jobs.policy], [lifecycle, lifecycle.jobs.lifecycle]]) {
    assert.equal(runs(job, 'tobenwarrior/y-harness', 'issues', {}), false)
    assert.equal(runs(job, upstream, 'issues', {}), true)
    assert.equal(job.steps[0].with.ref, '${{ github.event.repository.default_branch }}')
    assert.equal(job.steps[0].with['persist-credentials'], false)
    assert.equal(Object.hasOwn(config.on, 'pull_request_target'), false)
  }
  assert.equal(runs(lifecycle.jobs.lifecycle, upstream, 'pull_request_review', { review: { state: 'approved' } }), false)
  assert.equal(runs(lifecycle.jobs.lifecycle, upstream, 'pull_request_review', { review: { state: 'changes_requested' } }), true)
})

test('fork preview still builds and packs with read-only permissions and no deployment credentials', () => {
  const config = workflow('build-preview-cloudflare')
  const build = config.jobs.preview
  assert.equal(build.if, undefined)
  assert.deepEqual(config.permissions, { contents: 'read' })
  assert.equal(build.name, 'preview build')
  const commands = build.steps.map(step => step.run ?? '').join('\n')
  assert.match(commands, /pnpm run build/)
  assert.match(commands, /build:preview/)
  assert.match(commands, /find apps\/web\/dist -name '\*\.map' -delete/)
  assert.doesNotMatch(JSON.stringify(build), /secrets\.|CLOUDFLARE_API_TOKEN|CF_ACCESS_CLIENT_SECRET|pages deploy|gh pr comment/)
  const retained = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(retained.with.path, 'apps/web/dist')
  assert.equal(retained.with['if-no-files-found'], 'error')
  assert.equal(Object.hasOwn(config.on, 'pull_request_target'), false)
  assert.deepEqual(config.on.pull_request.types, ['opened', 'synchronize', 'reopened'])
  assert.equal(config.concurrency['cancel-in-progress'], true)
})

test('upstream deployment consumes this run artifact and retains protected image verification', () => {
  const config = workflow('build-preview-cloudflare')
  const deploy = config.jobs.deploy
  assert.equal(runs(deploy, 'tobenwarrior/y-harness'), false)
  assert.equal(runs(deploy, upstream), true)
  assert.equal(deploy.needs, 'preview')
  assert.deepEqual(deploy.permissions, { contents: 'read', 'pull-requests': 'write' })
  const retained = config.jobs.preview.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  const consumed = deploy.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(consumed.with.name, retained.with.name)
  assert.equal(consumed.with.path, retained.with.path)
  assert.equal(consumed.with['run-id'], undefined)
  const commands = deploy.steps.map(step => step.run ?? '').join('\n')
  assert.match(commands, /wrangler@4 pages deploy/)
  assert.match(commands, /if \[ "\$code" != "200" \]/)
  assert.match(commands, /content-encoding:/)
  assert.match(commands, /"1f8b"/)
  assert.match(commands, /gh pr comment/)
  const comment = deploy.steps.find(step => step.name === 'Comment the preview URL')
  assert.equal(comment.env.GH_REPO, '${{ github.repository }}')
})
