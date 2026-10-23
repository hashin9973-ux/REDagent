import test from 'node:test';
import assert from 'node:assert/strict';
import { callRednodeTool, listRednodeTools } from '../local-mcp.mjs';

test('lists and calls tools through REDnode stateless MCP HTTP', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const message = JSON.parse(init.body);
    requests.push({ url: String(url), init, message });
    if (message.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'rednode', version: 'test' },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [{
          name: 'logs',
          description: 'Read the mod log.',
          inputSchema: { type: 'object', properties: { errorsOnly: { type: 'boolean' } } },
        }],
      };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'The mod log is clean.' }] };
    } else {
      throw new Error('Unexpected MCP method: ' + message.method);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const connection = {
    url: 'http://127.0.0.1:41820/mcp',
    headers: { authorization: 'Bearer test-only' },
  };
  const tools = await listRednodeTools(connection);
  assert.equal(tools[0].name, 'logs');
  assert.equal(await callRednodeTool(connection, 'logs', { errorsOnly: true }), 'The mod log is clean.');
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.url === connection.url));
  assert.ok(requests.every((request) => request.init.headers.authorization === 'Bearer test-only'));
  assert.deepEqual(requests[3].message.params.arguments, { errorsOnly: true });
});
