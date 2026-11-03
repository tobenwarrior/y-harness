import { SessionId } from '@yharness/session'
import { describe, expect, it } from 'vitest'
import {
  BotPrincipalId,
  authorizeBotShare,
  botPrivateConversationKey,
  type BotShareMembership,
  type SharedBotRoster,
} from '../src/sharing.ts'
import { BotId } from '../src/types.ts'

const botId = BotId('bot-shared')
const owner = BotPrincipalId('person-owner')
const manager = BotPrincipalId('person-manager')
const collaborator = BotPrincipalId('person-collaborator')
const stranger = BotPrincipalId('person-stranger')

function membership(
  principalId: BotShareMembership['principalId'],
  role: BotShareMembership['role'],
): BotShareMembership {
  return {
    botId,
    principalId,
    role,
    grantedBy: owner,
    createdAt: 1,
    updatedAt: 1,
  }
}

function roster(): SharedBotRoster {
  return {
    botId,
    memberships: [
      { ...membership(owner, 'owner'), grantedBy: owner },
      membership(manager, 'manager'),
      membership(collaborator, 'collaborator'),
    ],
  }
}

describe('shared Bot authorization', () => {
  it('lets each member chat while limiting profile and membership management by role', () => {
    const shared = roster()
    expect(authorizeBotShare(shared, { actor: owner, operation: 'chat' })).toEqual({ allowed: true })
    expect(authorizeBotShare(shared, { actor: manager, operation: 'chat' })).toEqual({ allowed: true })
    expect(authorizeBotShare(shared, { actor: collaborator, operation: 'chat' })).toEqual({ allowed: true })

    expect(authorizeBotShare(shared, { actor: owner, operation: 'manage-profile' })).toEqual({ allowed: true })
    expect(authorizeBotShare(shared, { actor: manager, operation: 'manage-profile' })).toEqual({ allowed: true })
    expect(authorizeBotShare(shared, { actor: collaborator, operation: 'manage-profile' })).toMatchObject({
      allowed: false,
      reason: 'role-forbidden',
    })
    expect(authorizeBotShare(shared, { actor: manager, operation: 'manage-members' })).toMatchObject({
      allowed: false,
      reason: 'role-forbidden',
    })
    expect(authorizeBotShare(shared, { actor: owner, operation: 'manage-members' })).toEqual({ allowed: true })
  })

  it('rejects non-members before granting any shared Bot operation', () => {
    expect(authorizeBotShare(roster(), { actor: stranger, operation: 'chat' })).toEqual({
      allowed: false,
      reason: 'not-member',
    })
  })

  it('fails closed when a roster has duplicate principals or no owner', () => {
    const duplicatePrincipal: SharedBotRoster = {
      botId,
      memberships: [membership(owner, 'owner'), membership(owner, 'manager')],
    }
    expect(authorizeBotShare(duplicatePrincipal, { actor: owner, operation: 'chat' })).toEqual({
      allowed: false,
      reason: 'invalid-roster',
    })

    const noOwner: SharedBotRoster = {
      botId,
      memberships: [membership(collaborator, 'collaborator')],
    }
    expect(authorizeBotShare(noOwner, { actor: collaborator, operation: 'chat' })).toEqual({
      allowed: false,
      reason: 'invalid-roster',
    })

    const unrecognizedGrantor: SharedBotRoster = {
      botId,
      memberships: [
        membership(owner, 'owner'),
        { ...membership(collaborator, 'collaborator'), grantedBy: stranger },
      ],
    }
    expect(authorizeBotShare(unrecognizedGrantor, { actor: collaborator, operation: 'chat' })).toEqual({
      allowed: false,
      reason: 'invalid-roster',
    })
  })

  it('allows a person to read only their own private Bot conversation', () => {
    const shared = roster()
    expect(authorizeBotShare(shared, { actor: collaborator, operation: 'read-private-chat' })).toEqual({
      allowed: false,
      reason: 'subject-required',
    })
    expect(authorizeBotShare(shared, {
      actor: collaborator,
      operation: 'read-private-chat',
      subject: collaborator,
    })).toEqual({ allowed: true })
    expect(authorizeBotShare(shared, {
      actor: owner,
      operation: 'read-private-chat',
      subject: collaborator,
    })).toEqual({ allowed: false, reason: 'private-chat-owner-only' })
    expect(authorizeBotShare(shared, {
      actor: collaborator,
      operation: 'read-private-chat',
      subject: owner,
    })).toEqual({ allowed: false, reason: 'private-chat-owner-only' })
  })

  it('derives distinct stable routing keys for each private conversation', () => {
    const first = botPrivateConversationKey({ botId, principalId: owner, sessionId: SessionId('session-owner') })
    const second = botPrivateConversationKey({ botId, principalId: collaborator, sessionId: SessionId('session-collaborator') })
    expect(first).toBe(botPrivateConversationKey({ botId, principalId: owner, sessionId: SessionId('session-owner') }))
    expect(first).not.toBe(second)
    expect(first).not.toContain('session-owner')
  })
})
