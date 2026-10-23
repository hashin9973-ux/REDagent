import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletionsUrl, runOpenAICompatibleTurn } from '../openai-agent.mjs';

test('chatCompletionsUrl accepts base URLs and complete endpoint URLs', () => {
  assert.equal(chatCompletionsUrl('http://127.0.0.1:5001/v1'), 'http://127.0.0.1:5001/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://localhost:1234'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/chat/completions');
  assert.throws(() => chatCompletionsUrl('  '), /base URL/);
});

test('agent runs a streamed tool call and sends its result back before answering', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const firstStream = [
    'data: ' + JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_lookup_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"StatsSystem"}' },
          }],
        },
        finish_reason: null,
      }],
    }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]',
    '',
  ].join('\n\n');

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (requests.length === 1) {
      return new Response(firstStream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'The lookup returned StatsSystem.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 12 },
    }), { headers: { 'content-type': 'application/json' } });
  };

  const started = [];
  const completed = [];
  const streamed = [];
  const result = await runOpenAICompatibleTurn({
    baseUrl: 'http://127.0.0.1:5001/v1',
    apiKey: 'test-only',
    model: 'test-model',
    systemPrompt: 'Use tools when needed.',
    prompt: 'Find StatsSystem.',
    tools: [{
      name: 'lookup',
      description: 'Look up a game API type.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }],
    executeTool: async (name, args) => {
      assert.equal(name, 'lookup');
      assert.deepEqual(args, { query: 'StatsSystem' });
      return 'StatsSystem has the requested declaration.';
    },
    onToolStart: (event) => started.push(event),
    onToolDone: (event) => completed.push(event),
    onText: (text) => streamed.push(text),
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:5001/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, 'Bearer test-only');
  assert.equal(requests[1].body.messages.at(-2).role, 'assistant');
  assert.equal(requests[1].body.messages.at(-2).tool_calls[0].id, 'call_lookup_1');
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'call_lookup_1');
  assert.match(requests[1].body.messages.at(-1).content, /requested declaration/);
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].error, false);
  assert.equal(streamed.join(''), 'The lookup returned StatsSystem.');
  assert.equal(result.messages.at(-1).content, 'The lookup returned StatsSystem.');
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 12 });
});

test('invalid tool arguments are returned as tool errors rather than executed', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response([
        'data: ' + JSON.stringify({
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'bad_call', type: 'function', function: { name: 'lookup', arguments: '{not-json' } }] },
            finish_reason: 'tool_calls',
          }],
        }),
        'data: [DONE]',
        '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'The tool arguments were invalid.' } }],
    }), { headers: { 'content-type': 'application/json' } });
  };

  let executed = false;
  const result = await runOpenAICompatibleTurn({
    baseUrl: 'http://localhost:5001/v1',
    model: 'test-model',
    prompt: 'Look something up.',
    tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }],
    executeTool: async () => { executed = true; return 'should not run'; },
  });
  assert.equal(executed, false);
  assert.match(result.messages.at(-2).content, /Invalid tool arguments/);
});
