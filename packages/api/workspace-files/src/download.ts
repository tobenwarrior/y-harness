/** HTTP attachment headers for already-authorized workspace file downloads. */

/**
 * Deliver arbitrary file bytes as an attachment.
 * @param body - bytes or stream from the file's authorized filesystem.
 * @param filename - the file's basename.
 * @param size - the exact byte count, when known.
 * @returns an uncacheable attachment response.
 */
export function fileDownloadResponse(body: BodyInit, filename: string, size?: number): Response {
  const safeName = filename.replace(/\p{Surrogate}/gu, '\uFFFD').replace(/[\u0000-\u001f\u007f]/gu, '_')
  const name = encodeURIComponent(safeName)
    .replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16)}`)
  return new Response(body, { headers: {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="download"; filename*=UTF-8''${name}`,
    ...(size === undefined ? {} : { 'content-length': String(size) }),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } })
}
