/** Asynchronous whole-process confinement behind the SDK's synchronous spawn interface. */
import { EventEmitter } from 'node:events'
import { Transform, type TransformCallback } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { claudeSpawnSpec } from './process.ts'

interface ProtocolBounds { readonly lineBytes: number; readonly lifetimeBytes: number }
/** Bound complete wire lines before the SDK's readline/JSON decoder allocates them. */
class BoundedProtocolStream extends Transform {
  private lineBytes = 0
  constructor(private readonly bounds: ProtocolBounds, private readonly count: (bytes: number) => void) { super() }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.count(chunk.length)
      let start = 0
      for (;;) {
        const newline = chunk.indexOf(10, start)
        const end = newline === -1 ? chunk.length : newline
        this.lineBytes += end - start
        if (this.lineBytes > this.bounds.lineBytes) throw new Error('Claude root native protocol line exceeds its configured byte bound.')
        if (newline === -1) break
        this.lineBytes = 0; start = newline + 1
      }
      callback(null, chunk)
    } catch (_error: unknown) { callback(new Error('Claude root native wire protocol exceeds its configured bound.')) }
  }
}

/** Starts no child until the complete initiating policy has been enforced. */
export class ClaudeRootProcess implements SpawnedProcess {
  readonly stdin: Transform
  readonly stdout: Transform
  /** Settles after bounded managed-range observation; rejects when shutdown cannot be confirmed. */
  readonly done: Promise<void>
  private readonly events = new EventEmitter()
  private readonly controller = new AbortController()
  private child?: SubprocessHandle
  private outcome?: SubprocessOutcome
  private stopping = false
  private readonly naturalDrain: boolean
  /** True only when no child started or the managed subprocess owner confirmed an empty range. */
  quiescent = false
  /** True after the actual child stdout ends normally when natural drainage was required. */
  outputDrained = false
  /** Native diagnostic bytes were observed; no diagnostic body is retained or published. */
  diagnosticOutput = false

