<p align="center">
  <img src="docs/assets/brand/banner.png" alt="REDagent: writes, runs and fixes REDnode mods with you, while you play. Powered by Claude. Runtime REDnode, model Claude Opus and Sonnet, changes shown as a diff with allow and undo." width="100%">
</p>

<p align="center">
  <a href="https://edgemodders.github.io/REDagent/"><img src="docs/assets/brand/badges/docs.svg" alt="docs: read the docs"></a>
  <img src="docs/assets/brand/badges/status.svg" alt="status: C4 passed">
  <a href="https://github.com/Edgemodders/REDnode"><img src="docs/assets/brand/badges/rednode.svg" alt="runs in: REDnode"></a>
  <img src="docs/assets/brand/badges/claude.svg" alt="powered by: Claude">
  <a href="LICENSE"><img src="docs/assets/brand/badges/license.svg" alt="license: MIT"></a>
</p>

An assistant inside Cyberpunk 2077 that writes, runs, checks and fixes [REDnode](https://github.com/Edgemodders/REDnode) mods and overlay apps with you, while you play. Claude remains the default provider; this fork adds an experimental OpenAI-compatible provider for local or hosted models.

You ask, in a chat window in the game: "make me a mod that warns me when my health drops below 30%". REDagent writes the mod, REDnode's hot reload runs it, REDagent reads the mod's log and checks the game's answers through REDnode's game API, and fixes what is wrong. Every change to a file is shown to you first as a diff, and can be undone.

**[Read the guide](docs/guide.md)** &middot; [Docs source](docs/) &middot; [Design](docs/design.md) &middot; [REDnode](https://github.com/Edgemodders/REDnode) &middot; [REDcode](https://github.com/Edgemodders/REDcode)

> [!NOTE]
> **Baseline:** the upstream Claude-powered features were tested by the original project author. The OpenAI-compatible provider and retrieval additions in this fork are experimental and still need an in-game test. See [docs/design.md](docs/design.md).

## Install (developers)

1. Deploy [REDnode](https://github.com/Edgemodders/REDnode) to the game.
2. `cd redagent && npm install`
3. `.\tools\deploy.ps1 -GameDir '<your Cyberpunk 2077 folder>'`
4. In the game, allow REDagent to use REDnode's tools in the REDnode launcher. By default, enter your Anthropic API key. To use another backend, click **Provider** and configure the OpenAI-compatible endpoint first.

`node tools/check-key.mjs` checks a key outside the game. `.\tools\brand\render.ps1` renders the banner, icon and badges.

| You need | Why |
|---|---|
| Cyberpunk 2077 on PC with REDnode | REDagent is a REDnode package |
| A model provider | Claude uses your own Anthropic API key. This fork can instead connect to an OpenAI-compatible chat-completions endpoint. |


## OpenAI-compatible models (experimental in this fork)

In the in-game REDagent window, click **Provider** and select **OpenAI-compatible API (local or hosted)**.

- **API base URL:** for a typical local KoboldCpp OpenAI-compatible server, try `http://127.0.0.1:5001/v1` if that is the port you configured. Use the exact base URL exposed by your inference server.
- **Model name:** use the model ID that the server expects. REDagent does not discover the model ID automatically.
- **API key:** optional for local servers; when entered, REDnode stores it encrypted. Saving with the field blank clears a previously saved local-provider key. Non-local endpoints must use HTTPS.
- **Tools:** the local agent uses chat-completions function calling and REDnode's MCP tools. The selected model and server must support tool calling correctly.
- **Project knowledge:** each turn retrieves relevant bundled REDnode guidance and existing mod source into the prompt. This is temporary retrieved context, not automatic model training.
- **Limitations:** screenshot/vision tools are not forwarded in this provider path. Other mods' budget-limited `agent.ask` questions are disabled while this provider is selected because this endpoint does not provide a dependable dollar-cost measure. Dollar usage is not displayed for local-provider turns.

The provider has unit tests for the HTTP/tool loop and retrieval, but has **not yet been verified in-game or against every OpenAI-compatible server**. Start with a read-only prompt, then test a tiny mod and confirm that a real REDnode tool call works before trusting it for code changes.

The configured endpoint receives prompts, retrieved documentation/source excerpts, and results from any REDnode tools the model calls. Only configure an endpoint you trust.

Not affiliated with CD Projekt RED or Anthropic.
