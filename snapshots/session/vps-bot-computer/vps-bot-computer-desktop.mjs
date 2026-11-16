/** Deterministic external desktop command fixture for the scoped Computer tool. */

const [sessionId, ...command] = process.argv.slice(2)
if (sessionId !== 'bot-session-sender') throw new Error(`unexpected VPS Bot Session: ${sessionId}`)

if (command.length === 1 && command[0] === '/usr/local/bin/yharness-vps-bot-capture') {
  process.stdout.write(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
} else if (JSON.stringify(command) === JSON.stringify([
  'xdotool', 'type', '--clearmodifiers', '--delay', '0', '--', 'Hello from the scoped Computer',
])) {
  // The external fixture accepts exactly one action and emits no model-visible output.
} else {
  throw new Error(`unexpected VPS desktop command: ${JSON.stringify(command)}`)
}
