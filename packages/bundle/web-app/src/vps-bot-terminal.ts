/**
 * Manage the Linux PTY session inside the Bot container. Podman can leave an
 * exec PTY running after its host-side client exits.
 * @module @yharness/web-app/vps-bot-terminal
 */

import type { SubprocessTerminalHandle } from '@yharness/subprocess'

const terminalScopeScript = String.raw`
import contextlib, fcntl, os, re, signal, stat, sys, time

operation, key, *args = sys.argv[1:]
if not re.fullmatch(r'[0-9a-f]{32}', key):
    raise ValueError('Invalid terminal identity')
path = '/tmp/.yharness-pty-' + key

def process(pid):
    try:
        with open(f'/proc/{pid}/stat', encoding='utf-8', errors='replace') as record:
            return record.read().rsplit(') ', 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None

def signal_session(sid, birth, number):
    leader = process(sid)
    if leader is not None and leader[19] != birth:
        return False
    found = False
    for pid in os.listdir('/proc'):
        if not pid.isdecimal():
            continue
        with contextlib.suppress(ProcessLookupError):
            candidate = process(pid)
            if candidate is None or candidate[3] != sid or candidate[0] in ('X', 'Z'):
                continue
            fd = os.pidfd_open(int(pid))
            try:
                current = process(pid)
                if current is not None and current[3] == sid and current[19] == candidate[19] and current[0] not in ('X', 'Z'):
                    signal.pidfd_send_signal(fd, number)
                    found = True
            finally:
                os.close(fd)
    return found

flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
with os.fdopen(os.open(path, flags, 0o600), 'r+', encoding='ascii') as record:
    info = os.fstat(record.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('Invalid terminal state file')
    fcntl.flock(record, fcntl.LOCK_EX)
    state = record.read(96)
    if operation == 'start':
        pid = os.getpid()
        if state or os.getsid(0) != pid:
            raise RuntimeError('Terminal session is unavailable')
        record.write(f'{pid} {process(pid)[19]}\n')
        record.flush()
        term, *command = args
        os.execvpe(command[0], command, {**os.environ, 'TERM': term})
    elif operation == 'stop':
        if not state:
            # Closing before Podman allocates the terminal prevents late startup.
            record.write('closed\n')
        elif state != 'closed\n':
            sid, birth = state.split()
            if not sid.isdecimal() or int(sid) <= 1 or not birth.isdecimal():
                raise ValueError('Invalid terminal process identity')
            grace = min(int(args[0]), 9000) / 1000
            for number, seconds in ((signal.SIGHUP, grace), (signal.SIGKILL, 1.5)):
                expiry = time.monotonic() + seconds
                while signal_session(sid, birth, number):
                    if time.monotonic() >= expiry:
                        break
                    time.sleep(0.04)
                else:
                    os.unlink(path)
                    break
            else:
                raise RuntimeError('Terminal session is still running')
    else:
        raise ValueError('Invalid terminal operation')
`

/** Terminal group control command for the desktop image's Linux process namespace. */
export const TERMINAL_SCOPE_COMMAND = ['/usr/bin/python3', '-I', '-c', terminalScopeScript] as const

/**
 * Pair a Podman client with its exact in-container terminal session.
 * @param terminal - Host PTY that relays input and output.
 * @param stop - Terminate and verify the in-container session.
 * @returns A terminal whose close waits for both sides, including after client exit.
 */
export function scopedBotTerminal(terminal: SubprocessTerminalHandle, stop: () => Promise<void>): SubprocessTerminalHandle {
  let closing: Promise<void> | undefined
  const terminate = (): Promise<void> => {
    closing ??= Promise.allSettled([stop(), terminal.terminate()]).then((results) => {
      const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length > 0) {
        closing = undefined
        throw new AggregateError(errors, 'The VPS Bot terminal could not close.')
      }
    })
    return closing
  }
  const done = terminal.done.then(async (outcome) => {
    await terminate()
    return outcome
  }, async (error: unknown) => {
    try {
      await terminate()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'The VPS Bot terminal failed and could not close.')
    }
    throw error
  })
  return {
    pid: terminal.pid,
    output: terminal.output,
    done,
    write: data => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    inspectActivity: () => terminal.inspectActivity(),
    inspectForeground: () => Promise.resolve(undefined),
    signalForeground: () => Promise.reject(new Error('The container terminal foreground is unavailable.')),
    terminate,
  }
}
