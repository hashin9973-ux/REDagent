# Changelog

What changed in each REDagent release, for players. Each release takes its notes from its section here: the GitHub release and the version's changelog on the Nexus Mods page.

How to keep it (the Edgemodders convention):

- With each change a player would notice, add a line under **Unreleased**, in its group: **New**, **Changed**, **Fixed** or **Other**. One change per line.
- Before a release, rename **Unreleased** to `## <version> (<date>)` and start a new empty **Unreleased** above it.
- Links are full URLs, since the same text goes to GitHub and Nexus.

## Unreleased

**New**

- An experimental OpenAI-compatible provider for local or hosted chat-completions servers, selectable in the in-game **Provider** panel.
- A separate local agent loop with streaming replies, function/tool calling and REDnode MCP tools, without using the Claude Agent SDK for player chat.
- Retrieves relevant REDnode guidance and existing mod examples into the current prompt instead of trying to fit the whole ecosystem in every request.
- Adds CI syntax checks and unit tests for streaming/tool calls, the REDnode MCP client and knowledge retrieval.

**Changed**

- The local provider uses its own base URL, model ID and optional encrypted API key. Non-local endpoints must use HTTPS.
- Local file tools reject symlink traversal, keep reads/writes inside REDnode apps folders, and continue to require reviewed diffs before writes.

**Other**

- The local provider is experimental and still needs a real in-game test against the selected inference server. Screenshot/vision tools are not forwarded, and other mods' dollar-budgeted `agent.ask` requests are disabled in this mode because cost limits cannot be reliably enforced.


## 0.3.0 (2026-10-23)

The first release, for game version 2.31. REDagent is an assistant inside Cyberpunk 2077, powered by Claude, that writes, runs, checks and fixes REDnode mods with you while you play. It uses your own Anthropic API key.

**New**

- A chat window over the game, with Opus 5.5 or Sonnet 5.5 and a cost meter.
- Reads REDnode's Mod log, the game's state, overlay windows and their console, TweakDB and the game itself, through REDnode's tools.
- Writes and edits REDnode mods in the apps folders, showing each change as a diff for you to allow or deny, with a backup and Undo.
- Takes a picture of the game's screen when it needs to see it.
- Swaps changed archives into the running game, after asking you.
- Chats are kept across game starts, with their Undo.
- Other mods can ask REDagent questions (`agent.ask`), once you allow them, within a daily spending limit per mod.
- Asks you before every call that could change your game, and before every archive swap. Reads of quest facts and the journal (REDnode's `game_facts` and `game_journal`) do not ask.
- Gets Anthropic's Claude Agent SDK, which it runs on, at first start: press **Get the Agent SDK** in its window. It downloads about 140 MB from Anthropic's own packages on npm into REDagent's data folder, checked against npm's integrity hashes, so the download of REDagent itself stays small.
- For game version 2.31 only, like REDnode. Needs REDnode 0.32.1 or later.
