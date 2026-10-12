/** Stateful Node byte decoding backed by the maintained string_decoder implementation. */
import { Buffer } from 'buffer'
import { StringDecoder as PackageStringDecoder } from 'string_decoder/lib/string_decoder.js'

/**
 * Decode Node-admitted byte views while retaining the maintained decoder's multibyte state.
 */
export class StringDecoder {
  private decoder: PackageStringDecoder
  private readonly packageEncoding: BufferEncoding | undefined
  private readonly base64url: boolean

  /**
   * Create a stateful decoder for the selected Node encoding.
   * @param requestedEncoding - Encoding name; omitted input uses UTF-8.
   */
  constructor(requestedEncoding?: BufferEncoding) {
    this.base64url = requestedEncoding?.toLowerCase() === 'base64url'
    this.packageEncoding = this.base64url ? 'base64' : requestedEncoding
    this.decoder = new PackageStringDecoder(this.packageEncoding)
  }

  /**
   * Decode the input, retaining an incomplete character for the next call.
   * @param input - Text or bytes, including a view into a larger backing buffer.
   * @returns The complete decoded characters.
   */
  write(input: string | NodeJS.ArrayBufferView): string {
    if (typeof input === 'string') return input
    return this.decodedOutput(this.decoder.write(decoderInput(input)))
  }

  /**
   * Decode final input and flush any pending incomplete character.
   * @param input - Optional final text or bytes.
   * @returns The final decoded characters.
   */
  end(input?: string | NodeJS.ArrayBufferView): string {
    const final = input === undefined ? '' : this.write(input)
    const remaining = this.decodedOutput(this.decoder.end())
    this.decoder = new PackageStringDecoder(this.packageEncoding)
    return final + remaining
  }

  private decodedOutput(output: string): string {
    return this.base64url ? output.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '') : output
  }
}

function decoderInput(input: NodeJS.ArrayBufferView): Buffer {
  if (Buffer.isBuffer(input)) return input
  return Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
}

/** CommonJS interop marker consumed by the Worker module loader. */
export const __esModule = true

/** CommonJS-compatible namespace for default imports. */
export default { StringDecoder }
