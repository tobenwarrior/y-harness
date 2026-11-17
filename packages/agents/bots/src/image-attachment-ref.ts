/** Durable image metadata shared by roster avatars and Bot message attachments. */

import type { AttachmentId, ImageAttachmentRef } from '@yharness/attachment'
import { z } from 'zod'

/**
 * Validate shared image metadata with the attachment identifier policy of the storing record.
 * @param attachmentId - Provider identifier admitted by this record.
 * @returns The durable image reference schema, with absent optional fields omitted.
 */
export function imageAttachmentRefWithId(attachmentId: z.ZodType<AttachmentId, string>): z.ZodType<ImageAttachmentRef> {
  return z.object({
    attachmentId,
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    name: z.string().min(1).max(255).optional(),
    originalDimensions: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict().optional(),
  }).strict().transform((value): ImageAttachmentRef => ({
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions }),
  }))
}
