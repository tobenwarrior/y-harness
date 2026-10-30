// @vitest-environment jsdom
/**
 * Inline projection of sent user text: decoration adds no block containers,
 * preserves whitespace, and folds wire session forms to their label.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { projectUserText } from '../src/user-text.tsx'

const project = (
  text: string,
  labels: readonly string[] = [],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
) =>
  render(<div data-host>{projectUserText(text, labels, slashNames, slashKind)}</div>).container.querySelector('[data-host]')!

describe('projectUserText', () => {
  it('keeps decorated text inline and preserves whitespace between references', () => {
    const host = project('Again and again /dsh-acp-test @run commands', ['run commands'], ['dsh-acp-test'])
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.textContent).toBe('Again and again /dsh-acp-test run commands')
    const chips = host.querySelectorAll('[data-ref-chip]')
    expect([...chips].map(c => c.getAttribute('data-ref-chip'))).toEqual(['skill', 'session'])
    // The whitespace between tokens survives as its own inline run.
    const runs = [...host.querySelectorAll('span')].filter(s => !s.hasAttribute('data-ref-chip') && s.closest('[data-ref-chip]') === null)
    expect(runs.map(r => r.textContent)).toEqual(['Again and again ', ' '])
  })

  it('folds the wire session form to its label with the session glyph', () => {
    const host = project('Look at @[view and analyze image](dsh-session:InNlc3Npb24tNDM0) conclusion')
    const chip = host.querySelector('[data-ref-chip="session"]')!
    expect(chip.textContent).toBe('view and analyze image')
    expect(chip.getAttribute('title')).toBe('@[view and analyze image](dsh-session:InNlc3Npb24tNDM0)')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(host.textContent).toBe('Look at view and analyze image conclusion')
  })

  it('prefers the wire fold over the bare-token scan on the same range', () => {
    const host = project('@[a](dsh-session:x)', [])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(1)
    expect(host.querySelector('[data-ref-chip="session"]')!.textContent).toBe('a')
  })

  it('decorates recall-associated labels, files, folders, and quoted paths', () => {
    const host = project('@session-one say @src/deep/file.txt and @dir/ and @"a b.md"', ['session-one'])
    const kinds = [...host.querySelectorAll('[data-ref-chip]')].map(c =>
      [c.getAttribute('data-ref-chip'), c.textContent])
    expect(kinds).toEqual([
      ['session', 'session-one'],
      ['file', 'file.txt'],
      ['folder', 'dir'],
      ['file', 'a b.md'],
    ])
  })

  it('repeated recall labels decorate every occurrence once', () => {
    const host = project('@again context @again', ['again', 'again'])
    expect(host.querySelectorAll('[data-ref-chip="session"]').length).toBe(2)
  })

  it('keeps a punctuation-glued slash token plain and skips degenerate tokens', () => {
    // The host skill gesture ends at whitespace or the text end, so `/plan.`
    // never loads a skill; the bubble must not suggest otherwise.
    const host = project('Try /plan. then @.', [], ['plan'])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('Try /plan. then @.')
  })

  it('decorates a slash token only when the host resolved it as a skill in that step', () => {
    const bare = project('/123')
    expect(bare.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(bare.textContent).toBe('/123')
    const unresolved = project('Try /plan now')
    expect(unresolved.querySelectorAll('[data-ref-chip]').length).toBe(0)
    const resolved = project('Try /plan now', [], ['plan'])
    expect([...resolved.querySelectorAll('[data-ref-chip]')].map(c => [c.getAttribute('data-ref-chip'), c.textContent]))
      .toEqual([['skill', '/plan']])
  })

  it('marks a resolved slash token as a command chip when the caller says so', () => {
    const host = project('/goal ship it\nsecond line', [], ['goal'], 'command')
    const chips = [...host.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(c => [c.getAttribute('data-ref-chip'), c.textContent])).toEqual([['command', '/goal']])
    expect(host.textContent).toBe('/goal ship it\nsecond line')
  })

  it('leaves slash paths undecorated even for a resolved name: a /name token ends at whitespace', () => {
    const text = 'Test the UI, ignore me:\n/nfs-hg/xxx/yyy and /root-dir/ plus /plan.md'
    const host = project(text, [], ['nfs-hg', 'root-dir', 'plan'])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe(text)
  })

  it('prefers the longer recall label when one nests inside another', () => {
    const host = project('@session-one wrap up', ['session', 'session-one'])
    const chips = [...host.querySelectorAll('[data-ref-chip="session"]')]
    expect(chips.map(c => c.textContent)).toEqual(['session-one'])
    expect(host.textContent).toBe('session-one wrap up')
  })

  it('falls back to the raw quoted label when the path has no basename', () => {
    const host = project('Look at @"/" below')
    const chip = host.querySelector('[data-ref-chip="folder"]')!
    expect(chip.textContent).toBe('"/"')
  })

  it('opens decoded files and loaded skills without activating session, folder, or command references', () => {
    const openFile = vi.fn()
    const openSkill = vi.fn()
    const view = render(<div>{projectUserText(
      '@src/a.ts @"notes a.md" /review @history @dir/ @"dir a/"', ['history'], ['review'], 'skill',
      { openFile, openSkill },
    )}</div>)
    fireEvent.click(view.getByRole('button', { name: 'a.ts' }))
    fireEvent.click(view.getByRole('button', { name: 'notes a.md' }))
    fireEvent.click(view.getByRole('button', { name: '/review' }))
    expect(openFile.mock.calls).toEqual([['src/a.ts'], ['notes a.md']])
    expect(openSkill).toHaveBeenCalledWith('review')
    expect(view.container.querySelectorAll('button')).toHaveLength(3)
    const command = render(<div>{projectUserText('/help', [], ['help'], 'command', { openFile, openSkill })}</div>)
    expect(command.container.querySelector('button')).toBeNull()
  })

  it('preserves text-selection gestures and keyboard activation', () => {
    const openFile = vi.fn()
    const view = render(<div>{projectUserText('@notes.md', [], [], 'skill', { openFile, openSkill: vi.fn() })}</div>)
    const button = view.getByRole('button', { name: 'notes.md' })
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(button)
    selection.addRange(range)
    fireEvent.click(button, { detail: 1 })
    expect(openFile).not.toHaveBeenCalled()
    fireEvent.click(button, { detail: 0 })
    expect(openFile).toHaveBeenCalledWith('notes.md')
    selection.removeAllRanges()
    openFile.mockClear()
    fireEvent.click(button, { detail: 2 })
    expect(openFile).not.toHaveBeenCalled()
  })

  it('renders undecorated text as one inline run', () => {
    const host = project('Plain text, no references')
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('Plain text, no references')
  })
})
