/** Realistic pinned API message bodies for transport-only fixtures. */
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export function assistantBody(content: BetaMessage['content']): BetaMessage {
  return { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-native-model', content,
    container: null, context_management: null, stop_details: null, stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation: null, cache_creation_input_tokens: null,
      cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null } }
}
