---
description: Show the model council's detected environment, members, tiers, concurrency, and quota.
---

Call the `council_status` tool and present the result clearly and concisely:

- **Detected environment**: local Ollama models + whether Ollama cloud is reachable on this plan; whether the Claude and Codex CLIs are installed **and logged in**.
- **Council**: the current members grouped by provider (local Ollama / Ollama cloud / Claude / Codex), with the total count.
- **Tiers & concurrency**: the resolved subscription tiers and the per-provider concurrency limits. If `reloadPending` is true, note that a `/reload-plugins` is needed to apply a recent tier change.
- **Quota**: surface the quota warning verbatim — these members run under the user's own subscription quotas.
- **Hints**: relay any hints (e.g. how to log a CLI in) so the user can fix anything not usable.

Do not call any other tool unless the user asks to change something (then point them at `/model-council:setup` or `configure_council`).

**Write model IDs in full and verbatim as they appear in `council_status`** — the Codex members are `gpt-5.6-sol`, `gpt-5.6-luna`, and `gpt-5.6-terra`; never abbreviate them to `sol` / `luna` / `terra`.
