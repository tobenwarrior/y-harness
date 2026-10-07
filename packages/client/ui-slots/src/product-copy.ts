/** Build-time product naming for explicitly selected locale dictionary entries. */

/**
 * Apply the configured display name to product mentions in one dictionary value.
 * Unset configuration preserves the original copy, including upstream names.
 * @param text - Locale-owned product copy selected by its dictionary author.
 * @returns Copy with legacy product names replaced literally when configured.
 */
export function withProductDisplayName(text: string): string {
  const displayName = process.env.DSH_CLIENT_DISPLAY_NAME
  return displayName === undefined
    ? text
    : text.replace(/DeepSeek Harness|Y Harness/g, () => displayName)
}
