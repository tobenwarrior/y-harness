/** Client entry for the Host-owned avatar-generation capability. */

/** No Client service is mounted; `api-remotes` owns the generated namespace mount. */
export const inject: readonly string[] = []

/** Keep the package's Client face inert until a Bot editor consumes it. */
export function apply(): void {}

export type * from '../types.ts'
