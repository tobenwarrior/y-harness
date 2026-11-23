import * as schedule from '@yharness/schedule'
import { describe, expect, it, vi } from 'vitest'
import { parseGrokImport } from '../src/grok-import.ts'
import { BOT_MEMORY_ENTRY_LIMIT } from '../src/memory.ts'

const encodeExport = (...bots: readonly object[]) => JSON.stringify({ format: 'grok-bot-export', version: 1, bots })

const routine = {
  name: 'Daily summary',
  instruction: 'Summarize the latest notes.',
  trigger: 'Schedule',
  schedule_cron: '15 7 * * *',
  timezone: 'UTC',
  skills: ['Draft a summary'],
}

describe('Grok Bot export admission', () => {
  it('selects one Bot by name and keeps the original memory and routine data', () => {
    const plan = parseGrokImport(encodeExport(
      { name: 'Other Bot', memories: ['Other Bot memory'] },
      {
        name: 'Research Bot',
        memories: [' Use source links ', 'Use source links'],
        user_facts: ['Use source links', 'Report at the end of the day'],
        skills: [{ name: 'Draft a summary', instructions: '# Draft a summary' }],
        routines: [routine],
      },
    ), ' research bot ')

    expect(plan).toEqual({
      name: 'Research Bot',
      memories: ['Use source links', 'Report at the end of the day'],
      skills: [{ name: 'Draft a summary', description: '', instructions: '# Draft a summary' }],
      routines: [{
        title: 'Daily summary',
        prompt: 'Summarize the latest notes.',
        cron: { expression: '15 7 * * *', time_zone: 'UTC' },
        skills: ['Draft a summary'],
      }],
    })
  })

  it('selects a sole Bot without a name and rejects ambiguous requests', () => {
    expect(parseGrokImport(encodeExport({ name: 'Solo Bot' }))).toEqual({
      name: 'Solo Bot', memories: [], skills: [], routines: [],
    })
    const twoBots = encodeExport({ name: 'Research Bot' }, { name: 'research bot' })
    expect(() => parseGrokImport(twoBots)).toThrow(/select exactly one/i)
    expect(() => parseGrokImport(twoBots, 'research bot')).toThrow(/select exactly one/i)
    expect(() => parseGrokImport(twoBots, 'missing bot')).toThrow(/select exactly one/i)
  })

  it('checks the byte limit, JSON syntax, and version before selecting a Bot', () => {
    expect(() => parseGrokImport('📝'.repeat(128 * 1024 + 1))).toThrow(/512 KiB/)
    expect(() => parseGrokImport('{"name":')).toThrow(/valid JSON/)
    expect(() => parseGrokImport('{"format":"grok-bot-export","version":0,"bots":[]}')).toThrow(/version-one/)
  })

  it('propagates an unexpected JSON parser failure', () => {
    const document = encodeExport({ name: 'Research Bot' })
    const failure = new Error('Parser unavailable')
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw failure })
    try {
      expect(() => parseGrokImport(document)).toThrow(failure)
    } finally {
      parse.mockRestore()
    }
  })

  it('reports an unexpected scheduler failure separately from invalid routines', () => {
    const document = encodeExport({ name: 'Research Bot', routines: [routine] })
    const failure = new Error('Scheduler unavailable')
    const create = vi.spyOn(schedule, 'createCronScheduleRecord').mockImplementationOnce(() => { throw failure })
    try {
      expect(() => parseGrokImport(document)).toThrow(failure)
    } finally {
      create.mockRestore()
    }
  })

  it('bounds the combined list of memories and user facts', () => {
    const memories = Array.from({ length: BOT_MEMORY_ENTRY_LIMIT }, (_item, index) => 'Memory ' + String(index))
    expect(() => parseGrokImport(encodeExport({ name: 'Research Bot', memories, user_facts: ['Extra fact'] })))
      .toThrow(/memory limit/i)
  })

  it('recovers complete supplemental memories and reports incomplete entries', () => {
    const document = JSON.stringify({
      format: 'grok-bot-memory-completion', version: 1, bot_name: 'Research Bot',
      reported_total: 6, retrieved_total: 4,
      memories: [
        { text: ' Use source links ', source: 'own_profile', truncated: false },
        { text: 'An unfinished sentence', source: 'own_profile', truncated: true },
      ],
      user_facts: [
        { text: 'Use source links', source: 'own_profile', truncated: false },
        { text: 'Report at the end of the day', source: 'shared_journal', truncated: false },
      ],
    })

    expect(parseGrokImport(document, ' research bot ')).toEqual({
      name: 'Research Bot',
      memories: ['Use source links', 'Report at the end of the day'],
      skills: [], routines: [],
      memoryGaps: { truncated: 1, unretrieved: 2 },
    })
    expect(() => parseGrokImport(document, 'Other Bot')).toThrow(/select exactly one/i)
  })

  it.each([
    { reported_total: 1, retrieved_total: 2 },
    { reported_total: 0, retrieved_total: 1 },
  ])('rejects a supplemental export whose counts do not match its records', (counts) => {
    const document = JSON.stringify({
      format: 'grok-bot-memory-completion', version: 1, bot_name: 'Research Bot',
      ...counts,
      memories: [{ text: 'Use source links', source: 'own_profile', truncated: false }],
      user_facts: [],
    })
    expect(() => parseGrokImport(document)).toThrow(/counts/i)
  })

  it('keeps the previous maximum combined memory text even with room for additional short entries', () => {
    const full = Array.from({ length: 100 }, (_item, index) => String(index).padEnd(2000, 'x'))
    expect(parseGrokImport(encodeExport({ name: 'Research Bot', memories: full })).memories).toHaveLength(100)
    expect(() => parseGrokImport(encodeExport({ name: 'Research Bot', memories: [...full, 'Extra fact'] })))
      .toThrow(/memory limit/i)
  })

  it('rejects credential fields and text even in an unselected Bot', () => {
    const selected = { name: 'Research Bot' }
    expect(() => parseGrokImport(encodeExport(selected, {
      name: 'Other Bot', privateSettings: { API_KEY: 'placeholder' },
    }), selected.name)).toThrow(/credential field/i)

    const exampleHeader = ['Bearer', 'x'.repeat(24)].join(' ')
    expect(() => parseGrokImport(encodeExport(selected, {
      name: 'Other Bot', memories: ['An authorization header follows. ' + exampleHeader],
    }), selected.name)).toThrow(/credential text/i)
  })

  it('rejects unsupported triggers, impossible schedules, and duplicate routine names', () => {
    const exportWith = (...routines: readonly object[]) => encodeExport({ name: 'Research Bot', routines })
    expect(() => parseGrokImport(exportWith({ ...routine, trigger: 'event' }))).toThrow(/timed Grok routines/)
    expect(() => parseGrokImport(exportWith({ ...routine, schedule_cron: '99 00 * * *' }))).toThrow(/invalid cron/)
    expect(() => parseGrokImport(exportWith({ ...routine, timezone: 'Oceans/Atlantis' }))).toThrow(/time zone/)
    expect(() => parseGrokImport(exportWith(routine, { ...routine, name: ' daily SUMMARY ' }))).toThrow(/same name/)
  })
})
