/** Public prefix used for newly packaged Y Harness installers and update archives. */
export declare const DESKTOP_ARTIFACT_PREFIX: 'y-harness'

/** Prefix used by releases produced before the Y Harness application rebrand. */
export declare const LEGACY_DESKTOP_ARTIFACT_PREFIX: 'deepseek-harness'

/** Build the shared installer stem for one target. */
export declare function desktopArtifactBase(version: string, os: string, arch: string): string

/** Build one packaged installer or update archive name. */
export declare function desktopArtifactFilename(
  version: string,
  os: string,
  arch: string,
  extension: string,
  unsigned?: boolean,
): string

/** Match current and pre-rebrand artifact names while reading existing feeds. */
export declare function desktopArtifactPattern(): RegExp
