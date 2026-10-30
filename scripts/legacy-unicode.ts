const CODE_POINT_ESCAPE = /\\u\{([0-9a-fA-F]{1,6})\}/gu

/**
 * Decode explicit Unicode code-point escapes used by retired compatibility assets.
 * Invalid scalar values remain unchanged so the decoder cannot silently corrupt data.
 *
 * @param value - Asset text that may contain `\\u{...}` escapes.
 * @returns Text with valid Unicode scalar escapes decoded.
 */
export function decodeUnicodeEscapes(value: string): string {
  return value.replace(CODE_POINT_ESCAPE, (token: string, hex: string) => {
    const codePoint = Number.parseInt(hex, 16)
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return token
    return String.fromCodePoint(codePoint)
  })
}
