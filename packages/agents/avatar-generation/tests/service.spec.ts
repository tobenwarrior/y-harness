import { Context } from '@yharness/cordis'
import { AttachmentStore, AttachmentId, type ImageAttachmentRef, type SaveImageAttachment, type StoredImageAttachment } from '@yharness/attachment'
import { describe, expect, it, vi } from 'vitest'
import AvatarGenerationService from '../src/index.ts'

const storedRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
  mediaType: 'image/png',
  bytes: 4,
  width: 64,
  height: 64,
  name: 'avatar.png',
}

class FakeAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1024 * 1024,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1024 * 1024,
    maxImagePixels: 2048 * 2048,
    maxImageDimension: 2048,
    mediaTypes: ['image/png'] as const,
  }
  readonly saved: Uint8Array[] = []
  readonly stored = Uint8Array.of(1, 2, 3, 4)

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input.data)
    return storedRef
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return { ref, data: this.stored }
  }
}

function response(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response
}

function harness(fetch: typeof globalThis.fetch, configured = true, options: {
  readonly timeoutMs?: number
  readonly maxImageBytes?: number
  readonly maxResponseBytes?: number
} = {}) {
  const ctx = new Context()
  const attachments = new FakeAttachments(ctx)
  ctx.provide('credentials', {
    describe: vi.fn(async () => ({ configured, source: 'env', writable: false })),
    resolve: vi.fn(async () => configured ? { value: 'sk-test', source: 'env' } : undefined),
  } as never)
  ctx.provide('settings', {
    describe: () => [{
      ns: 'llm-pi-ai', autoGenerate: false, schema: {}, revision: 1, applies: 'live',
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    }],
  } as never)
  const service = new AvatarGenerationService(ctx, {
    baseURL: 'https://api.openai.test/v1',
    model: 'gpt-image-2.5-flare',
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  }, { fetch })
  return { ctx, service, attachments }
}

function streamingResponse(
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
  close = true,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    },
    ...(onCancel === undefined ? {} : { cancel: onCancel }),
  })
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body,
    json: async () => ({ data: [] }),
  } as Response
}

describe('AvatarGenerationService', () => {
  it('discovers the OpenAI route without exposing its credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const h = harness(fetch, true)

    const status = await h.service.status()
    expect(status).toEqual({
      available: true,
      provider: 'openai',
      model: 'gpt-image-2.5-flare',
    })
    expect(status).not.toHaveProperty('credential')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('generates a validated transparent PNG preview without storing it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string; prompt?: string; background?: string; output_format?: string }
      expect(body.model).toBe('gpt-image-2.5-flare')
      expect(body.prompt).toContain('A friendly mint fox with a tiny star')
      expect(body.background).toBe('transparent')
      expect(body.output_format).toBe('png')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
      return response({ data: [{ b64_json: Buffer.from('generated').toString('base64') }] })
    })
    const h = harness(fetch, true)

    await expect(h.service.generate({ description: 'A friendly mint fox with a tiny star' }, new AbortController().signal)).resolves.toEqual({
      data: Buffer.from('generated').toString('base64'),
      mediaType: 'image/png',
    })
    expect(h.attachments.saved).toHaveLength(0)
  })

  it('stores a generated preview only when the user commits it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({
      data: [{ b64_json: Buffer.from('generated').toString('base64') }],
    }))
    const h = harness(fetch, true)
    const preview = await h.service.generate({ description: 'A calm blue orb' }, new AbortController().signal)

    await expect(h.service.commit(preview)).resolves.toEqual({ attachment: storedRef })
    expect(h.attachments.saved).toHaveLength(1)
  })

  it('bounds a committed preview before decoding or storing it', async () => {
    const h = harness(vi.fn<typeof globalThis.fetch>(), true, { maxImageBytes: 3 })
    const oversized = { data: Buffer.alloc(4).toString('base64'), mediaType: 'image/png' as const }

    await expect(h.service.commit(oversized)).rejects.toMatchObject({ code: 'avatar-generation/attachment' })
    expect(h.attachments.saved).toHaveLength(0)
  })

  it('reports an unavailable status and makes no provider request when the credential is absent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const h = harness(fetch, false)

    await expect(h.service.status()).resolves.toMatchObject({
      available: false,
      provider: 'openai',
      reason: 'openai-credential-not-configured',
    })
    await expect(h.service.generate({ description: 'Anything' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'avatar-generation/unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps provider rate limits without writing an attachment', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ error: { message: 'busy' } }, 429))
    const h = harness(fetch, true)

    await expect(h.service.generate({ description: 'A calm blue orb' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'avatar-generation/rate-limited', details: { status: 429 } })
    expect(h.attachments.saved).toHaveLength(0)
  })

  it('rejects an oversized response body before parsing or storing it', async () => {
    let cancelled = false
    const fetch = vi.fn<typeof globalThis.fetch>(async () => streamingResponse(
      [new Uint8Array(33)],
      () => { cancelled = true },
      false,
    ))
    const h = harness(fetch, true, { maxResponseBytes: 32 })

    await expect(h.service.generate({ description: 'A calm blue orb' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'avatar-generation/response-invalid' })
    expect(h.attachments.saved).toHaveLength(0)
    expect(cancelled).toBe(true)
  })

  it('cancels a provider error body before returning the mapped error', async () => {
    let cancelled = false
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = streamingResponse([new Uint8Array(1)], () => { cancelled = true }, false)
      return { ...response, ok: false, status: 500 } as Response
    })
    const h = harness(fetch, true)

    await expect(h.service.generate({ description: 'A calm blue orb' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'avatar-generation/provider', details: { status: 500 } })
    expect(cancelled).toBe(true)
  })

  it('keeps the timeout active while a provider response body is still pending', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({ start() {} })
      return { ok: true, status: 200, headers: new Headers(), body, json: async () => ({}) } as Response
    })
    const h = harness(fetch, true, { timeoutMs: 1_000 })

    await expect(h.service.generate({ description: 'A calm blue orb' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'avatar-generation/network' })
    expect(h.attachments.saved).toHaveLength(0)
  }, 2_000)
})
