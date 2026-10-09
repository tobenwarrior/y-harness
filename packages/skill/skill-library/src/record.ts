/** Schema-validated local management state; skill files remain authoritative. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SkillLibraryId, SkillRevisionId } from './types.ts'

const id = z.string().transform(value => brandString<SkillLibraryId>(value))
const revisionId = z.string().transform(value => brandString<SkillRevisionId>(value))
const reference = z.object({ target: z.string(), kind: z.enum(['skill', 'file', 'url']), resolvedId: id.optional() })
const usage = z.object({
  coverage: z.enum(['unknown', 'recorded-loads']),
  loadCount: z.number().int().nonnegative(),
  lastLoadedAt: z.string().optional(),
})
const snapshot = z.object({
  id,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  source: z.string(),
  path: z.string(),
  scope: z.enum(['project', 'shared']),
  projectIds: z.array(z.string()),
  ownership: z.enum(['protected', 'y-managed', 'vendor']),
  status: z.enum(['active', 'disabled', 'archived']),
  shadowed: z.boolean(),
  pinned: z.boolean(),
  automaticCleanup: z.boolean(),
  invocation: z.object({ modelInvocable: z.boolean(), userInvocable: z.boolean() }),
  contentHash: z.string(),
  bodyBytes: z.number(),
  usage,
  references: z.array(reference),
  capabilities: z.object({
    adopt: z.boolean(),
    archive: z.boolean(),
    restore: z.boolean(),
    cleanup: z.boolean(),
    native: z.boolean(),
  }),
})
const revision = z.object({
  id: revisionId,
  createdAt: z.string(),
  reason: z.enum(['cleanup', 'rollback', 'learning']),
  beforeHash: z.string(),
  afterHash: z.string(),
  beforeBytes: z.number(),
  afterBytes: z.number(),
  backupPath: z.string(),
})
/** Persistent management data; manually changed managed files lose automatic eligibility. */
export const skillLibraryRecord = z.object({
  pinned: z.boolean().default(false),
  managedHash: z.string().optional(),
  automaticCleanup: z.boolean().default(false),
  retainedArchives: z.array(z.string()).default([]),
  usage: usage.default({ coverage: 'unknown', loadCount: 0 }),
  revisions: z.array(revision).default([]),
  archive: z.object({ originalPath: z.string(), archivePath: z.string(), instructionPath: z.string(), snapshot })
    .optional(),
})
/** One validated management record. */
export type SkillLibraryRecord = z.infer<typeof skillLibraryRecord>
/** Host-owned management flags and restore history; no bodies enter this table. */
export const skillLibraryDomain = defineDomain({
  name: 'skill_library',
  version: 1,
  tables: {
    items: domainTable<SkillLibraryId, SkillLibraryRecord>(skillLibraryRecord),
  },
})
