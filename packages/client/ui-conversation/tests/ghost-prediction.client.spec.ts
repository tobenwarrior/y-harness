/**
 * GhostPredictionController: fetch generation guard, shown/accepted dedupe,
 * and the visibility predicate. Pure logic — no Lexical, no DOM.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GhostPredictionController,
  type FollowUpPredictionProvider,
  type GhostDraftFace,
} from '../src/client/input/editor/ghost-prediction.ts'

function draftFace(empty = true): GhostDraftFace & { replaced: string[] } {
  const replaced: string[] = []
  return {
    replaced,
    isEmpty: () => empty,
    replaceWith: (text: string) => { replaced.push(text) },
  }
}

function providerFor(
  results: readonly ({ id: string; text: string } | null)[],
  opts: { hangFirst?: boolean } = {},
): FollowUpPredictionProvider & { calls: number } {
  let calls = 0
  return {
    get calls(): number {
      return calls
    },
    async fetchPrediction({ signal }): Promise<{ id: string; text: string } | null> {
      calls += 1
      if (opts.hangFirst === true && calls === 1) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (signal.aborted) return null
      return results[Math.min(calls - 1, results.length - 1)] ?? null
    },
  }
}

describe('GhostPredictionController', () => {
  it('shows a suggestion only when the draft is empty and not composing', async () => {
    const draft = draftFace(true)
    const controller = new GhostPredictionController(
      providerFor([{ id: 't1', text: 'Summarize this' }]),
      draft,
    )
    expect(controller.mayShow(false)).toBe(false)
    await controller.fetchAfterTurn('c1', 'turn-1', 'Here is the summary.')
    expect(controller.mayShow(false)).toBe(true)
    expect(controller.mayShow(true)).toBe(false)
  })

  it('treats empty provider text as abstain (nothing renders)', async () => {
    const controller = new GhostPredictionController(
      providerFor([{ id: 't1', text: '' }]),
      draftFace(true),
    )
    await controller.fetchAfterTurn('c1', 'turn-1', 'Done.')
    expect(controller.current).toBe(null)
    expect(controller.mayShow(false)).toBe(false)
  })

  it('supersedes in-flight fetches by generation (stale results dropped)', async () => {
    const provider = providerFor(
      [{ id: 'old', text: 'Old suggestion' }, { id: 'new', text: 'New suggestion' }],
      { hangFirst: true },
    )
    const controller = new GhostPredictionController(provider, draftFace(true))
    const first = controller.fetchAfterTurn('c1', 'turn-1', 'First.')
    const second = controller.fetchAfterTurn('c1', 'turn-2', 'Second.')
    await Promise.allSettled([first, second])
    // The hanging first fetch is aborted; only the second may resolve.
    expect(provider.calls).toBe(2)
  })

  it('accepts once: replaces the draft, records accepted once, clears', async () => {
    const draft = draftFace(true)
    const shown: string[] = []
    const accepted: string[] = []
    const controller = new GhostPredictionController(
      providerFor([{ id: 't1', text: 'Explain this' }]),
      draft,
      {
        shown: (p) => { shown.push(p.id) },
        accepted: (p) => { accepted.push(p.id) },
      },
    )
    await controller.fetchAfterTurn('c1', 'turn-1', 'Result.')
    controller.markShown()
    controller.markShown()
    expect(shown).toEqual(['t1'])
    expect(controller.accept()).toBe('Explain this')
    expect(draft.replaced).toEqual(['Explain this'])
    expect(accepted).toEqual(['t1'])
    expect(controller.current).toBe(null)
    expect(controller.accept()).toBe(null)
  })

  it('keeps the prediction across typing (visibility is derived)', async () => {
    let empty = true
    const controller = new GhostPredictionController(
      providerFor([{ id: 't1', text: 'Go on' }]),
      { isEmpty: () => empty, replaceWith: () => {} },
    )
    await controller.fetchAfterTurn('c1', 'turn-1', 'Result.')
    expect(controller.mayShow(false)).toBe(true)
    empty = false
    expect(controller.mayShow(false)).toBe(false)
    empty = true
    expect(controller.mayShow(false)).toBe(true)
  })

  it('clear() aborts the fetch and drops the suggestion', async () => {
    const controller = new GhostPredictionController(
      providerFor([{ id: 't1', text: 'Late' }]),
      draftFace(true),
    )
    const pending = controller.fetchAfterTurn('c1', 'turn-1', 'Working.')
    controller.clear()
    await pending
    expect(controller.current).toBe(null)
  })

  it('provider failures never surface (composer keeps working)', async () => {
    const failing: FollowUpPredictionProvider = {
      async fetchPrediction() {
        throw new Error('model down')
      },
    }
    const onError = vi.fn()
    const controller = new GhostPredictionController(failing, draftFace(true), {
      shown: onError,
      accepted: onError,
    })
    await expect(controller.fetchAfterTurn('c1', 'turn-1', 'Hi.')).resolves.toBe(null)
    expect(controller.current).toBe(null)
    expect(onError).not.toHaveBeenCalled()
  })

  it('telemetry failures never break accept', async () => {
    const draft = draftFace(true)
    const controller = new GhostPredictionController(
      providerFor([{ id: 't1', text: 'Do it' }]),
      draft,
      {
        shown: () => { throw new Error('telemetry down') },
        accepted: () => { throw new Error('telemetry down') },
      },
    )
    await controller.fetchAfterTurn('c1', 'turn-1', 'Result.')
    controller.markShown()
    expect(controller.accept()).toBe('Do it')
    expect(draft.replaced).toEqual(['Do it'])
  })
})
