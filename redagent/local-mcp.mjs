// Minimal client for REDnode's stateless Streamable HTTP MCP endpoint.
// REDnode creates a fresh MCP server for each POST and deliberately returns no
// session id, so calls are sent as independent JSON-RPC requests with its token.

function mcpError(payload, fallback) {
  if (payload?.error) {
    const detail = payload.error.message ?? JSON.stringify(payload.error);
    return new Error(`REDnode MCP: ${detail}`);
  }
  return new Error(fallback);
}

function decodePayload(text, contentType) {
  if (!text.trim()) return null;
  if (contentType.includes('application/json')) {
    try { return JSON.parse(text); } catch { /* try the event-stream form */ }
  }
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let i = data.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(data[i]); } catch { /* next event */ }
  }
  throw new Error('REDnode MCP returned an unreadable JSON-RPC response.');
}

async function request(connection, message, signal) {
  if (!connection?.url || !connection?.headers) {
    throw new Error("REDnode's MCP connection details are unavailable. Allow REDagent's MCP permission in the REDnode launcher.");
  }
  const response = await fetch(connection.url, {
    method: 'POST',
    headers: {
      ...connection.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
    signal,
  });
  if (response.status === 202 || message.id === undefined) {
    if (!response.ok) throw new Error(`REDnode MCP returned HTTP ${response.status}.`);
    return null;
  }
  const body = await response.text();
  const payload = decodePayload(body, response.headers.get('content-type') ?? '');
  if (!response.ok) throw mcpError(payload, `REDnode MCP returned HTTP ${response.status}.`);
  if (!payload) throw new Error('REDnode MCP returned an empty response.');
  if (payload.error) throw mcpError(payload);
  if (payload.id !== undefined && payload.id !== message.id) {
    throw new Error('REDnode MCP returned a response for a different request.');
  }
  return payload.result;
}

let nextId = 1;

/** List tools exposed by the current REDnode MCP connection. */
export async function listRednodeTools(connection, signal) {
  await request(connection, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'REDagent-local-provider', version: '0.4.0' },
    },
  }, signal);
  await request(connection, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }, signal);
  const result = await request(connection, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/list',
    params: {},
  }, signal);
  if (!Array.isArray(result?.tools)) {
    throw new Error("REDnode MCP didn't return a list of tools.");
  }
  return result.tools;
}

export async function callRednodeTool(connection, name, args, signal) {
  const result = await request(connection, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
  }, signal);
  const parts = (result?.content ?? []).map((item) => {
    if (item.type === 'text') return item.text;
    if (item.type === 'image') return '[This tool returned an image. Image input is not yet forwarded to the local model.]';
    return '';
  }).filter(Boolean);
  const output = parts.join('\n\n') || 'REDnode tool completed without text output.';
  return result?.isError ? `Tool error: ${output}` : output;
}
