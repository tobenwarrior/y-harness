import { Service } from '@yharness/cordis'

/** Service whose public annotations are intentionally absent. */
export class WritableService extends Service {
  value = 1

  echo(input = 'value') {
    return input
  }
}

declare module '@yharness/cordis' {
  interface Context {
    writable: WritableService
  }
}

export default WritableService
