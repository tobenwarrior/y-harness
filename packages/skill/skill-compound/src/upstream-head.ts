import { spawn } from 'node:child_process'

/** Public Compound repository whose main ref supplies the active skills. */
export const UPSTREAM_REPOSITORY = 'tobenwarrior/compound-skills'

const UPSTREAM_BRANCH = 'main'
const SHA_PATTERN = /^[a-f0-9]{40}$/u
const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_BYTES = 64 * 1024

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'The operation was aborted')
}

function rateLimited(response: Response): boolean {
  if (response.status === 429) return true
  return response.status === 403 && (
    response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
  )
}

function parseCommit(value: unknown): string {
  const commit = typeof value === 'object' && value !== null && 'sha' in value
    ? (value as { sha?: unknown }).sha
    : undefined
  if (typeof commit !== 'string' || !SHA_PATTERN.test(commit)) throw new Error('upstream response carries no valid commit')
  return commit
}

async function apiHead(signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(GIT_TIMEOUT_MS)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/${UPSTREAM_BRANCH}`, {
    signal: requestSignal,
    headers: { accept: 'application/vnd.github+json' },
  })
  if (rateLimited(response)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('GitHub API rate limit')
  }
  if (!response.ok) throw new Error(`upstream commit answered HTTP ${response.status}`)
  return parseCommit(await response.json())
}

function gitHead(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const child = spawn('git', [
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      'ls-remote', '--refs', '--heads', '--',
      `https://github.com/${UPSTREAM_REPOSITORY}.git`, `refs/heads/${UPSTREAM_BRANCH}`,
    ], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        SSH_ASKPASS_REQUIRE: 'never',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const stop = (): void => {
      if (!child.killed) child.kill('SIGKILL')
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      stop()
      reject(error)
    }
    const finish = (commit: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(commit)
    }
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (settled) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      bytes += Buffer.byteLength(text)
      if (bytes > GIT_OUTPUT_BYTES) {
        fail(new Error('git ls-remote output exceeded its limit'))
        return
      }
      if (target === 'stdout') stdout += text
      else stderr += text
    }
    const onAbort = (): void => { fail(abortError(signal)) }
    child.stdout.on('data', (chunk: Buffer | string) => { collect('stdout', chunk) })
    child.stderr.on('data', (chunk: Buffer | string) => { collect('stderr', chunk) })
    child.once('error', (error: Error) => { fail(error) })
    child.once('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) {
        const detail = stderr.trim()
        fail(new Error(detail === '' ? `git ls-remote exited ${String(code)}` : detail))
        return
      }
      const commit = stdout.trim().split(/\r?\n/u)
        .map(line => /^([a-f0-9]{40})\s+refs\/heads\/main$/u.exec(line.trim())?.[1])
        .find(value => value !== undefined)
      if (commit === undefined) fail(new Error('git ls-remote returned no main commit'))
      else finish(commit)
    })
    const timer = setTimeout(() => {
      fail(new Error(`git ls-remote timed out after ${String(GIT_TIMEOUT_MS)}ms`))
    }, GIT_TIMEOUT_MS)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolve main without consuming the GitHub API quota when it is rate-limited. */
export async function resolveUpstreamCommit(signal?: AbortSignal): Promise<string> {
  try {
    return await apiHead(signal)
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== 'GitHub API rate limit') throw error
    try {
      return await gitHead(signal)
    } catch (gitError: unknown) {
      const detail = gitError instanceof Error ? gitError.message : String(gitError)
      throw new Error(`GitHub API rate limit; git ls-remote fallback failed: ${detail}`)
    }
  }
}
