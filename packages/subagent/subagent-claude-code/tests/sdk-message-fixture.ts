/** Realistic pinned API message bodies for transport-only fixtures. */
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'

type AssistantBody = SDKAssistantMessage['message']

export function assistantBody(content: AssistantBody['content']): AssistantBody {
  // Newer SDK peers require these nullable response fields in hoisted installs.
  const responseFields = { diagnostics: null }
  const usageFields = { fallback_credit: null, output_tokens_details: null }
  return { ...responseFields, id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-native-model', content,
    container: null, context_management: null, stop_details: null, stop_reason: null, stop_sequence: null,
    usage: { ...usageFields, input_tokens: 1, output_tokens: 1, cache_creation: null, cache_creation_input_tokens: null,
      cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null } }
}
