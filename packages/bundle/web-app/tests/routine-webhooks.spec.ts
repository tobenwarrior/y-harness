import { Context } from '@yharness/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config } from '../src/routine-webhooks.ts'

it('mounts the configured route and disposes both owners together', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const route = { kind: 'prefix', path: '/bot-hooks', handler: vi.fn() } as const
  const unmount = vi.fn()
  const dispose = vi.fn()
  const register = vi.fn(() => unmount)
  const receive = vi.fn(() => ({ route, dispose }))
  ctx.provide('webServer', { register } as never)
  ctx.provide('bots', { registerRoutineWebhookReceiver: receive } as never)
  const config = new Config({ publicUrl: 'https://hooks.example/prefix', maxBodyBytes: 4096 })

  apply(ctx, config)

  expect(register).toHaveBeenCalledWith(route)
  expect(receive).toHaveBeenCalledWith('https://hooks.example/prefix/', 4096)
  await ctx.fiber.dispose()
  expect(unmount).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})

it('requires HTTPS for routine webhooks', () => {
  expect(() => new Config({ publicUrl: 'http://hooks.example', maxBodyBytes: 4096 })).toThrow('requires HTTPS')
})
