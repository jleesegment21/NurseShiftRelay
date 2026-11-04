const OpenAI = require('openai');

let openai = null;
function client() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}
const MODEL = 'gpt-4o';

/**
 * Non-streaming chat completion.
 * Used for SMS responses where latency is less critical.
 *
 * @param {Array} messages - OpenAI messages array
 * @param {Array} tools - OpenAI tool definitions array
 * @returns {object} OpenAI completion response
 */
async function chat(messages, tools) {
  const params = {
    model: MODEL,
    messages,
  };
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }
  return client().chat.completions.create(params);
}

/**
 * Streaming chat completion.
 * Used for voice (ConversationRelay) to send tokens back as they arrive.
 *
 * @param {Array} messages - OpenAI messages array
 * @param {Array} tools - OpenAI tool definitions array
 * @param {Function} onToken - Called with each text token string as it streams
 * @param {AbortSignal} signal - AbortController signal to cancel stream on interrupt
 * @returns {Promise<{role, content, tool_calls}|null>}
 *   Resolves with the full assistant message when complete, or null if aborted.
 */
async function chatStream(messages, tools, onToken, signal) {
  const params = {
    model: MODEL,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }

  try {
    const stream = await client().chat.completions.create(params, { signal });

    let fullContent = '';
    const toolCallAccumulators = {}; // index → { id, name, argumentsStr }

    for await (const chunk of stream) {
      if (signal?.aborted) break;

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content token
      if (delta.content) {
        fullContent += delta.content;
        onToken(delta.content);
      }

      // Tool call deltas — accumulate across chunks
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulators[tc.index]) {
            toolCallAccumulators[tc.index] = { id: '', name: '', argumentsStr: '' };
          }
          const acc = toolCallAccumulators[tc.index];
          if (tc.id) acc.id += tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.argumentsStr += tc.function.arguments;
        }
      }
    }

    if (signal?.aborted) return null;

    // Build final tool_calls array if any tool calls were made
    const toolCalls = Object.values(toolCallAccumulators);
    const hasToolCalls = toolCalls.length > 0 && toolCalls.some((tc) => tc.name);

    return {
      role: 'assistant',
      content: fullContent || null,
      tool_calls: hasToolCalls
        ? toolCalls.map((tc, i) => ({
            id: tc.id || `call_${i}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.argumentsStr },
          }))
        : undefined,
    };
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) return null;
    throw err;
  }
}

module.exports = { chat, chatStream };
