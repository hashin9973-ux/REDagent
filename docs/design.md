# REDagent design

REDagent is an assistant inside Cyberpunk 2077 that writes, runs, checks and fixes [REDnode](https://github.com/Edgemodders/REDnode) mods and overlay apps with the player, while they play. It works through the REDnode runtime (the "kernel") that mods use: the game API, the mod log, the apps, the overlay windows. Powered by Claude.

Status: **C1, the kernel MCP server, passed in game on 2026-10-12** (in the REDnode repo, [docs](https://edgemodders.github.io/REDnode/mcp.html)). **C2, the chat in the game, passed in game on 2026-10-12.** **C3, authoring, passed in game on 2026-10-12**, and its fixes, Undo included, passed a second test the same day (results below). **C4, polish, passed in game on 2026-10-13** (results below). O8 Mod Manager in REDnode passed too. **C5, the agent API for mods, passed in game on 2026-10-13** (results below). Next: C6, REDagent in REDcode, agreed with the user.

## What it can do

| Step | How | REDnode piece it relies on |
|---|---|---|
| Author a mod | Writes `rednode-app.json` and `mod.mjs`, or an HTML app, into the apps folder | Packages and manifests (overlay O3, O6a) |
| Run it | The host picks up a new package; hot reload restarts a changed one in about a second | Hot reload (O6a) |
| See what happened | Reads the mod log: everything a mod printed, crashes cut down to the line in the mod's own file | Mod log (O6a) |
| Check against the game | Calls the game itself, for example to read V's money after a change | `api`, the generic game API (O6b) |
| Know the game | Looks up game types, functions and REDnode's notes | Generated game API types and the game API reference |
| See a window | Reads an overlay window's text, or looks at its image | The host's off-screen pages |
| Fix and repeat | Edits the file; hot reload runs it again | Hot reload |

| Not yet | Why |
|---|---|
| Tier 1 interceptors, declarative rules | Not built in REDnode yet (phases P4 and P3) |
| Reacting to arbitrary game events | Only `OnGameAttached` and UI state today; hooking game functions is REDnode P2 work |
| Live-editing redscript, CET Lua or archive mods | It can edit those files, but the game loads them only at start |
| Seeing the game screen, pressing keys | It sees overlay windows, not the game's final frame. A frame capture needs native work (phase C4) |
| Rebuilding REDnode's native plugin | Needs a game restart |

## Facts that shape the design

From Anthropic's Agent SDK docs, checked 2026-10-12:

| Fact | Effect |
|---|---|
| "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." | Each player enters their own Anthropic API key and pays per use. No key ships with the mod |
| Use of the Agent SDK is governed by Anthropic's Commercial Terms, including in products for end users | It can ship inside a mod |
| A product must keep its own branding and "not appear to be Claude Code or any Anthropic product"; "{YourAgentName} Powered by Claude" is allowed | The product is **REDagent**, "powered by Claude" |
| The TypeScript Agent SDK runs a bundled native Claude Code binary as a separate process; `pathToClaudeCodeExecutable` and `spawnClaudeCodeProcess` control how it starts | Should work from a REDnode mod process. Electron is not covered by the docs: **unverified**, settled by a spike in C2 |
| Custom tools in process (`createSdkMcpServer`, `tool`), MCP servers over HTTP, `PreToolUse` hooks that block a tool before any other check, `disallowedTools`, `settingSources: []`, a custom system prompt, streaming with `includePartialMessages` | Everything the design needs is supported |

## Pieces

| Piece | Repo | What it is |
|---|---|---|
| Kernel MCP server | REDnode | The overlay host serves REDnode's tools over MCP on localhost, protected by a token. One server, two clients: REDagent in the game, and Claude Code on the desktop |
| Package permissions | REDnode | A package asks for powers in its manifest, for example `"permissions": ["logs", "apps", "capture", "files"]`. The player grants them once in the launcher. Today only apps built into the host have them |
| REDagent package | REDagent | A REDnode package: a chat window (overlay app) and the agent (a Node mod in its own process), the briefing, and the settings for the key and the model |

## The agent

The **Claude Agent SDK**, chosen 2026-10-12 after a spike. REDagent is an optional add-on: players of REDnode mods do not need it, so its size is acceptable.

| Spike, 2026-10-12 (SDK 0.3.296) | Result |
|---|---|
| Runs inside a REDnode mod process (Electron utility process, Windows) | Yes: `claude.exe` starts in about 0.5 s |
| Uses the kernel MCP server | Yes: all 9 REDnode tools, beside Claude Code's own |
| Uses an API key | Yes, confirmed with a real key on 2026-10-12, once the key is approved in Claude Code's config: `.claude.json` in the config folder, `customApiKeyResponses.approved` with the key's last 20 characters. Without that it answers "Not logged in" and sends nothing. Shown with a stand-in for Anthropic's API that recorded the key in the `x-api-key` header |
| Size | 282 MB installed; `claude.exe` is 249 MB |
| Files | `claude.exe` writes config, sessions and telemetry into `CLAUDE_CONFIG_DIR`. Inside a package folder that set off REDnode's hot reload in a loop, so the config folder must be outside the apps folder |
| A refused key | Claude Code retries for a long time; REDagent stops after 30 s and says why |

Always set for `claude.exe`: `CLAUDE_CONFIG_DIR` to REDagent's own folder (never the player's Claude Code login), `ANTHROPIC_API_KEY` from REDagent's settings, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and no `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`. `tools/check-key.mjs` checks a key outside the game the same way.

### What C2 needs from REDnode

| Need | Why |
|---|---|
| A private data folder per package, outside the apps folder | `claude.exe`'s config and sessions, chat history |
| Hot reload that ignores dot folders | A package's own tools may write there |
| Secrets per package, encrypted with Electron's `safeStorage` (main process only) | The player's API key |
| MCP access for a package, with its own token | REDagent's agent uses the kernel's tools even when the external MCP switch is off |
| Several apps folders for developers | Running REDagent from its repo beside REDnode's apps |

| | Agent SDK | Claude API with our own tools |
|---|---|---|
| File reading, editing, searching | Built in | We write them |
| Long chats (context management), sessions | Built in | We build them |
| Permissions and confirmations | Hooks and a permission callback | We build them |
| Size and moving parts | A native binary as a second process; size to be measured | Small, in process |
| Risk | Running inside Electron is unverified | Low |

Locked down either way:

| Rule | How |
|---|---|
| No shell | `disallowedTools: ["Bash"]` |
| Files only in the apps folder | A `PreToolUse` hook denies any read or write outside it. Hooks run before every other check |
| Every write is shown first | A diff in the chat window; nothing is written until the player confirms. Each version is backed up, for undo |
| Game changes are confirmed | `api_call` asks before a call that may change the game, such as `GiveItem` |
| Nothing from the player's PC | `settingSources: []`: no CLAUDE.md or settings from the machine |
| Its own instructions | A custom system prompt, the briefing below |
| The key | Entered once, stored encrypted with Electron's `safeStorage`, passed only to the agent process |

Model: `claude-opus-5-5` by default, `claude-sonnet-5-5` as the cheaper choice. A cost meter shows what each chat has cost.

Prompt caching is automatic: Claude Code marks the system prompt (the briefing, about 23,000 characters) and the latest messages, and the tools come before them, so each turn reads the briefing and the chat so far from the cache. Checked on 2026-10-12 with a stand-in API (three cache markers per request). A model switch, or a pause of more than about 5 minutes, writes the cache again. The mod log shows each turn's tokens read from and written to the cache.

## The briefing

A system prompt for the REDnode world. Most of it is generated from REDnode's [Overlay apps guide](https://edgemodders.github.io/REDnode/overlay-apps.html), so it stays current and the guide is tested by use.

| It covers | Source |
|---|---|
| What REDnode is: tiers, packages, manifests, hot reload, mod processes | Hand-written, in this repo |
| How to write mods and apps: `rednode`, `game`, `ui`, `api`, the UI kit | Generated from the guide |
| The game API rules: references, 64-bit values as strings, `game.instance` | Generated from the guide |
| Its tools, and when to use which | Hand-written |
| The safety rules | Hand-written |

Game types are looked up on demand with `gameapi_lookup`, not carried in the prompt: there are 15,830 classes.

## Tools

| Tool | Gives | Phase |
|---|---|---|
| `logs` | Mod output: all, one mod, errors only | C1 |
| `apps` | Installed apps and mods, their state and memory; open, close, restart | C1 |
| `game_state` | What the game shows: menus, photo mode, scenes, the main menu, the overlay mode | C1 |
| `perf` | The game's frame rate and the overlay's cost | C1 |
| `gameapi_lookup` | Game types, functions, enum members and REDnode's notes | C1 |
| `window_text`, `window_image` | An overlay window's text, or its image: the window's own pixels, before the plugin places it on screen | C1 |
| `window_console` | What an overlay window's page logged | 0.2.0 |
| `api_read` | A live game call that only reads (REDnode's rule: functions named like reads, and TweakDB records' methods). Never asks | 0.2.0 |
| `api_call` | A live game call. Asks the player before every call | C1 |
| `tweakdb` | TweakDB flats, records and ids | 0.2.0 |
| `archives_reload` | Swaps archives into the running game. Asks the player first | 0.2.0 |
| Read, search, edit, write files | In the apps folder only, with a diff and confirmation for every write, and undo | C3 |

## C2: what was built

| Piece | Where |
|---|---|
| The package | `redagent/`: `rednode-app.json` (an app and a Node mod, its own process, asks for `mcp`), `agent.mjs` (the agent), `index.html` and `chat.js` (the chat window), `briefing.md` (the hand-written briefing) |
| The briefing | `briefing.md`, then the apps folders on this PC, then REDnode's Overlay apps guide, copied by `tools/build.mjs` into `redagent/briefing/` |
| The chat | Streams Claude's text as it comes, shows each tool call, asks before `api_call` and before opening, closing or restarting a package, counts what the chat costs, and lets the player pick Opus 5.5 or Sonnet 5.5 and start a new chat |
| The key | Pasted once (Ctrl+V works in overlay windows), kept in REDnode's encrypted secrets, approved only in REDagent's own Claude Code config folder in its data folder |
| From REDnode | `pkg`, `secrets`, `kernel.mcp()` with a launcher grant, `channel` between the window and the agent, several apps folders, Ctrl shortcuts in overlay windows |
| Deploy | `tools/deploy.ps1`, after REDnode's own deploy |

Tested against a stand-in for Anthropic's API that streams like the real one: the key is saved and sent, the briefing is the system prompt, the kernel's 9 tools are offered, a `logs` call and its answer stream into the chat with Markdown, a second question continues the same chat, an `api_call` waits for **Allow** and then runs, and the cost adds up.

## C2 test

1. Close the game. Deploy REDnode (`tools\deploy-native.ps1`), then REDagent (`tools\deploy.ps1`), both with `-GameDir`.
2. Start the game and load a save. The REDagent window opens at the right, asking for a key.
3. **F10**. In the launcher, find REDagent: switch **Allowed** on for "REDnode's tools for AI agents".
4. Copy your API key, click the key field in REDagent, press **Ctrl+V**, then **Save key**. The chat appears.
5. Ask: "What's in my mod log?" It should call `logs` and summarize. Watch the cost at the bottom.
6. Ask: "What are V's health, level and money?" It should look the functions up and call the game, and ask before each call; allow them.
7. Ask: "Capture the Hello mod window and tell me what it shows."
8. Ask: "Why might the crash mod's Throw button break?" It should read `crash-mod/mod.mjs` and explain.
9. Press **Sonnet 5.5**, ask anything short, and compare the cost.
10. Press **New chat**, then quit the game.

**Result, 2026-10-12: passed.** The key was pasted with Ctrl+V and saved; the tools were allowed in the launcher; every question was answered from live tool calls (the mod log, V's health, level and money through `api_call` after **Allow**, the Hello mod window's image, the crash mod's code). Six turns, five on Opus 5.5 and one on Sonnet 5.5, cost **$0.34** in all; turns took 11 to 55 seconds. The agent process used about 116 MB.

| Finding | Notes |
|---|---|
| The cost shown was too high | The SDK's `total_cost_usd` is the running total of the session, and REDagent added the totals up. **Fixed:** the chat's cost is the latest total, a turn's cost the difference |
| A window's invisible part caught clicks (Hello mod over the Mod log's title bar) | In REDnode: the plugin now logs, for every press, which windows lie under the cursor and the transparency it sees, to find the cause in the next test |
| Request: double-click a title bar to roll the window up | Built in REDnode's UI kit, for the next test |

## C3: what was built

| Piece | Where |
|---|---|
| Write and Edit | Claude Code's own tools, added beside Read, Glob and Grep. A PreToolUse hook, which runs before anything else, denies a write outside the apps folders, in REDagent's own folder or in any `node_modules` |
| The change card | Before a write, `agent.mjs` works out the file after the change (Write: the new content; Edit: the replacement) and posts a line diff (`diff.mjs`) with 3 lines of context. Long diffs fold. The player picks **Allow**, **Allow all in this chat** or **Deny**. A denied change goes back to Claude as "the player did not allow this change" |
| Backups and Undo | Each allowed change backs the file up first, into REDagent's data folder (`backups/`). Once the tool reports success, the chat shows "Changed ..." or "Created ..." with **Undo**. Undo restores the backup, or removes a file REDagent created. The next prompt tells Claude what was undone |
| Trust | "Allow all in this chat" lasts until **New chat** |
| The briefing | Says REDagent can write, lists what it may not touch, and gives the loop: read, small change, wait for hot reload, check `apps`, `logs` and the window, fix. New packages get `"open": true` so they start at once |
| From REDnode | New packages start, and removed ones stop, without a restart (5163e89). A package skipped because its manifest names a file that does not exist yet is looked at again when any of its files changes, so writing the manifest first works. A secret that cannot be decrypted (saved under another Windows account) counts as unset instead of crashing the mod |

Tested in the mock game with the stand-in API: a new manifest shows a card with +5 lines, **Allow** writes it, REDnode skips the package until `main.mjs` exists and then starts it, **Undo** removes the file and REDnode stops the package. An Edit after a Read shows a -1/+1 card; **Allow all in this chat** applies it, **Undo** restores the backup, the next prompt carries the undo note, and the next edit runs without a card. Writes to REDagent's folder, to a `node_modules` folder and to `C:\Windows\Temp` are all denied, and no file appears.

## C3 test

Steps 1 and 2 are the same as the C2 test (deploy both, load a save, the key is already saved).

1. Close the game. Deploy REDnode, then REDagent.
2. Start the game and load a save. Check that REDagent's tools are still **Allowed** in the launcher (F10).
3. Ask: "Make a mod that shows a warning when V's health is below 30%." A card shows each new file as a diff. Press **Allow** on the first, then **Allow all in this chat**.
4. Watch REDagent check its work (`apps`, `logs`, maybe `window_text`). The new mod should appear in the launcher and run.
5. Get hurt below 30% (or ask REDagent to set V's health lower and allow that call). The warning should show.
6. Press **Undo** on one of the changes. Ask: "What did I just undo?" It should know.
7. Ask: "Fix the crash mod's Throw button." Allow the change, then press **Throw** in the crash mod. The Mod log should show no new crash.
8. Ask: "Change your own briefing to say hello." It should say it may not change its own files.
9. Press **New chat**, ask for a small change to the new mod: the card should come back (trust ends with the chat).
10. Quit the game.

**Result, 2026-10-12: passed, except Undo, which was not tried.** REDagent wrote a low-health warning mod: REDnode started the new package at once, and the mod ran and showed its warning. REDagent then fixed the crash mod (hot reload restarted it). It refused to change its own briefing, and after **New chat** the change cards came back. Prompt caching worked: after the first turn, each turn read 35,000 to 187,000 tokens from the cache and wrote at most 2,800. The 8 turns of the first chat cost **$0.50**, the whole test $0.54.

| Finding | Notes |
|---|---|
| The Undo buttons scrolled out of reach while the mod was built | **Fixed:** a strip above the input counts this chat's changes; **Show** lists them all, each with Undo. Undoing a new file also removes the folders it needed, when they are empty |
| Invisible parts of windows caught clicks (Hello mod's strip under its frame, rolled-up windows) | In REDnode, two causes. The plugin's transparency readback failed for every window whose width is not a multiple of 64, so those windows had no transparency map, and a window without one caught every click in its rectangle. **Fixed** in plugin 0.12.1; a window that has drawn nothing now lets clicks through |
| The launcher tab and REDagent were invisible until hovered or switched off and on | In REDnode: with GPU sharing, a repaint request sends no frame when the page has not changed. **Fixed:** a repaint also draws a 1-pixel, almost transparent mark for two frames. Checked in the mock |
| Closing a mod's window left no way to get it back | In REDnode: the launcher now shows "Window closed" with **Show** under the mod |
| Request: a stopwatch in the game for timing test steps | Proposed: a small built-in app whose marks are written to the log |
| Request: thin scrollbars in the theme's colors, and no sideways scrolling in the chat | **Fixed:** REDnode's UI kit styles every scrollbar on a page (6 px; grey, red or yellow by theme); the chat wraps everything to its width |

**Second test, 2026-10-12: passed.** With REDnode plugin 0.12.1: the launcher tab and REDagent showed at start; clicks passed through transparent areas and below rolled-up windows (every one of 51 presses found a transparency map); a closed Hello mod window came back with **Show**; scrollbars were thin and followed the theme; **Undo** from the changes strip restored `low-health/index.html`, and REDagent knew what was undone.

## C4: what was built

| Piece | Where |
|---|---|
| Chat history | Each chat is a file in REDagent's data folder (`chats/`): its Claude Code session, its cost, its changes (for Undo, which works after a restart too), notes for Claude such as an undo, and what the chat window showed, as compact events. It is saved half a second after each change, so a game closed mid-turn keeps the chat up to that moment. The latest chat comes back when the game starts. **Chats** in the footer lists the last 30, with Open and Delete; **New** starts another. A card left waiting when the game closed shows "Not answered". "Allow all in this chat" is never restored. A chat whose Claude session is gone starts afresh, with a notice |
| The game's screen | In REDnode (plugin 0.13.0): the MCP tool `game_image` copies the game's back buffer on the GPU, before the overlay is drawn (the game alone) or after it (`overlay: true`, what the player sees), scales it to at most 1280 pixels wide on a worker thread, and converts HDR to SDR. REDagent may use it without asking, like `window_image`; the briefing says when it is worth the cost |
| From the tests | The Test timer app in REDnode (Start, Mark, notes, all written to the log). While a card waits for the player, the chat's status line says WAITING FOR YOU instead of WORKING, and that line always stays below the newest card. The footer fits one line: **Chats**, **New**, **Key**, and the total |

Tested in the mock game with the stand-in API: a chat with a created file came back after the host restarted, with the card's answer, the cost line and Undo; Undo after the restart removed the file; **Chats** listed the chat, **New** started an empty one, and **Open** brought the first back and continued its Claude session, with the saved undo note sent on the next question. `game_image` returned the mock's frame as a JPEG, with and without the overlay. The capture's scaling, channel order, HDR conversion and base64 have unit tests in REDnode; the GPU copy itself can only be tested in the game.

## C4 test

Use the **Test timer** (F10, switch it on in the launcher): press **Start**, then **Mark** after each step. No pauses needed.

1. Close the game. Deploy REDnode, then REDagent. Start the game and load a save.
2. REDagent shows your last chat from before (the low-health one). Mark.
3. Ask: "What's on my screen right now?" It should use `game_image` and describe the scene. Mark.
4. Ask: "Look at the screen with the overlay: where is the Hello mod window, and does it cover anything?" Mark.
5. Ask for a small change, such as "Make the low-health warning say LOW HP". While the card waits, the line under it says WAITING FOR YOU. Allow it. Mark.
6. Press **Chats**: the list shows your chats. Press **New**, ask something short, then **Chats** and **Open** the earlier chat. Ask: "What did we change last?" It should know. Mark.
7. Quit the game, start it again and load a save. The chat is back; press **Show** in the changes strip and **Undo** the change from step 5. Mark.
8. Optional, if your display does HDR: turn HDR on in the game's settings and repeat step 3. Colors should look about right. Mark.
9. Quit the game.

**Result, 2026-10-13: passed.** Plugin 0.13.0, 3840 x 2160, SDR. REDagent described the game's screen from `game_image`, alone and with the overlay, and placed the Hello mod window on it; the plugin logged no capture error. The change card showed WAITING FOR YOU. **Chats**, **New** and **Open** worked, and the opened chat continued its Claude session. After a restart of the game the last chat came back and **Undo** restored `low-health/index.html`. The whole test cost $0.29, with up to 136,000 tokens a turn read from the cache.

| Finding | Notes |
|---|---|
| At the first start, no earlier chat came back | Expected: chats from before C4 were never saved. From C4 on they are |
| HDR not tried | The game ran in SDR. The HDR conversion has unit tests only. **Unverified** in game |
| The Test timer was used only once | The player forgot it for the later steps; the logs' clock times were enough this time |

## C5: what was built

Decided with the user on 2026-10-13: a $0.25 daily limit per mod by default, Sonnet 5.5 for mod questions, and every read-only tool, with pictures of windows and the screen behind a switch per mod that starts off.

| Piece | Where |
|---|---|
| Asking | In REDnode's `rednode` package: `agent.ask(prompt, { context, onText, signal })` resolves with `{ text, cost }`, streaming pieces to `onText`. Works in Node mods and overlay apps. The package needs `"permissions": ["agent"]`, allowed by the player in the launcher or the Mod Manager |
| The broker | REDnode's host checks the permission and passes the question to the package that `"provides": ["agent"]` and has called `agent.serve`, then streams the answer back to the asker. A question unanswered after 5 minutes fails |
| Answering | REDagent's manifest provides `agent`. Questions run one at a time, apart from the player's chat, on Sonnet 5.5, with a short briefing of their own, at most 8 turns, and read-only tools: Read, Glob, Grep, the kernel's read-only tools and `apps` list. Never Write, Edit, `api_call` or package changes. `window_image` and `game_image` only with the mod's Pictures switch on |
| Limits | `mods.json` in REDagent's data folder: per mod, the daily limit, Paused, Pictures, spending today and in all, and the last 5 questions. The day is the player's local day. A paused mod, or one past its limit, is refused with the reason |
| Mods view | **Chats** in the footer now opens a panel with two tabs, Chats and **Mods**. Mods lists each mod that asked: today's spending against its limit (red when reached), in all, a limit field with **Set**, **Paused** and **Pictures** switches, and its last questions |
| Sample | REDnode's Ask mod: type a question, the answer streams in, with its cost |

Tested in the mock game with the stand-in API: the Ask mod's question went through the host to REDagent and the answer streamed back with its cost and the mod's context; the stand-in saw Sonnet 5.5 and the read-only file tools. A mod without the permission was refused, and so was one past its daily limit. The Mods view showed the spending, the limit and the last question. Also found: Claude Code cannot start when the first apps folder does not exist; REDagent now creates it.

## C5 test

Use the **Test timer**: Start, then Mark after each step.

1. Close the game. Deploy REDnode, then REDagent. Start the game and load a save.
2. F10, open the **Mod Manager**, find **Ask mod**: switch it on, and allow "questions to the AI assistant" in its details. Mark.
3. In the Ask mod window, ask: "Where am I, and what's a good thing to do nearby?" The answer streams in, with its cost. Mark.
4. Ask: "Is anything wrong in my mod log?" It should read the log. Mark.
5. In REDagent, press **Chats**, then the **Mods** tab: Ask mod shows today's spending, its limit and both questions. Mark.
6. Set its daily limit to 0.01 and press **Set**, then ask the Ask mod anything: it should be refused with the reason. Set the limit back to 0.25. Mark.
7. Switch **Paused** on and ask again: refused. Switch it off. Mark.
8. Switch **Pictures** on and ask: "What's on my screen?" It may use a picture now. Mark.
9. In the Mod Manager, withdraw Ask mod's permission and ask again: refused. Quit the game.

**Result, 2026-10-13: passed.** REDnode plugin 0.14.1. The Ask mod's questions were answered through REDagent on Sonnet 5.5 for $0.008 to $0.02 each, streaming into its window; "Is anything wrong in my mod log?" read the log. The Mods view showed the spending, the limit and the questions. A limit of $0.01 refused the next question with the reason, Paused refused it, and so did the withdrawn permission. With Pictures on, "What's on my screen?" was answered. The Test timer marked all 9 steps.

| Finding | Notes |
|---|---|
| The Ask mod window was too short, and long answers ran off its bottom with no scroll bar | In REDnode: the page that draws mod windows set `rn-window` to `display: block`, which broke its flex layout, so the window's body could not scroll. **Fixed:** every mod window now scrolls when its content is taller than the window; the Ask mod window is taller (420 x 520) |

## 0.2.0: catching up with REDnode

Agreed with the user on 2026-10-22, before the first release (GitHub and Nexus). REDagent had not changed since C5 (REDnode 0.14.1), and REDnode had moved on to 0.26.16.

| Change | Why |
|---|---|
| `api_read`, `tweakdb` and `window_console` run without asking | REDagent's own check refused every tool it did not know ("REDagent cannot use X in this version"), so REDnode's newer tools were blocked. `api_read` is REDnode 0.26.16's read-only game call |
| `archives_reload` asks the player with a card naming the archives | It swaps archives into the running game; a broken one can crash it |
| The briefing tells the model to read through `api_read` and use `api_call` only for changes; mods' questions read through `api_read` too | `api_call` now asks before every call |
| The briefing's copy of REDnode's overlay apps guide is taken again (`tools/build.mjs`) | The copy was from 2026-10-13: no World API, TweakDB, sound, archives or `ui.list` |
| The manifest's `requires: { "rednode": ">=0.26.16" }` | REDnode refuses to start REDagent on an older REDnode, and says why |
| Claude Agent SDK 0.3.296 to 0.3.308 | Current |

**REDnode's ask flag in the Agent SDK** (checked locally on 2026-10-22, SDK 0.3.308): REDnode 0.26.16 gives `api_call` and `archives_reload` `_meta: { "anthropic/requiresUserInteraction": true }`. A run of the SDK with REDagent's options against REDnode's MCP server, a stand-in game and a stand-in API that called `api_read`, `api_call` and `archives_reload` in turn:

| Run | Seen |
|---|---|
| REDagent's options | `canUseTool` was asked for all three; the allowed calls reached the game, the denied swap came back to the model as "The player said no." |
| `api_call` and `archives_reload` also in `allowedTools`, as an "always allow" rule would put them | The SDK warned that `allowedTools` would skip `canUseTool`, but for these two it still asked `canUseTool`: the flag overrides allow rules |

So REDagent's card is always shown for a flagged tool. The check script stays in the dev PC's scratchpad.

### 0.2.0 test

On the laptop or the dev PC, with REDnode 0.26.16 and REDagent 0.2.0. Use the **Test timer**: Start, then Mark after each step.

1. Start the game and load a save. **F10**: in the launcher, REDagent's "REDnode's tools for AI agents" is **Allowed**. In REDagent, the key is set. Mark.
2. Ask REDagent: "What are V's health and money, and what is V wearing on the legs?" It should answer from the game **without** a card. Mark.
3. Ask: "Give V 50 eddies." A card asks first; **Allow**. Check the money in Vitals. Mark.
4. Ask: "Swap `<full path to an archive>` into the game." A card names the archive; **Deny**. REDagent says you said no. Mark.
5. Ask: "What does TweakDB say about Items.money?" It answers without a card. Mark.
6. Ask: "Has the Welcome window's page logged any errors?" It answers without a card (`window_console`). Mark.
7. Quit the game. Send `rednode-mods.log` and the plugin log.

**Result, 2026-10-22: passed** on the laptop (REDnode 0.26.16 as an update over 0.26.15, REDagent 0.2.0 with the Agent SDK installed by `npm ci --omit=dev` on the laptop, game 2.31, 2560 x 1440). The player: everything worked as expected. The Test timer marked steps 1 to 6 between 10:31 and 10:38; the plugin log has no errors.

| Step | Turn cost (Opus 5.5) |
|---|---|
| 2, reads without a card | $0.45, the chat's first turn: 650,402 tokens read from the cache over its tool calls |
| 3, 50 eddies after a card | $0.06 |
| 4, swap denied at the card | $0.03 |
| 5, TweakDB | $0.11 |
| 6, the Welcome window's console | $0.07 and $0.03 (two turns) |

Found: installing the SDK with npm on the player's PC worked, the route proposed for the release. A first question that reads the game costs about $0.45 on Opus, mostly cache reads of the briefing across tool calls; worth showing players, and worth a look at the briefing's size before the release (unverified how much Sonnet saves here).

## 0.3.0: the first release

Agreed with the user on 2026-10-23: players fetch the Claude Agent SDK at first start. Its licence is Anthropic's (all rights reserved), so REDagent's zip never carries it.

| Change | Why |
|---|---|
| `redagent/sdk.mjs`: **Get the Agent SDK** downloads the pinned packages (`@anthropic-ai/claude-agent-sdk` and `-win32-x64`, 0.3.308) from registry.npmjs.org, checks each against npm's sha512 integrity, and unpacks them into `<dataDir>/sdk/<version>`, moving them into place only once both are whole | No redistribution of Anthropic's files; a broken or tampered download is never used. The SDK's code imports only Node's own modules, so it runs from the data folder, with `claude.exe` passed by path |
| A developer's `node_modules` with the same SDK version is used instead | A deploy from the repo needs no download |
| The window's first panel offers the download, with its progress; the key panel comes after it. Questions, and other mods' questions, are refused with a message until then | One step at a time at first start |
| REDnode 0.32's `game_facts` and `game_journal` run without asking; its quest changes keep their card | They only read |
| `requires: { "rednode": ">=0.32.1" }` | The first REDnode release with those tools and `api_read`'s fixed rule |
| `tools/release-zip.mjs`, `tools/notes.mjs`, the **Release zip** workflow | The player zip (about 60 KB, no node_modules) and its GitHub release, as REDnode's |

Checked without the game on 2026-10-23: the download (136 MB, under 3 s on the dev PC) matched npm's own install file for file; a wrong hash was refused with nothing left behind; `agent.mjs`, run from the zip's files with a stand-in for the `rednode` package, showed the SDK missing, refused a question, got the SDK, then ran a whole turn through the downloaded `claude.exe` against a stand-in API.

### 0.3.0 release test

A clean install on the laptop, from the release zips. Use the **Test timer**: Start, then Mark after each step.

Before: close the game. Delete `red4ext\plugins\REDnode\apps\redagent` in the game folder, and rename `%APPDATA%\@rednode\overlay\packages\redagent` to `redagent-old` (it keeps your chats; put it back after if you want them). Extract REDnode's `REDnode-0.32.1.zip` from its GitHub release into the game folder, then `REDagent-0.3.0.zip`.

1. Start the game and load a save. The REDagent window shows **Get the Agent SDK**. Press it: the progress counts up to about 136 MB, then the key panel appears. Mark.
2. **F10**: in the launcher, switch **Allowed** on for REDagent's "REDnode's tools for AI agents". Mark.
3. Paste your API key and press **Save key**. The chat appears. Mark.
4. Ask: "What are V's health, level and money, and which quest is tracked?" It answers from the game **without** a card. Mark.
5. Ask: "Make a small mod that shows V's money in a window." A card shows the new file; **Allow**. The window appears. Press **Undo** on the change: the window goes. Mark.
6. Quit to the desktop and start the game again. REDagent opens on the chat, with no download and no key asked for. Mark.
7. Quit the game. Send `rednode-mods.log`.

**Result, 2026-10-23: passed** on the laptop (REDnode 0.32.1 from its GitHub release, REDagent 0.3.0, game 2.31). The player: everything worked.

| Step | Seen in the log |
|---|---|
| First try | No download offered: the game folder still had 0.2.0's `node_modules`, and the log said "Claude Agent SDK 0.3.308 from node_modules". With the folder deleted and the zip extracted again, the run below |
| 1 Get the Agent SDK | "The Claude Agent SDK is not here yet", then the download: installed in 55.5 s on the laptop, loaded from REDagent's data folder |
| 4 Reads | Answered from the game with no card; the chat's first turn cost $0.26 on Opus 5.5 |
| 5 A mod | `money-window` written after its card and started; Undo removed it ($0.13) |
| 6 A new start | "Claude Agent SDK 0.3.308 from REDagent's data folder", the chat back, no key asked for |

Found: a leftover `node_modules` from a source install hides the download, by design (a developer's copy wins). Players coming from a source install should delete the folder first; the guide says what the window shows.

Each phase ends with an in-game test, as in REDnode.

| Phase | Builds | The test proves |
|---|---|---|
| **C1 Kernel MCP server** (REDnode repo) | The read-only tools on localhost with a token, and `api_call` with confirmation | From Claude Code on the desktop, while the game runs: "what's V's health?", "show the Mod log errors", "capture the Hello mod window" |
| **C2 Chat in the game** | The REDagent package: a streaming chat window built with the UI kit, key setup, model choice, cost meter. Starts with a spike: the Agent SDK inside a mod process | Questions asked in the game get answers built from live tool calls |
| **C3 Authoring** | Claude Code's Write and Edit tools, kept to the apps folders (never REDagent itself or `node_modules`); a diff card for every change with Allow, Deny and "Allow edits for this chat"; a backup of every file before it changes, with Undo; REDnode starting new packages and manifest changes without a restart; the briefing's write, hot reload, check, fix loop. No "files" permission: Node mods have full Node access, so REDnode cannot enforce one; REDagent limits itself | "Make a mod that warns me below 30% health" goes from request to a working mod in the game. "Fix the crash mod's Throw button" fixes it |
| **C4 Polish** | Chat history kept on disk and a list of earlier chats; a capture of the game's frame (native, REDnode's `game_image`); what the tests teach (the Test timer app, a "waiting for you" line). Prompt caching turned out to be automatic (C2) | A chat survives a restart of the game; REDagent describes the game's screen |
| **C5 Agent API for mods** | A `rednode` API for other mods to use REDagent, brokered by the host: for example `agent.ask(prompt, { context })`, streaming the answer back. A mod must ask for the `agent` permission, the player grants it in the launcher, and spending limits apply per mod, since every call costs the player | A sample mod asks REDagent a question and shows the answer; a mod without the permission is refused |
| **C6 REDagent in REDcode** | REDagent's agent split into a core package shared by two front ends: the in-game chat, and a REDagent view in REDcode's activity bar, beside REDnode's views. In the editor, edits show in VS Code's diff editor. The same briefing, kernel tools and settings. REDbridge's WolvenKit editing operations, exposed as MCP tools by REDbridge (being added in the REDcode session), give the same agent archive and asset work | From REDcode: "make a mod that ..." produces a working mod in the running game, with edits reviewed in VS Code |


## Fork work: OpenAI-compatible provider (experimental)

This section describes the provider implementation in the `hashin9973-ux/REDagent` fork. The original Claude provider remains the default and retains its Claude Agent SDK path.

### Pieces

| File | Role |
|---|---|
| `redagent/openai-agent.mjs` | Node built-in HTTP/SSE client for OpenAI-compatible chat completions; tool-call assembly, tool result loop, bounded per-turn output, and bounded prior-turn history |
| `redagent/local-mcp.mjs` | Calls REDnode's stateless Streamable HTTP MCP endpoint with the headers returned by `kernel.mcp()`; discovers tools and forwards read/tool results |
| `redagent/knowledge.mjs` | Lexical retrieval over bundled REDnode guidance and existing mod source. It excludes symlinks, node_modules, runtime-data folders, most JSON settings, and files that appear to contain credentials; indexing is bounded |
| `redagent/agent.mjs` | Provider selection, chat context persistence, retrieval, local read/search/write tools, and reuse of the existing approval/diff/backup/Undo path |

### Local-provider behavior

- Select **Provider → OpenAI-compatible API (local or hosted)**. Set the endpoint base URL and the exact model ID expected by the server. An API key is optional and stored through REDnode's encrypted secrets API.
- The default example base URL is `http://127.0.0.1:5001/v1`; it is a placeholder, not a claim about every KoboldCpp configuration. Non-loopback endpoints require HTTPS.
- The client accepts streamed SSE responses and ordinary JSON chat-completion responses, handles one or more function calls, and caps the loop at eight tool rounds. Prior turns and tool outputs are bounded to limit context growth.
- The local agent exposes bounded file read/search tools and tools reported by the REDnode MCP server. Existing `canUseTool` policy is reused: known mutating game calls require player confirmation, unknown tool names are denied, and file writes go through `confirmChange` with diff, backup and Undo. Reads/writes may not follow symlinks or access REDagent's own package directory.
- Each user turn performs deterministic keyword retrieval across the shipped briefing, REDnode guide and candidate mod source. Retrieved content is temporary prompt context; this is not fine-tuning and does not update model weights.
- Images are excluded from the local provider's tool list for now. The original mod-facing `agent.ask` path is refused in local mode: its per-mod controls enforce dollar-based budgets and the compatible endpoint does not reliably provide a billable dollar cost.

### Validation status

The fork adds a GitHub Actions workflow, `.github/workflows/local-provider-tests.yml`, which runs `node --check` on the touched JavaScript modules and Node's built-in test runner for the endpoint/tool loop, MCP client and retrieval. These tests use test-only fake HTTP responses; they do not prove interoperability with a live KoboldCpp server or REDnode inside Cyberpunk. **An in-game smoke test is still required before a release.**

Minimum manual smoke test:
1. Deploy REDnode 0.32.1 or later and this fork to a test game folder.
2. Open **Provider**, configure a reachable OpenAI-compatible endpoint and model ID, and save.
3. Ask a read-only question that requires `gameapi_lookup` or `logs`; confirm the tool call succeeds and the answer uses the returned result.
4. Ask it to create a tiny overlay mod. Deny one diff, then retry and allow it; verify the denied change did not occur and the allowed change has an Undo entry.
5. Introduce a harmless error in that test mod and ask REDagent to repair it; check the runtime log and hot reload rather than trusting the model's claim.
6. Confirm that mutating game tools display an approval card and that the local provider reports no dollar cost estimate.
