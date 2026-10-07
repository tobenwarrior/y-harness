/**
 * Read the optional public display name; application identifiers remain independent.
 * @param root - Repository containing app-branding.json.
 * @returns Configured name, or undefined to preserve current labels.
 * @throws If the configuration cannot be read or its name is invalid.
 */
export function readAppDisplayName(root?: string): string | undefined
