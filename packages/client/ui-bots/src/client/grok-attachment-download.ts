/** Build the authenticated download URL for one imported Grok attachment. */

/**
 * Address an imported attachment by its original archive position.
 * @param botId - Bot with the owner-authorized archive.
 * @param sourceId - Primary or supplemental source identity.
 * @param sourceSequence - Attachment position in that source.
 * @returns The authenticated download URL.
 */
export function grokAttachmentDownloadUrl(botId: string, sourceId: string, sourceSequence: number): string {
  const query = new URLSearchParams({ botId, sourceId, sourceSequence: String(sourceSequence) })
  return `/api/bots/grokHistory/downloadAttachment?${query}`
}
