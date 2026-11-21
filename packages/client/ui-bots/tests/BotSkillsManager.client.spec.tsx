// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotSkillsManager } from '../src/client/BotSkillsManager.tsx'
import { en } from '../src/client/locales.ts'
import { BotSkillPolicyConflictError } from '../src/client/types.ts'
import type { BotSkillManagerActions, BotSkillManagerValue, BotSkillPolicy, BotSkillSummary, BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-skills',
  name: 'Skills bot',
  identity: 'agent',
  accent: 'violet',
}

function renderManager(actions: BotSkillManagerActions, onClose = vi.fn()) {
  return render(<BotSkillsManager bot={bot} actions={actions} open onClose={onClose} t={t} />)
}

function skill(name: string, whenToUse?: string): BotSkillSummary {
  return {
    name,
    description: `${name} description`,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    enabled: true,
    available: true,
  }
}

describe('BotSkillsManager', () => {
  it('renders a fallback label for an empty catalog name from a typed Remote result', async () => {
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [skill('')],
      })),
      update: vi.fn(),
    }

    renderManager(actions)

    expect(await screen.findByText('Unnamed skill')).toBeTruthy()
  })

  it('toggles denied skills in all mode and displays optional guidance', async () => {
    const policy: BotSkillPolicy = { mode: 'all', enabled: [], disabled: ['alpha-skill'] }
    const update = vi.fn(async (_botId: string, next: BotSkillPolicy) => ({ policy: next }))
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy,
        revision: 4,
        skills: [skill('zeta-skill', ''), skill('alpha-skill', 'Use this for alpha tasks.'), skill('middle-skill')],
      })),
      update,
    }

    renderManager(actions)

    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    expect(await within(dialog).findByText('Use this for alpha tasks.')).toBeTruthy()
    expect(within(dialog).getByText('zeta-skill description')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Only selected skills' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'All available skills' }))
    const alpha = await within(dialog).findByRole('checkbox', { name: 'Allow alpha-skill' }) as HTMLInputElement
    const zeta = within(dialog).getByRole('checkbox', { name: 'Do not allow zeta-skill' }) as HTMLInputElement
    expect(alpha.checked).toBe(false)
    expect(zeta.checked).toBe(true)
    fireEvent.click(alpha)
    fireEvent.click(zeta)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(bot.id, {
        mode: 'all', enabled: [], disabled: ['zeta-skill'],
      }, 4)
    })
  })

  it('moves selected skills between enabled and denied lists', async () => {
    const policy: BotSkillPolicy = { mode: 'selected', enabled: ['zeta-skill'], disabled: ['middle-skill'] }
    const update = vi.fn(async (_botId: string, next: BotSkillPolicy) => ({ policy: next }))
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy,
        revision: 7,
        skills: [skill('alpha-skill'), skill('middle-skill'), skill('zeta-skill')],
      })),
      update,
    }

    renderManager(actions)

    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    const zeta = await within(dialog).findByRole('checkbox', { name: 'Do not allow zeta-skill' }) as HTMLInputElement
    const middle = within(dialog).getByRole('checkbox', { name: 'Allow middle-skill' }) as HTMLInputElement
    const alpha = within(dialog).getByRole('checkbox', { name: 'Allow alpha-skill' }) as HTMLInputElement
    expect(zeta.checked).toBe(true)
    expect(middle.checked).toBe(false)
    fireEvent.click(zeta)
    fireEvent.click(middle)
    fireEvent.click(alpha)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Allow zeta-skill' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(bot.id, {
        mode: 'selected', enabled: ['alpha-skill', 'middle-skill', 'zeta-skill'], disabled: [],
      }, 7)
    })
  })

  it('retries a failed skill catalog load', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce({ policy: { mode: 'all' as const, enabled: [], disabled: [] }, revision: 0, skills: [] })
    const actions: BotSkillManagerActions = {
      list,
      update: vi.fn(),
    }

    renderManager(actions)

    expect((await screen.findByRole('alert')).textContent).toContain('The local skills could not be loaded')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No local skills available')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps the policy editor open for a non-conflict save failure', async () => {
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [skill('alpha-skill')],
      })),
      update: vi.fn(async () => { throw new Error('catalog unavailable') }),
    }

    renderManager(actions)

    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The skill policy could not be saved')
    expect(screen.getByRole('dialog', { name: 'Bot skills' })).toBeTruthy()
  })

  it('keeps the dialog close action available when no save is working', async () => {
    const onClose = vi.fn()
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [],
      })),
      update: vi.fn(),
    }

    renderManager(actions, onClose)

    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('reports a policy conflict and leaves the selected controls disabled', async () => {
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'selected' as const, enabled: [], disabled: [] },
        revision: 2,
        skills: [skill('alpha-skill')],
      })),
      update: vi.fn(async () => { throw new BotSkillPolicyConflictError('changed elsewhere') }),
    }

    renderManager(actions)

    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere')
    expect(within(dialog).getByRole('button', { name: 'Save skills' })).toHaveProperty('disabled', true)
  })

  it('ignores a load failure that settles after the manager unmounts', async () => {
    const pending = Promise.withResolvers<BotSkillManagerValue>()
    const actions: BotSkillManagerActions = {
      list: vi.fn(() => pending.promise),
      update: vi.fn(),
    }

    const view = renderManager(actions)
    await waitFor(() => { expect(actions.list).toHaveBeenCalledOnce() })
    view.unmount()
    pending.reject(new Error('stale catalog failure'))
    await pending.promise.catch(() => undefined)
  })

  it('ignores a rejected save after the selected Bot changes', async () => {
    const pending = Promise.withResolvers<Pick<BotSkillManagerValue, 'policy'>>()
    const onClose = vi.fn()
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [],
      })),
      update: vi.fn(() => pending.promise),
    }
    const nextBot: BotSummary = { ...bot, id: 'bot-next' }

    const view = renderManager(actions, onClose)
    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    await waitFor(() => { expect(actions.update).toHaveBeenCalledWith(bot.id, { mode: 'all', enabled: [], disabled: [] }, 0) })
    view.rerender(<BotSkillsManager bot={nextBot} actions={actions} open onClose={onClose} t={t} />)
    await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    pending.reject(new Error('stale save failure'))
    await pending.promise.catch(() => undefined)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not close while a save is pending, then permits closing', async () => {
    const pending = Promise.withResolvers<Pick<BotSkillManagerValue, 'policy'>>()
    const onClose = vi.fn()
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [],
      })),
      update: vi.fn(() => pending.promise),
    }

    renderManager(actions, onClose)
    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    await waitFor(() => { expect(actions.update).toHaveBeenCalledOnce() })
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!)
    expect(onClose).not.toHaveBeenCalled()
    pending.resolve({ policy: { mode: 'all', enabled: [], disabled: [] } })
    await pending.promise
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
