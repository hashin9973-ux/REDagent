// REDagent's chat window. The agent itself runs in agent.mjs, REDagent's Node
// mod; the two talk over the package channel (channel in the rednode package).
// A classic script: Chromium does not load module files from a file:// page, but
// a dynamic import of the rednode package (through the page's import map) works.
'use strict';

(async () => {
const { channel } = await import('rednode');

const $ = (id) => document.getElementById(id);
const log = $('log');
let state = { hasKey: false, busy: false };
let current = null; // the assistant message being streamed: { el, text }
const tools = new Map(); // tool use id -> line element
const changes = new Map(); // change id -> { els: its "Changed" lines, undone }
let editingKey = false;
let editingProvider = false;
let working = null; // the "WORKING..." line while a turn runs

// ---------- Markdown, small and safe: everything is escaped first ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
}

function markdown(text) {
  const out = [];
  const lines = text.split('\n');
  let list = null;
  const closeList = () => {
    if (list) out.push(list === 'ul' ? '</ul>' : '</ol>');
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('```')) {
      closeList();
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    const numbered = /^\s*\d+[.)] (.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      continue;
    }
    closeList();
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
    else if (/^\|.*\|\s*$/.test(line)) out.push(`<pre><code>${esc(line)}</code></pre>`); // tables stay readable as text
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

// ---------- the log ----------

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
function add(el) {
  const stick = atBottom();
  log.append(el);
  if (working && el !== working) log.append(working); // "working" stays last, below cards
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}
function div(className, html) {
  const el = document.createElement('div');
  el.className = className;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

// Streamed text is drawn once per animation frame. The messages to draw are
// queued themselves: a turn may end before the frame comes.
const toRender = new Set();
function renderCurrent() {
  if (!current) return;
  if (!toRender.size) {
    requestAnimationFrame(() => {
      const stick = atBottom();
      for (const msg of toRender) msg.el.innerHTML = markdown(msg.text);
      toRender.clear();
      if (stick) log.scrollTop = log.scrollHeight;
    });
  }
  toRender.add(current);
}

// While a card waits for the player, the line says so instead.
function waiting(on) {
  if (working) working.textContent = on ? 'WAITING FOR YOU...' : 'WORKING...';
}

function setWorking(on) {
  if (on && !working) working = add(div('working', 'WORKING...'));
  if (!on && working) {
    working.remove();
    working = null;
  }
  if (working) log.append(working); // keep it last
}

// ---------- views ----------

function show() {
  // Claude keeps its SDK/key onboarding; the OpenAI-compatible provider does not need it.
  const local = state.provider === 'openai-compatible';
  const needSdk = !local && !!state.sdk && state.sdk !== 'ready';
  const needProvider = editingProvider;
  const needKey = !needProvider && !needSdk && !local && (!state.hasKey || editingKey);
  $('provider-setup').hidden = !needProvider;
  $('sdk-setup').hidden = needProvider || !needSdk;
  $('setup').hidden = needProvider || needSdk || !needKey;
  $('chat').hidden = needProvider || needSdk || needKey;
  $('sdk-get').toggleAttribute('disabled', state.sdk === 'getting');
  $('sdk-get').textContent = state.sdk === 'getting' ? 'Getting...' : 'Get the Agent SDK';
  $('cancel-key').hidden = !state.hasKey;
  $('send').hidden = state.busy;
  $('stop').hidden = !state.busy;
  $('provider-status').textContent = local ? 'OPENAI-COMPATIBLE MODEL' : 'POWERED BY CLAUDE';
  $('key-button').hidden = local;
  for (const b of document.querySelectorAll('[data-model]')) {
    b.hidden = local;
    if (b.dataset.model === state.model && !local) b.removeAttribute('variant');
    else b.setAttribute('variant', 'ghost');
  }
  $('cost').textContent = local ? 'Local · usage not reported' : `Total $${(state.cost ?? 0).toFixed(3)}`;
}

function send() {
  const input = $('prompt');
  const text = (input.value ?? '').trim();
  if (!text || state.busy) return;
  input.setAttribute('value', '');
  input.value = '';
  add(div('msg user', esc(text).replace(/\n/g, '<br>')));
  channel.post({ type: 'ask', text });
}

$('send').addEventListener('click', send);
$('prompt').addEventListener('submit', send);
$('stop').addEventListener('click', () => channel.post({ type: 'stop' }));
$('new').addEventListener('click', () => {
  if (state.busy) return;
  clearChat();
  showHistory(null);
  channel.post({ type: 'new' });
});

function clearChat() {
  log.replaceChildren();
  current = null;
  working = null;
  tools.clear();
  changes.clear();
  $('changes-list').replaceChildren();
  showChanges();
}

// ---------- history: earlier chats, kept by the agent ----------

let opening = false; // the player asked for the panel: the next list opens it
$('history-button').addEventListener('click', () => {
  opening = $('history').hidden;
  if ($('history').hidden) channel.post({ type: panelTab === 'mods' ? 'mods' : 'history' });
  else showHistory(null);
});
$('history-close').addEventListener('click', () => showHistory(null));

// The panel has two tabs: earlier chats, and the mods that ask REDagent questions.
let panelTab = 'chats';
function setTab(tab) {
  panelTab = tab;
  $('tab-chats').classList.toggle('on', tab === 'chats');
  $('tab-mods').classList.toggle('on', tab === 'mods');
  channel.post({ type: tab === 'mods' ? 'mods' : 'history' });
}
$('tab-chats').addEventListener('click', () => setTab('chats'));
$('tab-mods').addEventListener('click', () => setTab('mods'));

// Mods that asked REDagent questions: what each spent today and in all, its daily
// limit, Pause, and whether its questions may use pictures of windows and the screen.
function showMods(m) {
  if (panelTab !== 'mods') return;
  $('history').hidden = false;
  $('log').hidden = true;
  $('history-button').textContent = 'Back';
  const list = $('history-list');
  list.replaceChildren();
  if (!m.mods.length) {
    list.append(div('notice', 'No mod has asked REDagent anything yet. A mod asks with agent.ask once you allow its "questions to the AI assistant" permission in the launcher or the Mod Manager.'));
  }
  for (const mod of m.mods) {
    const row = div(`mod-row${mod.paused ? ' paused' : ''}`);
    row.append(div('chat-title', esc(mod.name ?? mod.id)));
    row.append(
      div(
        `chat-meta${mod.today >= mod.limit ? ' over' : ''}`,
        `Today $${mod.today.toFixed(3)} of $${mod.limit.toFixed(2)} &middot; in all $${mod.total.toFixed(3)}${mod.paused ? ' &middot; paused' : ''}`,
      ),
    );
    const controls = div('controls');
    const limit = div('limit', 'Daily limit $');
    const field = document.createElement('input');
    field.type = 'number';
    field.min = '0';
    field.step = '0.05';
    field.value = mod.limit.toFixed(2);
    const set = document.createElement('rn-button');
    set.textContent = 'Set';
    set.setAttribute('variant', 'ghost');
    set.addEventListener('click', () => channel.post({ type: 'mod-settings', id: mod.id, limit: Number(field.value) }));
    limit.append(field, set);
    const toggle = (label, on, key) => {
      const t = document.createElement('rn-toggle');
      t.setAttribute('label', label);
      if (on) t.setAttribute('checked', '');
      t.addEventListener('change', (e) => channel.post({ type: 'mod-settings', id: mod.id, [key]: e.detail.checked }));
      return t;
    };
    controls.append(limit, toggle('Paused', mod.paused, 'paused'), toggle('Pictures', mod.pictures, 'pictures'));
    row.append(controls);
    for (const r of mod.recent.slice(0, 3)) {
      row.append(div('recent', `${new Date(r.at).toLocaleTimeString()} &middot; $${r.cost.toFixed(3)} &middot; ${esc(r.prompt)}`));
    }
    list.append(row);
  }
}

// Shows the list of chats ({ current, chats }), or hides it (null).
function showHistory(m) {
  if (m && panelTab !== 'chats') return;
  $('history').hidden = !m;
  $('log').hidden = !!m;
  $('history-button').textContent = m ? 'Back' : 'Chats';
  if (!m) return;
  const list = $('history-list');
  list.replaceChildren();
  if (!m.chats.length) list.append(div('notice', 'No chats yet.'));
  for (const c of m.chats) {
    const row = div('chat-row');
    const text = div('chat-text');
    text.append(div('chat-title', esc(c.title)));
    text.append(div('chat-meta', `${new Date(c.updated).toLocaleString()} &middot; $${(c.cost ?? 0).toFixed(3)}`));
    row.append(text);
    if (c.id === m.current) {
      row.append(div('answer', 'This chat'));
    } else {
      const open = document.createElement('rn-button');
      open.textContent = 'Open';
      open.addEventListener('click', () => {
        if (state.busy) return;
        showHistory(null);
        channel.post({ type: 'open-chat', id: c.id });
      });
      const del = document.createElement('rn-button');
      del.textContent = 'Delete';
      del.setAttribute('variant', 'ghost');
      del.addEventListener('click', () => channel.post({ type: 'delete-chat', id: c.id }));
      row.append(open, del);
    }
    list.append(row);
  }
}

// Draws a saved chat again from the agent's record of it.
function replay(events) {
  clearChat();
  for (const e of events) {
    switch (e.type) {
      case 'user':
        log.append(div('msg user', esc(e.text).replace(/\n/g, '<br>')));
        break;
      case 'text':
        if (e.text) log.append(div('msg agent', markdown(e.text)));
        break;
      case 'tool':
        handle({ type: 'tool', id: e.id, name: e.name });
        handle({ type: 'tool-input', id: e.id, input: e.input });
        if (e.error) handle({ type: 'tool-done', id: e.id, error: true });
        break;
      case 'changed':
        handle(e);
        if (e.undone) handle({ type: 'undone', id: e.id });
        break;
      case 'turn-end':
        if (e.error) log.append(div('error', esc(e.error)));
        if (e.cost > 0) log.append(costLine(e));
        break;
      default:
        handle(e); // cards (with their answers), notices, errors
        break;
    }
  }
  current = null;
  setWorking(!!state.busy);
  if (state.hasKey && state.tools && state.tools !== 'ok') add(div('notice tools', esc(`REDnode's tools are off: ${state.tools}`)));
  log.scrollTop = log.scrollHeight;
}

// What one answer cost, beside the chat's running total, so the two are not confused.
const costLine = (m) => div('turn-cost', `This answer: $${m.cost.toFixed(3)} &middot; chat total $${(m.chatCost ?? 0).toFixed(3)}`);

// The changes strip above the input: how many files this chat changed, and the list
// with Undo for each, so Undo stays in reach however far the chat scrolls.
function showChanges() {
  const all = [...changes.values()];
  const undone = all.filter((c) => c.undone).length;
  $('changes').hidden = !all.length;
  $('changes-count').textContent = `${all.length} change${all.length === 1 ? '' : 's'} in this chat${undone ? ` · ${undone} undone` : ''}`;
}
$('changes-toggle').addEventListener('click', () => {
  const list = $('changes-list');
  list.hidden = !list.hidden;
  $('changes-toggle').textContent = list.hidden ? 'Show' : 'Hide';
});

// A "Changed ..." line with Undo; one goes in the chat, one in the changes list.
function changeLine(m) {
  const el = div('changed', `<span>${m.created ? 'Created' : 'Changed'} <code>${esc(m.file)}</code></span>`);
  const undo = document.createElement('rn-button');
  undo.textContent = 'Undo';
  undo.setAttribute('variant', 'ghost');
  undo.addEventListener('click', () => channel.post({ type: 'undo', id: m.id }));
  el.append(undo);
  return el;
}
for (const b of document.querySelectorAll('[data-model]')) {
  b.addEventListener('click', () => channel.post({ type: 'model', model: b.dataset.model }));
}
function openProviderSettings() {
  editingProvider = true;
  $('provider-choice').value = state.provider ?? 'anthropic';
  $('local-base-url').value = state.baseUrl || 'http://127.0.0.1:5001/v1';
  $('local-model').value = state.localModel || (state.provider === 'openai-compatible' ? state.model : 'local-model') || 'local-model';
  $('local-api-key').value = '';
  $('local-fields').hidden = $('provider-choice').value !== 'openai-compatible';
  show();
}
$('provider-button').addEventListener('click', openProviderSettings);
$('open-provider-from-key').addEventListener('click', openProviderSettings);
$('provider-choice').addEventListener('change', () => {
  $('local-fields').hidden = $('provider-choice').value !== 'openai-compatible';
});
$('save-provider').addEventListener('click', () => {
  const provider = $('provider-choice').value;
  const baseUrl = $('local-base-url').value.trim();
  const localModel = $('local-model').value.trim();
  const apiKey = $('local-api-key').value;
  if (provider === 'openai-compatible' && (!baseUrl || !localModel)) {
    add(div('error', 'Enter the API base URL and model name.'));
    return;
  }
  $('local-api-key').value = '';
  channel.post({ type: 'save-provider', provider, baseUrl, localModel, apiKey });
});
$('cancel-provider').addEventListener('click', () => {
  editingProvider = false;
  show();
});
$('key-button').addEventListener('click', () => {
  editingKey = true;
  show();
});
$('cancel-key').addEventListener('click', () => {
  editingKey = false;
  show();
});
$('sdk-get').addEventListener('click', () => {
  if (state.sdk === 'getting') return;
  $('sdk-progress').textContent = 'Starting...';
  $('sdk-progress').classList.remove('error');
  channel.post({ type: 'sdk-get' });
});
$('save-key').addEventListener('click', () => {
  const field = $('key');
  const key = (field.value ?? '').trim();
  field.setAttribute('value', '');
  field.value = '';
  if (!key) return;
  editingKey = false;
  channel.post({ type: 'set-key', key });
});

// ---------- messages from the agent ----------

channel.on(handle);

function handle(m) {
  switch (m?.type) {
    case 'restore':
      replay(m.events ?? []);
      break;
    case 'history':
      showHistory(m);
      break;
    case 'mods':
      // Sent after every answer too: shown only while the panel is open, or when asked for.
      if (panelTab === 'mods' && (opening || !$('history').hidden)) showMods(m);
      opening = false;
      break;
    case 'sdk-progress': {
      const mb = (n) => (n / 1e6).toFixed(0);
      const done = m.total && m.received >= m.total;
      $('sdk-progress').textContent = done
        ? `Part ${m.part} of ${m.of}: unpacking...`
        : `Part ${m.part} of ${m.of}: ${mb(m.received)}${m.total ? ` of ${mb(m.total)}` : ''} MB`;
      break;
    }
    case 'sdk-error':
      $('sdk-progress').textContent = `Could not get it: ${m.text}. Check your connection and try again.`;
      $('sdk-progress').classList.add('error');
      break;
    case 'status':
      state = m;
      show();
      if (m.hasKey && m.tools !== 'ok' && !log.querySelector('.notice.tools')) {
        add(div('notice tools', esc(`REDnode's tools are off: ${m.tools}`)));
      }
      break;
    case 'provider-saved':
      editingProvider = false;
      show();
      break;
    case 'turn-start':
      state.busy = true;
      current = null;
      show();
      setWorking(true);
      break;
    case 'text-start':
      current = { el: add(div('msg agent')), text: '' };
      setWorking(true);
      break;
    case 'delta':
      if (!current) current = { el: add(div('msg agent')), text: '' };
      current.text += m.text;
      renderCurrent();
      break;
    case 'tool': {
      current = null;
      const el = add(div('tool', `&#9656; <span class="name">${esc(m.name)}</span> <span class="args"></span>`));
      tools.set(m.id, el);
      setWorking(true);
      break;
    }
    case 'tool-input': {
      const el = tools.get(m.id);
      if (el) el.querySelector('.args').textContent = m.input === '{}' ? '' : m.input;
      break;
    }
    case 'tool-done': {
      const el = tools.get(m.id);
      if (el && m.error) el.classList.add('error');
      break;
    }
    case 'confirm': {
      const card = add(div('confirm', `<div>REDagent wants to <code>${esc(m.text)}</code></div>`));
      const row = div('row');
      const allow = document.createElement('rn-button');
      allow.textContent = 'Allow';
      const deny = document.createElement('rn-button');
      deny.textContent = 'Deny';
      deny.setAttribute('variant', 'ghost');
      const answer = (yes) => {
        channel.post({ type: 'confirm', id: m.id, allow: yes });
        row.replaceWith(div('answer', yes ? 'Allowed' : 'Denied'));
        waiting(false);
      };
      allow.addEventListener('click', () => answer(true));
      deny.addEventListener('click', () => answer(false));
      row.append(allow, deny);
      card.append(m.answer ? div('answer', esc(m.answer)) : row);
      waiting(!m.answer);
      break;
    }
    case 'change': {
      // A change to a file, as a diff: the player allows it, allows every change in
      // this chat, or denies it.
      const what = m.created ? 'create' : 'change';
      const count = m.diff ? ` <span class="counts"><span class="add">+${m.added}</span> <span class="del">-${m.removed}</span></span>` : '';
      const card = add(div('confirm change', `<div>REDagent wants to ${what} <code>${esc(m.file)}</code>${count}</div>`));
      if (m.diff) {
        const pre = document.createElement('pre');
        pre.className = 'diff';
        for (const l of m.diff) {
          const line = document.createElement('span');
          line.className = { '+': 'add', '-': 'del', '@': 'skip' }[l.t] ?? '';
          line.textContent = `${l.t === '@' ? '' : l.t} ${l.text}\n`;
          pre.append(line);
        }
        if (m.more) pre.append(Object.assign(document.createElement('span'), { className: 'skip', textContent: `... ${m.more} more lines\n` }));
        if (m.diff.length > 24) {
          pre.classList.add('folded');
          const more = div('unfold', 'Show all');
          more.addEventListener('click', () => {
            pre.classList.toggle('folded');
            more.textContent = pre.classList.contains('folded') ? 'Show all' : 'Show less';
          });
          card.append(pre, more);
        } else {
          card.append(pre);
        }
      } else {
        card.append(div('answer', 'The change could not be previewed; the edit tool will report whether it applies.'));
      }
      const row = div('row');
      const button = (label, answerWith, ghost) => {
        const b = document.createElement('rn-button');
        b.textContent = label;
        if (ghost) b.setAttribute('variant', 'ghost');
        b.addEventListener('click', () => {
          channel.post({ type: 'confirm', id: m.id, allow: answerWith });
          row.replaceWith(div('answer', answerWith === 'all' ? 'Allowed, with every change in this chat' : answerWith ? 'Allowed' : 'Denied'));
          waiting(false);
        });
        return b;
      };
      row.append(button('Allow', true), button('Allow all in this chat', 'all', true), button('Deny', false, true));
      card.append(m.answer ? div('answer', esc(m.answer)) : row);
      waiting(!m.answer);
      break;
    }
    case 'changed': {
      // A change was written: offer Undo, in the chat and in the changes list.
      const inChat = add(changeLine(m));
      const inList = changeLine(m);
      $('changes-list').prepend(inList);
      changes.set(m.id, { els: [inChat, inList], undone: false });
      showChanges();
      break;
    }
    case 'undone': {
      const c = changes.get(m.id);
      if (c) {
        c.undone = true;
        for (const el of c.els) {
          el.querySelector('rn-button')?.remove();
          el.append(Object.assign(document.createElement('span'), { className: 'answer', textContent: 'Undone' }));
        }
        showChanges();
      }
      break;
    }
    case 'turn-end':
      current = null;
      setWorking(false);
      if (m.error) add(div('error', esc(m.error)));
      if (m.cost > 0) add(costLine(m));
      state.busy = false;
      state.cost = m.chatCost;
      show();
      break;
    case 'notice':
      add(div('notice', esc(m.text)));
      break;
    case 'error':
      add(div('error', esc(m.text)));
      break;
    default:
      break;
  }
}

channel.post({ type: 'hello' });
})();
