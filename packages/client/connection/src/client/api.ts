/** Browser-safe Connection protocol and shared application value exports. */

export type {
  ClientRequest,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  RpcResult,
  ServerResponse,
} from '../rpc.ts'
export { RpcId, transportError } from '../rpc.ts'
export type { SessionId, SessionEvent } from '@yharness/session/types'
export type { MessageId } from '@yharness/llm/brand'
export type { ContentBlock, StreamChunk } from '@yharness/llm/types'

import type { RpcResponse, RpcResult } from '../rpc.ts'

/**
 * Return the business result carried by an RPC response.
 * @param response - RPC response to unwrap.
 * @returns the response's business result.
 */
export function resultOf<T>(response: RpcResponse<T>): RpcResult<T> {
  return response.result
}
