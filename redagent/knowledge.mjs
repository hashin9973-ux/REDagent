// Lightweight retrieval for REDagent's local-model provider.
// This is external working memory, not model training: it selects relevant docs and
// known mod examples at each user turn. No embedding server or extra dependency is needed.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.html', '.css', '.json', '.yaml', '.yml', '.toml', '.lua', '.reds',
]);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.cache', 'backups', 'chats', 'sdk', 'coverage',
  'dist', 'build', '.next', '.idea', '.vscode', 'secrets', 'saves', 'logs',
]);
const MAX_FILE_BYTES = 100_000;
const MAX_INDEX_FILES = 250;
const MAX_INDEX_CHARS = 4_000_000;
const DEFAULT_MAX_CHARS = 11_000;
const SENSITIVE_NAME = /(?:^|[._-])(secret|secrets|credential|credentials|token|password|passwd|auth|apikey|api-key|private)(?:[._-]|$)/i;
const JSON_ALLOWLIST = new Set(['rednode-app.json', 'package.json', 'tsconfig.json', 'manifest.json']);
const SENSITIVE_VALUE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)\s*["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i;
const STOP_WORDS = new Set((
  'about after again against also any are as at be because been before being below between both ' +
  'but by can could did do does doing down during each either else for from further get give had ' +
  'has have having he her here hers him his how i if in into is it its itself just like may ' +
  'me might more most must my no not now of off on once only or other our out over own same she ' +
  'should so some such than that the their them then there these they this those through to too ' +
  'under until up very was we were what when where which while who why will with would you your ' +
  'please create add change update fix implement write build use using want need mod mods code'
).split(/\s+/));

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep));
}

function readTextFile(file) {
  try {
    const name = basename(file).toLowerCase();
    if (SENSITIVE_NAME.test(name)) return null;
    if (extname(name) === '.json' && !JSON_ALLOWLIST.has(name)) return null;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) return null;
    const content = readFileSync(file, 'utf8');
    if (content.includes('\0') || SENSITIVE_VALUE.test(content)) return null;
    return content;
  } catch {
    return null;
  }
}

function gather(root, output, visited, excludeRoots, skipDirectories) {
  const start = resolve(root);
  if (!existsSync(start)) return;
  const stack = [start];
  let totalChars = output.reduce((sum, file) => sum + file.content.length, 0);
  while (stack.length && output.length < MAX_INDEX_FILES && totalChars < MAX_INDEX_CHARS) {
    const current = stack.pop();
    if (skipDirectories.some((excluded) => current === resolve(excluded))) continue;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !skipDirectories.some((excluded) => full === resolve(excluded))) stack.push(full);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext) || visited.has(full) || excludeRoots.some((excluded) => inside(excluded, full))) continue;
        visited.add(full);
        const content = readTextFile(full);
        if (content !== null) {
          output.push({ path: full, content });
          totalChars += content.length;
        }
        if (output.length >= MAX_INDEX_FILES || totalChars >= MAX_INDEX_CHARS) break;
      }
    }
  }
}

function tokens(value) {
  return String(value ?? '').toLowerCase().match(/[a-z][a-z0-9_]{1,}/g) ?? [];
}

function rankFile(file, queryTokens, phrase) {
  const pathText = (file.path + ' ' + basename(file.path)).toLowerCase();
  const text = file.content.toLowerCase();
  let score = phrase && text.includes(phrase) ? 5 : 0;
  for (const word of new Set(queryTokens)) {
    if (pathText.includes(word)) score += 5;
    let count = 0;
    let at = -1;
    while ((at = text.indexOf(word, at + 1)) !== -1 && count < 8) count += 1;
    score += Math.min(count, 4) * 1.4;
  }
  if (/overlay-apps|gameapi|briefing/i.test(file.path)) score += 1.8;
  if (/rednode-app\.json$/i.test(file.path)) score += 0.4;
  if (/test|fixture|mock/i.test(file.path)) score -= 0.8;
  return score;
}

function relevantExcerpt(content, queryTokens, maxLength) {
  if (content.length <= maxLength) return content;
  const text = content.toLowerCase();
  let bestAt = -1;
  let bestScore = -1;
  const unique = [...new Set(queryTokens)];
  for (const word of unique) {
    let at = -1;
    while ((at = text.indexOf(word, at + 1)) !== -1) {
      const score = unique.reduce((sum, token) => {
        const hit = text.indexOf(token, at);
        return sum + (hit >= 0 && hit < at + maxLength ? 1 : 0);
      }, 0);
      if (score > bestScore) { bestScore = score; bestAt = at; }
      if (bestAt >= 0 && at > bestAt + maxLength * 2) break;
    }
  }
  if (bestAt < 0) return content.slice(0, maxLength) + '\n[Excerpt truncated.]';
  const start = Math.max(0, bestAt - Math.floor(maxLength * 0.2));
  return (start ? '[Earlier content omitted.]\n' : '') + content.slice(start, start + maxLength) +
    (start + maxLength < content.length ? '\n[Later content omitted.]' : '');
}

/**
 * Retrieve relevant docs and existing mods with deterministic lexical ranking.
 * files are explicitly selected trusted documents; roots are searched recursively.
 * skipDirectories prunes app/runtime subtrees such as REDagent itself.
 */
export function retrieveKnowledge(query, {
  roots = [],
  files = [],
  excludeRoots = [],
  skipDirectories = [],
  maxResults = 5,
  maxChars = DEFAULT_MAX_CHARS,
  perFileChars = 3_000,
} = {}) {
  const queryTokens = tokens(query).filter((word) => !STOP_WORDS.has(word) && word.length > 2);
  if (!queryTokens.length) return '';
  const candidates = [];
  const visited = new Set();
  for (const file of files) {
    const path = resolve(file);
    if (visited.has(path) || excludeRoots.some((root) => inside(root, path))) continue;
    visited.add(path);
    const content = readTextFile(path);
    if (content !== null) candidates.push({ path, content });
  }
  for (const root of roots) gather(root, candidates, visited, excludeRoots, skipDirectories);

  const phrase = String(query ?? '').trim().toLowerCase();
  const ranked = candidates
    .map((file) => ({ ...file, score: rankFile(file, queryTokens, phrase) }))
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const out = [];
  let used = 0;
  for (const file of ranked) {
    if (out.length >= maxResults || used >= maxChars) break;
    const remaining = maxChars - used;
    const excerptSize = Math.min(perFileChars, remaining - 100);
    if (excerptSize < 300) break;
    const excerpt = relevantExcerpt(file.content, queryTokens, excerptSize);
    const item = '## ' + file.path + '\n\n' + excerpt;
    out.push(item);
    used += item.length;
  }
  return out.length ? out.join('\n\n---\n\n') : '';
}
