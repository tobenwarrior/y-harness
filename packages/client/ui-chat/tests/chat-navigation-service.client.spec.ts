import { describe, expect, it, vi } from 'vitest'
import { SessionSeq, type SessionId } from '@yharness/session/types'
import { ChatNavigationService } from '../src/client/chat/chat-navigation-service.ts'

const first = 'session-a' as SessionId
const second = 'session-b' as SessionId

describe('ChatNavigationService', () => {
  it('retains one exact target until the addressed Chat mounts', async () => {
    const service = new ChatNavigationService()
    service.request({ sessionId: first, seq: SessionSeq(12) })
    const navigate = vi.fn()
    const dispose = service.register(first, navigate)

    expect(navigate).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(navigate).toHaveBeenCalledWith(SessionSeq(12))

    dispose()
    service.dispose()
  })

  it('does not deliver a target to another Session or to a disposed Chat', async () => {
    const service = new ChatNavigationService()
    const firstNavigate = vi.fn()
    const secondNavigate = vi.fn()
    const firstDispose = service.register(first, firstNavigate)
    const secondDispose = service.register(second, secondNavigate)

    service.request({ sessionId: first, seq: SessionSeq(4) })
    expect(firstNavigate).toHaveBeenCalledWith(SessionSeq(4))
    expect(secondNavigate).not.toHaveBeenCalled()

    firstDispose()
    service.request({ sessionId: first, seq: SessionSeq(7) })
    secondDispose()
    await Promise.resolve()
    expect(firstNavigate).toHaveBeenCalledTimes(1)
    expect(secondNavigate).not.toHaveBeenCalled()
    service.dispose()
  })

  it('cancels a queued target explicitly', async () => {
    const service = new ChatNavigationService()
    const navigate = vi.fn()
    service.request({ sessionId: first, seq: SessionSeq(22) })
    service.cancel(first)
    service.register(first, navigate)
    await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    service.dispose()
  })

  it('coalesces newer targets before queued delivery', async () => {
    const service = new ChatNavigationService()
    const navigate = vi.fn()
    service.request({ sessionId: first, seq: SessionSeq(22) })
    service.register(first, navigate)
    service.request({ sessionId: first, seq: SessionSeq(23) })
    await Promise.resolve()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(SessionSeq(23))
    service.dispose()
  })

  it('cancels a queued delivery after the Chat mounts', async () => {
    const service = new ChatNavigationService()
    const navigate = vi.fn()
    service.request({ sessionId: first, seq: SessionSeq(24) })
    service.register(first, navigate)
    service.cancel(first)
    await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    service.dispose()
  })

  it('retains one target across a StrictMode-style effect remount', async () => {
    const service = new ChatNavigationService()
    const navigate = vi.fn()
    service.request({ sessionId: first, seq: SessionSeq(25) })
    const firstDispose = service.register(first, navigate)
    firstDispose()
    const secondDispose = service.register(first, navigate)
    await Promise.resolve()
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(SessionSeq(25))
    secondDispose()
    service.dispose()
  })
})