  constructor(
    ctx: Context, options: SpawnOptions, policy: SandboxExecutionPolicy, graceMs: number, lifetime: AbortSignal,
    current: () => boolean = () => true, bounds: ProtocolBounds = { lineBytes: 1048576, lifetimeBytes: 8388608 },
    drainNaturalOutput = false,
  ) {
    this.naturalDrain = drainNaturalOutput
    this.events.on('error', () => {})
    let bytes = 0
    const count = (count: number) => { bytes += count; if (bytes > bounds.lifetimeBytes) throw new Error('Claude root native wire lifetime exceeds its configured bound.') }
    this.stdin = new BoundedProtocolStream(bounds, count); this.stdout = new BoundedProtocolStream(bounds, count)
    const failed = (error: Error) => { this.events.emit('error', error); this.controller.abort(error); this.child?.terminate() }
    this.stdin.on('error', failed); this.stdout.on('error', failed)
    const stdin = this.stdin; const stdout = this.stdout
    const signal = AbortSignal.any([lifetime, this.controller.signal, options.signal])
    this.done = (async () => {
      const spec = claudeSpawnSpec(options, graceMs)
      signal.throwIfAborted()
      if (!current()) throw new Error('Claude root initiating policy changed before process startup.')
      const confined = policy.mode === 'danger-full-access' ? undefined
        : await ctx.sandbox.confine(spec.argv, { ...policy, mode: policy.mode }, signal)
      signal.throwIfAborted()
      if (!current()) throw new Error('Claude root initiating policy changed before process startup.')
      if (confined !== undefined && confined.enforcement !== 'full') throw new Error('Claude root route requires complete process confinement.')
      const child = ctx.subprocess.spawn({ ...spec, argv: confined?.argv ?? spec.argv, signal,
        ...drainNaturalOutput ? { stdio: { stdin: 'pipe' as const, stdout: 'pipe' as const, stderr: 'pipe' as const } } : {},
      })
      this.child = child
      let naturalComplete = false
      try {
        if (child.stdin === undefined || child.stdout === undefined) throw new Error('Claude root process requires piped protocol streams.')
        const output = child.stdout
        const diagnostic = child.stderr
        const diagnosticDrain = Promise.withResolvers<void>()
        const diagnosticData = (chunk: Buffer) => {
          this.diagnosticOutput = true
          try { count(chunk.length) } catch (_error: unknown) {
            const error = new Error('Claude native diagnostics exceed the configured byte bound.')
            diagnosticDrain.reject(error); failed(error)
          }
        }
        const diagnosticEnded = () => { diagnosticDrain.resolve() }
        const diagnosticClosed = () => { if (!diagnostic?.readableEnded) diagnosticDrain.reject(new Error('Claude native diagnostics closed before normal drainage.')) }
        const diagnosticError = (_error: Error) => { diagnosticDrain.reject(new Error('Claude native diagnostics failed before normal drainage.')) }
        const drain = Promise.withResolvers<void>()
        const ended = () => { this.outputDrained = true; drain.resolve() }
        const premature = () => { if (!output.readableEnded) drain.reject(new Error('Claude native output closed before normal drainage.')) }
        const errored = (_error: Error) => { drain.reject(new Error('Claude native output failed before normal drainage.')) }
        if (drainNaturalOutput) {
          if (diagnostic === undefined) throw new Error('Claude native diagnostic stream is unavailable.')
          diagnostic.on('data', diagnosticData); diagnostic.once('end', diagnosticEnded)
          diagnostic.once('close', diagnosticClosed); diagnostic.once('error', diagnosticError)
          if (diagnostic.readableEnded) diagnosticEnded()
          output.once('end', ended); output.once('close', premature); output.once('error', errored)
          if (output.readableEnded) ended()
          // Cancellation may settle direct exit before the readable pipe closes.
          void drain.promise.catch(() => {})
          void diagnosticDrain.promise.catch(() => {})
        }
        stdin.pipe(child.stdin); child.stdout.pipe(stdout)
        const cancelled = Promise.withResolvers<never>()
        const onAbort = () => { cancelled.reject(new Error('Claude root process was cancelled.')) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          signal.throwIfAborted(); this.outcome = await Promise.race([child.done, cancelled.promise])
          if (drainNaturalOutput) {
            await Promise.race([drain.promise, cancelled.promise])
            await Promise.race([diagnosticDrain.promise, cancelled.promise])
            signal.throwIfAborted()
            if (this.stopping || this.outcome.exitCode !== 0 || this.outcome.signal !== null) throw new Error('Claude native process did not exit naturally.')
            naturalComplete = true
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          output.off('end', ended); output.off('close', premature); output.off('error', errored)
          diagnostic?.off('data', diagnosticData); diagnostic?.off('end', diagnosticEnded)
          diagnostic?.off('close', diagnosticClosed); diagnostic?.off('error', diagnosticError)
        }
        this.events.emit('exit', this.outcome.exitCode, this.outcome.signal)
      } finally {
        try {
          if (drainNaturalOutput && naturalComplete) {
            let naturallyEmpty = false
            try { naturallyEmpty = await child.waitForExit(AbortSignal.timeout(Math.min(MAX_TIMER_DELAY_MS, graceMs + 1000))) }
            catch (_error: unknown) { /* Failure to observe the range prevents a natural release receipt. */ }
            if (naturallyEmpty && !signal.aborted && !this.stopping) this.quiescent = true
            else {
              this.stopping = true; child.terminate()
              this.quiescent = await child.waitForExit(AbortSignal.timeout(Math.min(MAX_TIMER_DELAY_MS, graceMs + 1000)))
              throw new Error('Claude native range required termination after its direct process exited.')
            }
          } else {
            if (drainNaturalOutput) this.stopping = true
            child.terminate()
            if (!await child.waitForExit(AbortSignal.timeout(Math.min(MAX_TIMER_DELAY_MS, graceMs + 1000)))) throw new Error('Claude root process did not reach managed-range quiescence.')
            this.quiescent = true
          }
        } finally {
          stdin.unpipe(child.stdin); child.stdout?.unpipe(stdout)
          stdin.end(); stdout.end()
        }
      }
    })().catch((error: unknown) => {
      if (this.child === undefined) this.quiescent = true
      this.events.emit('error', error instanceof Error ? error : new Error('Claude root process failed.'))
      throw error
    })
    void this.done.catch(() => {})
  }

  get killed(): boolean { return this.stopping }
  get exitCode(): number | null { return this.outcome?.exitCode ?? null }
  get signalCode(): NodeJS.Signals | null { return this.outcome?.signal ?? null }
  kill(_signal: NodeJS.Signals): boolean {
    if (this.stopping || this.outcome !== undefined && (!this.naturalDrain || this.quiescent)) return false
    this.stopping = true; this.controller.abort(); this.child?.terminate(); this.stdin.end()
    return true
  }
  on(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void { this.events.on(event, listener) }
  once(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void { this.events.once(event, listener) }
  off(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void { this.events.off(event, listener) }
}
