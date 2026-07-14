---
description: Interactively set up the model council — pick subscription tiers and auto-populate members.
---

Help the user set up the model council interactively.

1. Call the `council_status` tool first to detect their environment (local Ollama models, cloud reachability, whether the Claude and Codex CLIs are installed and logged in) and see the current council + tiers.

2. For each subscription they might want to change, use an interactive selectable menu (AskUserQuestion) so they can pick with arrow keys — only ask about ones that are relevant (e.g. don't push a Claude tier if the Claude CLI isn't installed):
   - **Claude**: `free` · `pro` · `max5x` · `max20x`
   - **ChatGPT**: `free` · `plus` · `pro5x` · `pro20x`
   - **Ollama**: `free` · `pro` · `max`
   Free = no cloud/subscription members for that provider. Higher tiers raise that provider's concurrency limit.

3. Call `setup_council` with the chosen tiers. Then show the user:
   - the resulting council members (grouped by provider) and the total count,
   - the quota warning (these members use their own subscription quotas),
   - any hints from `council_status` (e.g. "Codex CLI installed but not signed in — run `codex login`"),
   - and that a `/reload-plugins` is needed for concurrency / newly-enabled providers to take full effect.

Keep it friendly and concise. If they want to trim the council, remind them `configure_council` can remove members and the change persists.
