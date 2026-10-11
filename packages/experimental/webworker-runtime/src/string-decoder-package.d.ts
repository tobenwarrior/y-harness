/** The maintained userland decoder exposes Node's StringDecoder API at its browser-safe entry. */
declare module 'string_decoder/lib/string_decoder.js' {
  export { StringDecoder } from 'node:string_decoder'
}
