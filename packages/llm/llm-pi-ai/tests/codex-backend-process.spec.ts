import { once } from 'node:events'
import { expect, it } from 'vitest'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { boundedCodexInput, codexProcessArguments, codexRequestFailure } from '../src/codex-backend-process.ts'
it('preserves method-not-found support information without native diagnostic text or data', () => {
  const missing = codexRequestFailure('skills/list', new JsonRpcResponseError(-32601, 'sensitive diagnostic', { secret: 'hidden' }))
  expect(missing).toBeInstanceOf(JsonRpcResponseError)
  expect((missing as JsonRpcResponseError).code).toBe(-32601)
  expect((missing as JsonRpcResponseError).data).toBeUndefined()
  expect(missing.message).not.toContain('sensitive')
  const other = codexRequestFailure('skills/list', new JsonRpcResponseError(-32000, 'sensitive diagnostic', { secret: 'hidden' }))
  expect(other).not.toBeInstanceOf(JsonRpcResponseError)
  expect(other.message).not.toContain('sensitive')
})
it('closes before a native JSON line exceeds the buffer limit', async () => {
  const input = boundedCodexInput(4); input.on('error', () => {}); const error = once(input, 'error'); input.write(Buffer.from('12345')); expect(((await error)[0] as Error).message).toContain('size limit')
})
it('counts frame sizes across chunks and resets after each newline', () => {
  const input = boundedCodexInput(4); const errors: Error[] = []; input.on('error', e => errors.push(e)); input.resume(); input.write(Buffer.from('12')); input.write(Buffer.from('34\n1234\n')); expect(errors).toEqual([]); input.end()
})
it('leaves execution policy to the Harness turn, disables analytics and inherits no shell environment', () => {
  const args = codexProcessArguments({ binary: '/binary', nodePath: '/node', home: '/codex', shellHome: '/fresh', cwd: '/workspace' }); expect(args.join(' ')).not.toContain('sandbox_mode'); expect(args.join(' ')).not.toContain('approval_policy'); expect(args).toContain('shell_environment_policy.inherit="none"'); expect(args).toContain('analytics.enabled=false'); expect(args.join(' ')).not.toContain('web_search'); expect(args.join(' ')).not.toContain('danger-full-access')
})
