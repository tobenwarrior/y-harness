import { once } from 'node:events'
import { createConnection, type Server, type Socket } from 'node:net'

/** Test-only transport preserving request half-close on Windows. */
export function brokerFixture(): {
  listen: (server: Server, path: string) => Promise<void>
  connect: (options: { readonly path: string }) => Socket
  clear: () => void
} {
  const ports = new Map<string, number>()
  return {
    async listen(server, path) {
      if (process.platform === 'win32' || process.env.YH_TEST_BROKER_TRANSPORT === 'tcp') {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('Expected TCP broker address')
        ports.set(path, address.port)
      } else {
        server.listen(path)
        await once(server, 'listening')
      }
    },
    connect({ path }) {
      const port = ports.get(path)
      return port === undefined ? createConnection({ path }) : createConnection({ port, host: '127.0.0.1' })
    },
    clear() { ports.clear() },
  }
}
