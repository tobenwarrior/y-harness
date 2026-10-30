/** Serialize release settings without exposing dotenv delimiters. */
export function serializeDesktopDotenvValue(value: string): string

/** Write selected environment settings without logging their values. */
export function writeDesktopDotenvFile(
  path: string,
  names: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<void>
