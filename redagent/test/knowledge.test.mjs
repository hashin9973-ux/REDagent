import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieveKnowledge } from '../knowledge.mjs';

test('retrieves relevant source snippets and respects configured limits', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redagent-knowledge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'mods', 'hud-health'), { recursive: true });
  writeFileSync(join(root, 'mods', 'hud-health', 'rednode-app.json'), JSON.stringify({ id: 'hud-health', entry: 'index.html' }));
  writeFileSync(join(root, 'mods', 'hud-health', 'main.mjs'), [
    '// Verified sample: health HUD widget',
    'export function renderHealthWidget(currentHealth, maximumHealth) {',
    '  return { percent: currentHealth / maximumHealth * 100, threshold: 30 };',
    '}',
  ].join('\n'));
  writeFileSync(join(root, 'unrelated.md'), 'A guide about unrelated crafting recipes.');
  writeFileSync(join(root, 'mods', 'hud-health', 'settings.json'), JSON.stringify({
    name: 'health HUD settings',
    apiKey: 'supersecret-test-token-value',
  }));
  writeFileSync(join(root, 'mods', 'hud-health', 'private-token.mjs'), "export const token = 'supersecret-test-token-value';");

  const result = retrieveKnowledge('create a health HUD with a threshold', {
    roots: [root],
    maxResults: 3,
    maxChars: 2_000,
    perFileChars: 1_000,
  });
  assert.match(result, /hud-health/);
  assert.match(result, /threshold/);
  assert.doesNotMatch(result, /supersecret-test-token-value/);
  assert.ok(result.length <= 2_000);
});
