// A small OpenAI-compatible chat-completions client for REDagent.
//
// This module deliberately uses only Node's built-in fetch and streams. It does not
// depend on Anthropic's Claude Agent SDK. The caller owns tool permissions, file
// safety, and user confirmations; this module only handles HTTP and the tool loop.

const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 7_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 24_000;

export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Set the OpenAI-compatible API base URL first.');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function compactHistory(history) {
  const items = Array.isArray(history) ? history.filter((m) => m && typeof m.role === 'string') : [];
  const starts = [];
  for (let i = 0; i < items.length; i += 1) if (items[i].role === 'user') starts.push(i);
  const turns = starts.map((start, i) => items.slice(start, starts[i + 1] ?? items.length));
  const selected = [];
  let chars = 0;
  let count = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const size = turn.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
    if (selected.length && (chars + size > MAX_HISTORY_CHARS || count + turn.length > MAX_HISTORY_MESSAGES)) break;
    if (!selected.length && size > MAX_HISTORY_CHARS) {
      // Keep a compact trace of an unusually large prior turn, never a dangling tool call.
      const user = turn.find((message) => message.role === 'user');
      const answer = [...turn].reverse().find((message) =>
        message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string');
      return [user, ...(answer ? [{ role: 'assistant', content: answer.content.slice(0, 4_000) }] : [])].filter(Boolean);
    }
    selected.unshift(...turn);
    chars += size;
    count += turn.length;
  }
  return selected;
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
  const clean = (value, depth = 0) => {
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
    if (!value || typeof value !== 'object' || depth > 12) return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      // Strip documentation-only keywords which some lightweight servers reject.
      if (['$schema', '$id', 'title', 'examples', 'deprecated'].includes(key)) continue;
      if (key === 'description' && typeof item === 'string') result[key] = item.slice(0, 500);
      else result[key] = clean(item, depth + 1);
    }
    return result;
  };
  const result = clean(schema);
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
      description: String(t.description ?? '').slice(0, 1_500),
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
  let generatedToolId = 0;

  for (let round = 0; round < Math.min(MAX_TOOL_ROUNDS, Math.max(1, maxToolRounds)); round += 1) {
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
      const id = call.id || `local-${Date.now()}-${round}-${++generatedToolId}`;
      call.id = id; // Keep the assistant tool_calls id paired with the tool result.
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
      const outputText = isError ? `Tool error: ${text}` : text;
      const boundedOutput = outputText.length > MAX_TOOL_RESULT_CHARS
        ? outputText.slice(0, MAX_TOOL_RESULT_CHARS) + '\n[Tool result truncated. Ask for a narrower range if more detail is needed.]'
        : outputText;
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: boundedOutput,
      });
    }
  }

  throw new Error(`Stopped after ${maxToolRounds} tool rounds to prevent an endless tool loop.`);
}
