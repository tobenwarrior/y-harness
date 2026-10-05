import { once } from 'node:events'
import { expect, it } from 'vitest'
import { boundedCodexInput, codexProcessArguments } from '../src/codex-backend-process.ts'
it('closes before a native JSON line exceeds the buffer limit', async () => {
 const input = boundedCodexInput(4); input.on('error', () => {}); const error = once(input, 'error'); input.write(Buffer.from('12345')); expect((await error)[0].message).toContain('size limit')
})
it('counts frame sizes across chunks and resets after each newline', () => {
 const input = boundedCodexInput(4); const errors: Error[] = []; input.on('error', e => errors.push(e)); input.resume(); input.write(Buffer.from('12')); input.write(Buffer.from('34\n1234\n')); expect(errors).toEqual([]); input.end()
})
it('sets restrictive native policy, disables analytics and inherits no shell environment', () => {
 const args = codexProcessArguments({ binary: '/binary', nodePath: '/node', home: '/codex', shellHome: '/fresh', cwd: '/workspace' }); expect(args).toContain('sandbox_mode="read-only"'); expect(args).toContain('approval_policy="on-request"'); expect(args).toContain('shell_environment_policy.inherit="none"'); expect(args).toContain('analytics.enabled=false'); expect(args).toContain('web_search="disabled"'); expect(args.join(' ')).not.toContain('danger-full-access')
})
