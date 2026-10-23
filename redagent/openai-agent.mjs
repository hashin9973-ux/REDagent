// A small OpenAI-compatible chat-completions client for REDagent.
//
// This module deliberately uses only Node's built-in fetch and streams. It does not
// depend on Anthropic's Claude Agent SDK. The caller owns tool permissions, file
// safety, and user confirmations; this module only handles HTTP and the tool loop.

const MAX_TOOL_ROUNDS = 20;
const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_HISTORY_MESSAGES = 48;

export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Set the OpenAI-compatible API base URL first.');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function compactHistory(history) {
  const items = Array.isArray(history) ? history.filter((m) => m && typeof m.role === 'string') : [];
  if (items.length <= MAX_HISTORY_MESSAGES) return items;
  // Start at a user turn, so we do not split an assistant tool-call group from its results.
  const start = items.length - MAX_HISTORY_MESSAGES;
  const aligned = items.findIndex((m, i) => i >= start && m.role === 'user');
  return items.slice(aligned < 0 ? start : aligned);
}

function errorText(text, status) {
  let detail = String(text ?? '').trim();
  try {
    const body = JSON.parse(detail);
    detail = body.error?.message ?? body.message ?? detail;
  } catch {
    // Keep the provider's plain-text error.
  }
  return `OpenAI-compatible endpoint returned HTTP ${status}${detail ? `: ${detail.slice(0, 1000)}` : ''}`;
}

function jsonSafeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const result = { ...schema };
  // MCP input schemas often have metadata that some local OpenAI-compatible servers
  // reject even though it is valid JSON Schema.
  delete result.$schema;
  delete result.$id;
  delete result.title;
  return result.type ? result : { type: 'object', properties: {} };
}

async function completion({ baseUrl, apiKey, model, messages, tools, signal, onText }) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = { model, messages, stream: true };
  if (tools?.length) body.tools = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: String(t.description ?? '').slice(0, 4000),
      parameters: jsonSafeSchema(t.inputSchema),
    },
  }));

  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(errorText(detail, response.status));
  }
  if (!response.body) throw new Error('The OpenAI-compatible endpoint returned an empty response.');

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('The endpoint returned no assistant message.');
    if (choice.message.content) onText?.(String(choice.message.content));
    return { message: choice.message, usage: data.usage ?? null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  let finishReason = null;
  const calls = new Map();

  const processData = (data) => {
    const raw = data.trim();
    if (!raw || raw === '[DONE]') return;
    let packet;
    try { packet = JSON.parse(raw); } catch { return; }
    if (packet.usage) usage = packet.usage;
    const choice = packet.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const item of delta.tool_calls ?? []) {
      const index = Number.isInteger(item.index) ? item.index : calls.size;
      const current = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (item.id) current.id = item.id;
      if (item.type) current.type = item.type;
      if (item.function?.name) current.function.name += item.function.name;
      if (item.function?.arguments) current.function.arguments += item.function.arguments;
      calls.set(index, current);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Stopped.');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) processData(line.slice(5));
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) processData(line.slice(5));
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  const message = { role: 'assistant', content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (!message.content && !message.tool_calls?.length && finishReason !== 'stop') {
    throw new Error('The endpoint ended without assistant text or tool calls.');
  }
  return { message, usage };
}

function toolResultText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'Tool completed with no output.';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/**
 * Run one user turn. History contains OpenAI chat messages from earlier turns but
 * no system message. executeTool must enforce every permission before doing work.
 */
export async function runOpenAICompatibleTurn({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  history = [],
  prompt,
  tools = [],
  executeTool,
  signal,
  onText,
  onToolStart,
  onToolDone,
  onUsage,
  maxToolRounds = MAX_TOOL_ROUNDS,
}) {
  if (!String(model ?? '').trim()) throw new Error('Set the model name first.');
  if (typeof executeTool !== 'function') throw new Error('No tool executor was configured.');

  const messages = [
    { role: 'system', content: String(systemPrompt ?? '') },
    ...compactHistory(history),
    { role: 'user', content: prompt },
  ];
  let lastUsage = null;

  for (let round = 0; round < maxToolRounds; round += 1) {
    if (signal?.aborted) throw new Error('Stopped.');
    const result = await completion({
      baseUrl, apiKey, model, messages, tools, signal, onText,
    });
    lastUsage = result.usage ?? lastUsage;
    messages.push(result.message);

    const toolCalls = result.message.tool_calls ?? [];
    if (!toolCalls.length) {
      onUsage?.(lastUsage);
      return { messages, usage: lastUsage, rounds: round + 1 };
    }

    for (const call of toolCalls) {
      const id = call.id || `local-${Date.now()}-${round}-${messages.length}`;
      const name = call.function?.name ?? '';
      let args;
      let output;
      let isError = false;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('Tool arguments must be a JSON object.');
        }
      } catch (err) {
        args = {};
        output = `Invalid tool arguments: ${err.message}`;
        isError = true;
      }

      onToolStart?.({ id, name, input: args });
      if (!isError) {
        try {
          output = await executeTool(name, args, { signal, toolUseID: id });
        } catch (err) {
          output = err instanceof Error ? err.message : String(err);
          isError = true;
        }
      }
      const text = toolResultText(output);
      onToolDone?.({ id, name, error: isError });
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: (isError ? `Tool error: ${text}` : text).slice(0, MAX_TOOL_RESULT_CHARS),
      });
    }
  }

  throw new Error(`Stopped after ${maxToolRounds} tool rounds to prevent an endless tool loop.`);
}
