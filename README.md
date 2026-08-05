# model-council-mcp

An MCP server that routes a question to a **council** of AI models — local (Ollama, vLLM, TRT-LLM, SGLang) and cloud (OpenAI, Anthropic, X.AI Grok) — and synthesizes their answers in five configurable modes:

| Mode | What you get |
|---|---|
| `individual` | Each model's raw answer, side by side |
| `categorized` | Judge groups responses into **common agreement**, **complementary insights**, and **conflicting positions** |
| `deconflicted` | Iterative loop — judge re-questions the council on each conflict until resolved or rounds exhausted; returns a **deconfliction score** (0–100 %) |
| `pooled` | **Delphi-style** — judge distils all answers into a neutral, deduplicated pool (no counts, no attribution, no ranking); members reconsider against it and answer freshly. No winner is forced, so genuine divergence is **preserved** rather than collapsed by social proof |
| `dialectic` | **Thesis → antithesis → synthesis** — members defend their initial pick and argue why the alternatives aren't better; the judge compiles a balanced **pros/cons dossier** per option; members then re-select a ranked top-3 having weighed both sides |

## Example use cases

- **High-stakes technical decision** — `ask_council(..., mode="dialectic")` to see each option argued for *and* against before a synthesized, ranked recommendation (attach the relevant file with `files=[…]`).
- **Reduce single-model bias** — `mode="pooled"` (Delphi) so a minority-but-correct answer is *preserved* instead of averaged away by the loudest model.
- **Spot disagreement fast** — `mode="categorized"` to have a judge sort answers into agreement, complementary insight, and genuine conflict.
- **Code / design review across models** — attach a file (`files=["src/auth.ts"]`) or a local diff (`git_ref="uncommitted"`) and ask the whole council to critique it; use `context` to add constraints ("must be OWASP-clean").
- **Local-only, offline second opinions** — fan a prompt across every model you already run in Ollama; no cloud, no API keys.
- **Mix your subscriptions** — put Claude (Opus/Sonnet/Haiku) and ChatGPT (via Codex) side by side on the same question, billed to plans you already pay for.
- **Long runs without blocking** — kick off a deconfliction over slow local models with `ask_council_async`, keep working, then `get_council_result(job_id)`.

---

## Install as a Claude Code plugin (recommended)

This repo is a self-contained Claude Code **plugin** — the server is bundled into a single zero-dependency file (`bundle/server.cjs`), so it runs offline against local models with no `npm install` step.

```bash
# 1. Add this repo as a marketplace (from GitHub)
/plugin marketplace add tsarihan/model-council-mcp

# 2. Install the plugin
/plugin install model-council@model-council
```

**Zero-config — it just works.** On first run the plugin **detects your environment and auto-populates the council with everything usable**: every local Ollama chat model, your top curated Ollama `:cloud` models, and — if you're logged into them — Claude (via the local `claude` CLI) and ChatGPT (via the local `codex` CLI). It tells you what it found, warns that cloud/subscription members use your own quotas, and lets you delete any you don't want. Deletions and setup **persist across reloads**. Ask a question immediately — no setup required.

- On a new session the plugin prints a one-line status (council size, Ollama up/down, which CLIs are installed).
- Run **`/model-council:status`** any time for the full readout — detected models, CLI login state, per-provider concurrency, and quota usage.
- Run **`/model-council:setup`** to pick your subscription tiers with an interactive menu.

Everything is optional and adjustable from `/plugin` → Configure. API keys are stored in your system keychain.

**Local development / test install:**

```bash
# Validate the manifest
claude plugin validate .

# Load without installing (dev loop)
claude --plugin-dir /path/to/model-council-mcp
```

### Configurable options (prompted at install)

These are all set from **`/plugin` → Configure** in Claude Code (or the equivalent env vars shown for standalone installs — e.g. `REQUEST_TIMEOUT_MS` for the timeout, `CLOUD_CONCURRENCY` for the cloud override). They persist across reloads.

| Option | Purpose | Default |
|---|---|---|
| Ollama address | Base URL of your Ollama server | `http://localhost:11434` |
| Council models | Pin specific models, or leave blank to auto-use all Ollama models | *(empty → auto)* |
| Auto-discover council | Use all Ollama chat models (local + `:cloud`) when none pinned | `true` |
| **Claude tier** | `free` / `pro` / `max5x` / `max20x` — cloud access + Claude concurrency | `pro` |
| **ChatGPT tier** | `free` / `plus` / `pro5x` / `pro20x` — Codex concurrency | `plus` |
| **Ollama tier** | `free` / `pro` / `max` — `free` = local only; `pro`/`max` = cloud + 3/10 concurrency | `pro` |
| **Grok tier** | `free` / `supergrok` / `premiumplus` / `heavy` — cloud access + Grok concurrency (defaults to `free`, opt-in) | `free` |
| Judge model | Categorizer/deconflicter, or `auto` (largest) | `auto` |
| Default response mode | `individual` / `categorized` / `deconflicted` / `pooled` / `dialectic` | `categorized` |
| Max deconfliction rounds | 1–10 | `3` |
| OpenAI / Anthropic / X.AI API key | Enable cloud models (stored in keychain) | — |
| vLLM / TRT-LLM / SGLang servers | `name:host:port` entries | — |
| Max response tokens | Tokens per completion | `16000` |
| **Default reasoning effort** | How hard every member and the judge think: `none` … `max`. Clamped per-backend; override per call with `ask_council`'s `reasoning_effort`. See [Reasoning effort](#reasoning-effort). | `high` on a new install; empty = each model's own default |
| **Per-request timeout (text)** | Wall-clock timeout (ms) for a single completion on text-only calls before the member is recorded as timed-out. Default raised to 5 min because local Ollama models run sequentially. Honoured verbatim by every provider, including the subscription CLIs (no 300s floor). Set via `REQUEST_TIMEOUT_MS`, or at runtime via the `set_council_timeouts` MCP tool. | `300000` (5 min) |
| **Per-request timeout (repo)** | Timeout used **instead** of the text timeout when `full_repo_access` is set — the CLI member Read/Grep/Globs the repo tree, materially longer. Set via `REPO_REQUEST_TIMEOUT_MS`, or at runtime via `set_council_timeouts`. | `600000` (10 min) |
| Cloud concurrency (override) | Optional; caps all cloud pools, overriding the per-tier limits | *(unset → tiers)* |
| Local concurrency | Simultaneous local requests (0 = unlimited) | `1` |
| Completion retries | Retries on an empty/failed response | `3` |

---

## Subscription tiers, auto-population & detection

The council mixes four kinds of member, each gated by a **subscription tier** so it never quietly burns quota you don't have:

| Provider | Tiers | `free` means | Reference file |
|---|---|---|---|
| **Ollama** | `free` / `pro` / `max` | local models only (no `:cloud`) | [`config/subscriptions.json`](config/subscriptions.json) |
| **Claude** (via `claude` CLI) | `free` / `pro` / `max5x` / `max20x` | no Claude members | ″ |
| **ChatGPT** (via `codex` CLI) | `free` / `plus` / `pro5x` / `pro20x` | no ChatGPT/Codex members | ″ |
| **Grok** (via `grok` CLI) | `free` / `supergrok` / `premiumplus` / `heavy` | no Grok members | ″ |

Grok defaults to `free` even when the `grok` CLI is installed and logged in — unlike Claude/ChatGPT, it's opt-in, since it's a newer provider added on top of an existing install base. Set `GROK_TIER` (or run `/model-council:setup`) to turn it on.

- **Per-provider concurrency.** Each subscription gets its own concurrency ceiling (e.g. ChatGPT 6, Claude 2, Ollama-cloud 3 on Pro / 10 on Max), so one slow, tightly-rate-limited provider can't starve another. Tier→limit mappings, curated cloud models, and provider model names all live in **`config/subscriptions.json`** — edit it and pull to pick up new plans/models.
- **Detection.** On boot (and on `council_status`) the server checks: is Ollama reachable, does your plan reach `:cloud`, is the `claude` CLI installed **and logged in** (a locked-down probe), is the `codex` CLI **signed in** (`codex login status`), is the `grok` CLI installed **and logged in** (a locked-down probe, like Claude — the CLI has no dedicated login-status subcommand). Only usable providers are auto-added; the rest get a hint (e.g. *"Codex CLI installed but not signed in — run `codex login`"*).
- **It persists.** Your tier choices, member edits, and any `configure_council` setting you set (judge model, response mode, max deconfliction rounds) are saved to `~/.config/model-council/state.json` (override with `MODEL_COUNCIL_STATE`), so they survive plugin reloads — each field only persists once you've explicitly set it at least once; an untouched field falls back to its env-var/default as before. Known limitation: writes are atomic (a torn/partial file is never observed) but not cross-process locked — two MCP server processes pointed at the *same* state file and edited at close to the same instant can each read-modify-write past the other, and whichever write lands second wins for any field only it touched. Harmless for the common case (one server process per session); if you deliberately run multiple concurrent sessions against a shared state file, prefer giving each its own `MODEL_COUNCIL_STATE`.
- **Works standalone too.** The auto-config, `council_status`, and `setup_council` tools all work for a plain `claude mcp add` / MCP-store install; only the SessionStart welcome line and the `/model-council:*` slash commands are Claude-Code-plugin-only sugar.

> Cloud and subscription members run under **your own** subscription quotas via the sanctioned first-party CLIs. `council_status` always shows a quota warning listing which paid providers are in the council. Reusing a subscription *token* against a raw vendor API from a third-party app is a separate, prohibited thing — this plugin does not do that.

---

## Install as a standalone MCP server (any MCP client)

The server is a single zero-dependency file (`bundle/server.cjs`) — **no `npm install`, no `npx`**. Clone the repo and point any MCP client at it:

```bash
git clone https://github.com/tsarihan/model-council-mcp.git
```

Then in your client's MCP config (Claude Code's `~/.claude.json` → `mcpServers`, Cursor, Cline, etc.) — point `command` at the cloned bundle:

```json
{
  "mcpServers": {
    "model-council": {
      "command": "node",
      "args": ["/absolute/path/to/model-council-mcp/bundle/server.cjs"],
      "env": {
        "OLLAMA_ADDRESS": "http://localhost:11434",
        "RESPONSE_MODE": "categorized"
      }
    }
  }
}
```

For Claude Code specifically, you can also add it directly:

```bash
claude mcp add model-council -s user -- node /absolute/path/to/model-council-mcp/bundle/server.cjs
```

---

## Configuration (environment variables)

### Provider connections

| Variable | Description | Default |
|---|---|---|
| `OLLAMA_ADDRESS` | Ollama server URL | `http://localhost:11434` |
| `OPENAI_API_KEY` | Enables OpenAI models | — |
| `ANTHROPIC_API_KEY` | Enables Anthropic Claude models | — |
| `XAI_API_KEY` | Enables X.AI Grok models | — |
| `VLLM_SERVERS` | vLLM servers (see below) | — |
| `TRTLLM_SERVERS` | TRT-LLM servers | — |
| `SGLANG_SERVERS` | SGLang servers | — |
| `CLAUDE_CLI` | `true` → add subscription-backed Claude members via the local `claude` CLI (no API key) | `false` |
| `CLAUDE_CLI_MODELS` | Model aliases for the CLI member | `opus,sonnet` |
| `CLAUDE_CLI_PATH` | Path to the `claude` binary (also used by the Ollama-harness member below) | `claude` |
| `CLAUDE_CLI_OLLAMA_MODELS` | Comma-separated **additional** Ollama model names to run through the `claude` CLI's own harness — see below. Curated `:cloud` models are routed automatically when Ollama cloud is reachable and the CLI is installed; this env var adds explicit models on top. | — |
| `CLAUDE_CLI_OLLAMA_ADDRESS` | Ollama address for the harness member, if different from `OLLAMA_ADDRESS` | `OLLAMA_ADDRESS` |
| `CODEX_CLI` | `true` → add a subscription-backed ChatGPT member via the local `codex exec` CLI (no API key) | `false` |
| `CODEX_CLI_MODELS` | Model names for the Codex member (`default` = Codex's configured model) | `default` |
| `CODEX_CLI_PATH` | Path to the `codex` binary | `codex` |
| `GROK_CLI` | `true` → add subscription-backed Grok members via the local `grok` CLI (no API key) | `false` |
| `GROK_CLI_MODELS` | Model names for the Grok CLI member | `grok-4.5` |
| `GROK_CLI_PATH` | Path to the `grok` binary | `grok` |

### Claude via your subscription (first-party CLI)

Set `CLAUDE_CLI=true` to add council members that run through the locally-installed **Claude Code CLI** (`claude -p`) instead of the Anthropic API. Inference runs under whatever your `claude` CLI is logged in with — typically your own **Claude Pro/Max subscription** — so these members don't consume API credits. They appear as `claude-cli:opus`, `claude-cli:sonnet`, etc.

**Behavior & requirements**
- The `claude` CLI must be installed and logged in (`claude` → `/login`, or `claude setup-token`). Set `CLAUDE_CLI_PATH` if it isn't on `PATH`.
- Each call shells out to `claude -p` with all tools disabled (`--tools ""`), MCP disabled (`--strict-mcp-config`, so it can't recurse into this plugin), and sessions not persisted — a clean single text answer.
- **`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are stripped from the nested call**, because the CLI silently prefers an API key over the subscription. So these members stay subscription-billed even if you also set an API key for the regular `anthropic:` provider.
- They are **not** auto-discovered — add them explicitly via `configure_council` or `COUNCIL_MODELS` (e.g. `claude-cli:opus`), so they don't quietly draw down your subscription.

**Where it works:** anywhere the `claude` CLI actually executes — the Claude Code CLI, or the Claude Desktop app on a machine that also has the CLI. With `/remote-control` on your CLI, driving it from the Claude web/mobile *code* tab still runs `claude -p` on your machine, so it works there too. It does **not** work for a remotely-hosted copy of this server (no local CLI), and it can't borrow the Claude *app's* subscription directly (no client supports MCP sampling yet).

> This uses the sanctioned first-party CLI under your own subscription, for your own use. High-volume automated fan-out can hit your subscription's rate limits — keep `CLOUD_CONCURRENCY` modest (these members use the cloud pool). Reusing a subscription *token* against the raw Anthropic API from a third-party app is a separate thing and is prohibited; this feature does not do that.

### Open-weight models with genuine repo access (Ollama via the `claude` CLI's harness)

Every other Ollama/OpenAI-compatible/API-keyed provider gets a flattened text completion with no tool use at all — `full_repo_access` (see below) only ever meant something for `claude-cli`/`codex-cli`, because they're the only members with an agentic harness to grant tools within. `CLAUDE_CLI_OLLAMA_MODELS` closes that gap for **any Ollama model** (local or `:cloud`) by reusing the exact same harness: it points the `claude` CLI's own `ANTHROPIC_BASE_URL` at Ollama's native Anthropic-Messages-API-compatible endpoint (`/v1/messages`, confirmed live to return authentically Anthropic-shaped JSON) instead of the real Anthropic API, then drives it with the identical `--tools Read,Grep,Glob --add-dir <repo>` allowlist as the real subscription CLI — same permission enforcement, same `--strict-mcp-config`, same everything, just a different backend.

```bash
CLAUDE_CLI_OLLAMA_MODELS=glm-5.2:cloud,kimi-k2.7-code:cloud,deepseek-v4-pro:cloud
```

They appear as `claude-cli/claude-cli-ollama:glm-5.2:cloud` (note the `serverId` — this is a **separate** registration from the real subscription CLI, so it never shares its id, its label, or its concurrency pool).

**Behavior & requirements**
- **These members are NOT Claude.** They're open-weight models answering through Claude Code's harness purely to get real tool use; `list_models`/`get_council_config` label them `"<model> (via claude CLI harness, <address>)"`, never `"Claude ..."` (and any basic-auth credentials in the address are redacted from that label).
- **Ambient env isolation.** Because harness mode repoints the CLI at a non-Anthropic (possibly remote) host, it strips every ambient backend-redirect/credential var from the subprocess — the `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` selectors (which otherwise *outrank* `ANTHROPIC_BASE_URL` and would send your repo to that cloud), `ANTHROPIC_CUSTOM_HEADERS`, OAuth/Foundry tokens, and provider base-url overrides — so nothing inherited from the server's environment can redirect the prompt to, or ride along as a secret to, the harness host. (The real subscription CLI leaves those selectors alone, so a legitimately Bedrock/Vertex-hosted Claude Code still works.)
- Requires the `claude` CLI installed (same binary as the real subscription CLI — no separate install) and a running Ollama server whose version serves `/v1/messages` natively (confirmed on Ollama 0.32.4; older versions may lack it).
- Concurrency is bucketed under Ollama's own pools (`ollama-cloud` for `:cloud` models, `local` otherwise) — **not** the Claude subscription's pool — so this can't starve (or be starved by) real Claude subscription members.
- **Auto-populated by default.** When Ollama cloud is reachable and the `claude` CLI is installed, curated `:cloud` models from `subscriptions.json` are automatically routed through the harness (tool access). `CLAUDE_CLI_OLLAMA_MODELS` adds explicit models on top. Existing users with persisted `ollama:*:cloud` members are migrated automatically on next boot.
- Full repo contents can be sent to whichever Ollama backend answers — a **local** Ollama model keeps this fully offline, but a `:cloud` model sends repo contents to that cloud provider the same way `full_repo_access` sends them to Claude/ChatGPT's cloud for the first-party CLIs. Don't enable `full_repo_access` on a repo containing secrets you wouldn't send to that provider.

**Where it works:** same as the real Claude CLI above — anywhere the `claude` binary actually executes.

### ChatGPT via your subscription (first-party Codex CLI)

Set `CODEX_CLI=true` to add a council member that runs through the locally-installed **Codex CLI** (`codex exec`) instead of the OpenAI API. Inference runs under whatever your `codex` CLI is signed in with — typically your own **ChatGPT subscription** (`codex login` → *Sign in with ChatGPT*) — so this member doesn't consume API credits. It appears as `codex-cli:default` (or `codex-cli:<model>`).

**Behavior & requirements**
- The `codex` CLI must be installed and signed in (`codex login`). Set `CODEX_CLI_PATH` if it isn't on `PATH`.
- Each call shells out to `codex exec` in a **read-only sandbox** (`--sandbox read-only`) with **no approval prompts** (`approval_policy=never`), run in an **empty ephemeral working dir** so the agent has nothing to explore, and reads the final answer from `-o <file>` — a clean single text answer, no file changes.
- **`OPENAI_API_KEY` / `CODEX_API_KEY` are stripped from the nested call**, because the CLI silently prefers an API key over the ChatGPT login. So this member stays subscription-billed even if you also set an API key for the regular `openai:` provider.
- Use `CODEX_CLI_MODELS=default` to let Codex pick its configured model, or name specific ones (e.g. `gpt-5-codex`). It is **not** auto-discovered — add `codex-cli:default` explicitly via `configure_council` or `COUNCIL_MODELS`.
- **Codex is a coding agent**, so answers carry a coding-agent flavor (concise, implementation-oriented) even on general questions — useful as a distinct voice in the council, but not a neutral generalist.

**Where it works:** same as the Claude CLI above — anywhere the `codex` binary actually executes (this machine, or a `/remote-control`-driven CLI running on your machine). It does **not** work for a remotely-hosted copy of this server.

> Same rules as the Claude CLI: sanctioned first-party surface under your own subscription. Reusing a subscription *token* against the raw OpenAI API from a third-party app is a separate, prohibited thing; this feature does not do that.

### Grok via your subscription (first-party Grok Build CLI)

> **⚠️ grok-cli members are currently DISABLED (v0.2.64).** grok's tool lockdown does not work: `--tools ''` is read by the CLI as *"flag unset"* and enables its full built-in tool set — including a shell — while `--permission-mode bypassPermissions` (required for headless use) auto-approves every call. This was verified live with a proof-of-execution marker, and `--tools none` was verified to fail the same way. Because a grok **judge** is fed every other member's untrusted text, a single crafted line was arbitrary command execution as your user. No replacement value has been verified yet, so the provider now fails closed with a clear error rather than shipping an unverified guard. `GROK_CLI_UNSAFE_ACCEPT_RCE=true` re-enables it for testing only.


Set `GROK_CLI=true` (or a `GROK_TIER` above `free`) to add council members that run through xAI's locally-installed **Grok Build CLI** (`grok -p` / `--prompt-json`) instead of the X.AI API. Inference runs under whatever your `grok` CLI is logged in with — typically your own **SuperGrok / X Premium+ / Heavy subscription** — so these members don't consume API credits. They appear as `grok-cli:grok-4.5` (or `grok-cli:<model>`).

**Behavior & requirements**
- The `grok` CLI must be installed and logged in. Set `GROK_CLI_PATH` if it isn't on `PATH`.
- Each call shells out to `grok` with all tools disabled (`--tools ''`) and `--permission-mode bypassPermissions` (required for headless use — without it the CLI silently cancels the turn instead of completing).
- **`XAI_API_KEY` is stripped from the nested call**, because the CLI accepts it as an alternate auth path that would otherwise switch billing to per-token instead of the subscription.
- Images are passed as native `--prompt-json` content blocks (no Read-tool or `-i`-flag workaround needed — the CLI accepts structured image content directly).
- A text-only prompt (the common case) is written to a temp file and passed via `--prompt-file` rather than inline, avoiding the OS argv-length limit a large `context`/`files`/git-diff attachment or judge prompt could otherwise hit. An image-bearing call still passes `--prompt-json` inline (no file-based channel exists for that content-block shape), so the same argv-length exposure remains there, bounded by the existing image size caps.
- Unlike Claude/ChatGPT's CLI members, **Grok defaults to `free`** (opt-in) — set `GROK_TIER` above `free` or `GROK_CLI=true` explicitly to add it to the auto-populated council, since this is a newer provider added on top of an existing install base.

**Where it works:** anywhere the `grok` binary actually executes (this machine, or a `/remote-control`-driven CLI running on your machine). It does **not** work for a remotely-hosted copy of this server.

> Same rules as the Claude/Codex CLIs: sanctioned first-party surface under your own subscription. Reusing a subscription *token* against the raw X.AI API from a third-party app is a separate, prohibited thing; this feature does not do that.

### OpenAI-compatible server format

Comma-separated list of `name:host:port` entries.  
You can run multiple servers on different ports (e.g. different models on the same GPU host):

```
VLLM_SERVERS=gpu1:192.168.1.10:8000,gpu2:192.168.1.10:8001
TRTLLM_SERVERS=trt-main:192.168.1.20:8000
SGLANG_SERVERS=sgl1:192.168.1.30:30000
```

Full URLs also work: `gpu3:http://10.0.0.5:9000`

**Default ports:** vLLM → 8000, TRT-LLM → 8000, SGLang → 30000

### Council defaults

| Variable | Description | Default |
|---|---|---|
| `COUNCIL_MODELS` | Comma-separated model IDs | *(empty — use `configure_council`)* |
| `JUDGE_MODEL` | Judge model ID or `auto` | `auto` (largest council member) |
| `RESPONSE_MODE` | `individual` \| `categorized` \| `deconflicted` \| `pooled` \| `dialectic` | `categorized` |
| `MAX_DECONFLICT_ROUNDS` | Max deconfliction iterations | `3` |
| `WEB_ACCESS` | `true` → council members search the web by default instead of answering from training data. See [Web access](#web-access). Off by default; per-call `web_access` overrides it. | `false` |
| `REASONING_EFFORT` | Default reasoning depth for every member **and** the judge: `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. See [Reasoning effort](#reasoning-effort) — levels a backend doesn't support are clamped, never errored. Outranks the first-run seed below. | *(unset — but a **brand-new install** seeds `high`)* |

### Performance & output

| Variable | Description | Default |
|---|---|---|
| `MAX_TOKENS` | Max **output** tokens requested per completion. Clamped per-model to fit each server's context window (Ollama `/api/show`, OpenAI-compatible `max_model_len`), so a generous value gives longer answers on large-context models without risking an over-context request. CLI members (`claude-cli`/`codex-cli`/`grok-cli`) ignore it — output is subscription-managed. Raise for even longer answers (slower/costlier, multiplied across members × rounds). | `32768` |
| `CLOUD_CONCURRENCY` | Max simultaneous requests to cloud members (Ollama cloud `:cloud`/`-cloud`, OpenAI, Anthropic, X.AI). Ollama cloud needs Pro (3 concurrent) or Max (10) | `3` |
| `LOCAL_CONCURRENCY` | Max simultaneous requests to local models; `1` runs them one at a time to avoid contention, `0` = unlimited | `1` |
| `COMPLETION_RETRIES` | Attempts per completion before giving up on an empty/failed response | `3` |
| `REQUEST_TIMEOUT_MS` | Per-completion wall-clock timeout (ms) for **text-only** calls. Default 5 min — local Ollama models run sequentially, so a busy box needs headroom. Honoured verbatim by every provider, including the subscription CLIs (no 300s floor). A member cut by this timeout is flagged in the result (`timeoutNotice`); raise it or use `set_council_timeouts`. | `300000` |
| `REPO_REQUEST_TIMEOUT_MS` | Per-completion timeout (ms) used **instead** when `full_repo_access` is set — repo-reading completions (CLI member Read/Grep/Glob) run longer. | `600000` |
| `DECONFLICT_VERBOSE` | `true` → deconflicted results include per-round detail by default | `false` |

**Input send-caps** (bound what the tool feeds the council per call — a large attachment is multiplied across every member × round, so these are a real memory/latency/token amplifier, not just a per-request size). Raise them for a council of large-context models; the **practical ceiling is the smallest member's context window**, so sending ~1 MB (~300K tokens) to a 256K-context local member makes that member error cleanly (`PromptTooLargeError`) while cloud members still answer:

| Variable | Description | Default |
|---|---|---|
| `MAX_CONTEXT_KB` | Inline `context` string cap | `1024` (1 MB) |
| `MAX_TOTAL_KB` | Total across all attached `files` | `1536` (1.5 MB) |
| `MAX_FILE_KB` | Per-file cap | `512` |
| `MAX_FILES` | Max number of attached files | `32` |
| `MAX_QUESTION_KB` | `question` string cap (large text belongs in `context`/`files`) | `256` |

> **Note on Ollama input context (`num_ctx`).** The tool does **not** set `num_ctx` — it inherits your Ollama server's default. To let local models actually ingest large context, set `OLLAMA_CONTEXT_LENGTH` on the **Ollama server** (e.g. `262144` for 256K); the tool reads each model's real max from `/api/show` and fits output to it. Leaving `num_ctx` to the server keeps a model loaded at one stable context size (no per-request reloads) — deliberately, so the tool never churns model loads.

The council queries members in parallel but respects these concurrency limits — cloud members share one pool and local members another, so a large council never exceeds your Ollama cloud plan's concurrent-request cap, and local models can be run sequentially to avoid GPU contention. Each pool's limit is enforced **process-wide**, not per-call: two `ask_council`/`ask_council_async` requests in flight at once (e.g. via the 20-slot async job queue) that both touch the same provider still share that provider's single ceiling rather than each getting their own — a concurrent request can end up waiting on a slot another request is holding, which is expected serialization, not a hang. This applies equally to the judge — categorization, pooling, dossier-building, and final synthesis calls draw from the same pool as the member they're judging, not a separate unbounded channel.

### Model ID format

```
provider:model
provider/serverId:model      ← for named multi-server setups
```

**Examples:**
```
ollama:llama3
ollama:mistral:7b-instruct-q4_K_M
openai:gpt-4o
openai:o1-mini
anthropic:claude-opus-4-5
xai:grok-4
vllm/gpu1:meta-llama/Meta-Llama-3-8B-Instruct
trtllm/trt-main:mistralai/Mistral-7B-v0.1
sglang/sgl1:deepseek-ai/DeepSeek-R1
```

---

## MCP Tools

### `list_models`

Discover all models across every configured provider.

```json
{ "filter_provider": "ollama" }
```

Returns model IDs, parameter size, family, disk size — everything you need to fill `configure_council`.

---

### `configure_council`

Update the council at runtime (changes persist for the session).

```json
{
  "models": ["ollama:llama3", "ollama:mistral", "openai:gpt-4o"],
  "judge_model": "openai:gpt-4o",
  "response_mode": "deconflicted",
  "max_deconflict_rounds": 4,
  "reasoning_effort": "high"
}
```

All fields are optional — only supplied fields are updated. `models` is capped at 100 entries. `reasoning_effort` sets the council-wide default reasoning depth (see [Reasoning effort](#reasoning-effort)); it persists across reloads and is overridable per call on `ask_council`. Pass `"auto"` to clear it back to each model's own default — distinct from `"none"`, which actively asks every backend for no reasoning.

> **Parameter names are strict.** An unrecognized parameter is **rejected with an error**, never silently ignored — so a call that doesn't do what you meant fails loudly instead of returning a cheerful `"status": "updated"` while changing nothing. The error names the offending key, suggests the intended one, and lists the valid parameters. Two easy slips worth knowing: the council is **set** with `models` but **reported** (by `get_council_config` / `council_status`) as `members`; and the response mode is `response_mode` here but `mode` on `ask_council`.

---

### `ask_council`

Send a question to the full council.

```json
{
  "question": "What is the best way to handle errors in a distributed system?",
  "mode": "deconflicted",
  "max_deconflict_rounds": 3
}
```

`mode`, `max_deconflict_rounds`, and `reasoning_effort` override the configured defaults for this call only. In `deconflicted` mode, set `"verbose": true` to include the initial categorization, every member's per-round responses, and the round-by-round re-categorization alongside the final synthesis. In `pooled` mode, `"verbose": true` adds the initial (round-0) raw member responses.

<a id="reasoning-effort"></a>
**Reasoning effort.** `"reasoning_effort"` sets how hard the council thinks, on one canonical scale — `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max`:

```json
{
  "question": "Design a migration path off this schema.",
  "mode": "dialectic",
  "reasoning_effort": "max"
}
```

It applies to **every member and the judge**, so one setting governs the whole ask rather than producing deeply-reasoned answers reconciled by a shallow judge.

**A brand-new install starts at `high`** — a council is worth more when its members actually think. That seed is written to `state.json` on the first run only, so from then on it is an ordinary setting you own: change it with `configure_council`, or pass `"auto"` there to clear it back to each model's own default. It is deliberately *not* the plugin option's default value, because a userConfig default would re-apply on every update; an install that already exists and never set an effort keeps running at model defaults, so upgrading never silently changes how hard your council thinks or how much quota it burns. An explicit `REASONING_EFFORT` outranks the seed.

Each backend supports a different slice of the scale, so a level it doesn't accept is **clamped to its nearest supported one, never errored** — a council-wide setting must not shrink a mixed council to whichever members happen to share a vocabulary. Ties clamp *downward* (the cheaper side).

| Member type | Knob used | Levels it accepts | Example clamp |
|---|---|---|---|
| `claude-cli` | `--effort` | `low` … `max` | `none` → `low` |
| `codex-cli` | `-c model_reasoning_effort=` | `none`, `low` … `max` | `minimal` → `none` (its parameter enum advertises `minimal`, but the model itself rejects it) |
| `grok-cli` | `--reasoning-effort` | `low`, `high` | `max` → `high`, `medium` → `low` |
| `ollama` | `think:` | `low`, `medium`, `high`, `max` | `xhigh` → `high`; `none` → `think: false` |
| `openai` / `vllm` / `trtllm` / `sglang` | `reasoning_effort` | `none` … `xhigh` | `max` → `xhigh` |
| `anthropic` (API key) | extended thinking `budget_tokens` | derived from the level | `none`/`minimal` → no thinking |

Two members that can't honour the request at all are handled rather than dropped: an Ollama model with no thinking support, and an OpenAI-compatible server that rejects the parameter, are each retried once without it, so they still answer (at their own depth) instead of failing the call.

**Cost.** Higher levels buy depth with time and subscription quota, and the multiplier is `members × rounds` — a `max` run of a 5-member `deconflicted` council is a materially bigger spend than a `low` one. `set_council_timeouts` may need raising alongside it.

**Which round produced an answer.** Every member response carries a `phase` tag naming the round it came from, so a caller reading raw JSON can tell the rounds apart without inferring it from the surrounding field name:

| `phase` | Round |
|---|---|
| `thesis` | Round 0 — each member's initial, independent answer (every mode) |
| `antithesis` | `dialectic` — defend your own pick, argue the alternatives are worse |
| `synthesis` | `dialectic` — final ranked re-selection after weighing the pros/cons dossier |
| `reconsidered` | `pooled` — a fresh answer given after seeing the neutral pool |
| `deconflict` | `deconflicted` — a re-question aimed at the open conflicts; `round` carries which pass (1-based) |

This is defense in depth, not the primary mechanism. Rounds are already separated structurally: each is its own awaited call whose results land in a dedicated array at a fixed per-member index, so a slow member's answer can never arrive late and be swept into the next round — a member that times out simply leaves an errored entry in its own round's slot (and sets `judgeDegraded`). The tag puts that round on the *record* rather than leaving it implied by the container, so a future refactor that merges or forwards responses between collections can't silently turn a thesis into an antithesis. The `dialectic` dossier prompt — the one place two rounds are shown to the judge together — labels each entry from its own `phase` for the same reason.

<a id="web-access"></a>
**Web access.** `"web_access": true` lets members SEARCH THE WEB for that call, so they research current facts instead of answering from training data. Off by default — it costs latency and subscription quota, and it pulls untrusted text into the council.

```json
{ "question": "Which US steakhouses currently hold three Michelin stars?", "web_access": true }
```

Who can actually research depends on whether a member has an agentic tool loop to grant a search tool inside:

| Member | How it researches |
|---|---|
| `claude-cli` | `--tools WebSearch,WebFetch` **plus** `--allowedTools` — both are required; the first enables the tool, the second permits its use |
| `codex-cli` | `-c tools.web_search=true` (`codex exec` has no `--search` flag) |
| `grok-cli` | web tools re-enabled in `--tools`; **names unverified**, and it fails closed if the guess is wrong |
| bare `ollama:*` | **automatically re-pointed through the claude-CLI harness** for the call, since Ollama serves an Anthropic-Messages endpoint — so it researches too |
| `openai` / `xai` / `vllm` / `trtllm` / `sglang` | **cannot** — one flattened completion, no tool turn |

Every result then carries a `webRouting` block naming `researched`, `fromMemory` (with the reason), and `routedViaHarness`. That exists so a partly-researched council is never read as a fully-researched one — the judge reconciles those answers as peers, so the split has to be visible.

**Known limitation (verified live).** An open-weight model driven through the harness may emit its OWN native tool-call markup as plain text instead of an executable tool call — observed with `kimi-k3:cloud` at `--effort max`, while the same call at `low` searched correctly and cited a source. No search runs in that case, so the provider now rejects such a reply as a failed completion (retried, then reported as a member error) rather than letting the markup reach the judge as a position.

**Timeouts adapt to the member, not the other way round.** Throughput across a mixed council spans roughly 20× — a local model on Apple silicon runs ~10 tok/s, Ollama cloud ~200, the hosted APIs 20–50 — so a single per-completion deadline is either wasted on the fast members or a guillotine for the slow ones. Two things follow. Calls with `full_repo_access` **or** `web_access` use the longer `REPO_REQUEST_TIMEOUT_MS` budget, because both pull far more content (a repo tree, several fetched pages) and output length scales with it. And any member that has genuinely needed longer before is given at least that again, learned from its own history rather than configured — capped, and only ever raised by a *successful* round, so a timeout can never inflate the budget that caused it. The history is kept **per workload**, because the workloads differ by more than the models do: a member that answers a question in 8s can legitimately need minutes to review a repo. A plain measurement does raise the *heavy* floor (heavy work is a superset — it cannot be faster), but a heavy measurement never raises the plain one, since a long repo review says nothing about a short question.

**Capability detection.** A member on an engine the council has no built-in knowledge of is **probed, not refused** — one small completion to find a working harness, plus (only when web access is wanted) one tool-call probe, since a model can answer perfectly and still be unable to execute a tool call. The result is written to `state.json` `harnessCapability` and reused, so the cost is paid at most once per model per 30 days, across restarts *and* plugin updates. A timeout is recorded as inconclusive rather than as a verdict, so a slow machine never permanently condemns a capable model.

**What a researched result carries.** Every result now includes `usage` (member completions and per-member wall-clock — judge calls excluded — so the cost of an ask is legible rather than discovered at the quota), and `judgeIsMember: true` when the judge also answered as a member, since its reconciliation then includes its own answer. With `web_access` on, `webRouting.sources` consolidates every URL the members cited, deduplicated and ordered by corroboration, so "3 of 4 members cite AP for this" is a fact you can read instead of reconstruct by diffing member blocks. And when a conflict's positions differ in verifiable backing — one side cites a source, the other doesn't — the judge adds an `assessment` naming which position is better supported and why; equal backing means no field, never a fabricated tiebreak. Capability warnings also now clear themselves: a model measured tool-capable (by probe or by a successful researched round) stops wearing its family's seeded caveat.

**Security.** Page content is untrusted input that flows into member answers and then into judge prompts — the same trust class as `context`/`files`/git-diff, and every member prompt says so explicitly. Grant it deliberately.

**Completion markers & timeout cuts.** Every completed answer is wrapped in `═══════ BEGINNING OF RESPONSE ═══════` / `═══════ END OF RESPONSE ═══════` delimiters (the JSON payload sits intact on its own lines between them — strip the first and last line to parse). The markers are the completion signal: the tool returns the moment the council finishes, so it never waits the full timeout just because the timeout is set. If a member's completion is cut by the per-completion timeout, the result carries `timeoutNotice: "RESPONSE TIMED OUT, INCREASE TIMEOUT IF MESSAGE IS CUT"` plus a `timedOutMembers` array of the cut labels — this surfaces even under `verbose: false`. Raise the budget with `set_council_timeouts` (or `REQUEST_TIMEOUT_MS` / `REPO_REQUEST_TIMEOUT_MS`) and re-ask.

**Attach context / files.** Add `"context"` (inline background text) and/or `"files"` (an array of local file paths). Files are read from disk and fenced with a `----- FILE:<nonce>: <path> -----` header (a random per-call token, so a file/diff whose content contains a fake fence marker can't forge a boundary the model would mistake for real) so every member sees them as labelled context alongside the question. Caps: 256 KB/file, 768 KB total, 20 files, 768 KB for `"context"` itself, 256 KB for `"question"` — for anything larger than the question cap, pass it via `context` instead. A missing/oversized/binary file (or an oversized `question`/`context`) returns a clear error rather than being silently dropped or truncated. Note: `files`/`images` read any path the server process can read, with no root restriction — the MCP caller is trusted the same way a local `Read` tool call would be.

```json
{
  "question": "What's wrong with this auth flow?",
  "mode": "dialectic",
  "files": ["src/auth.ts"],
  "context": "Public SaaS signup path; must be OWASP-clean."
}
```

**Repo review — auto-attach a git diff.** Instead of hand-listing every changed file via `"files"`, add `"git_ref"` and the server runs `git diff` locally and attaches the result as context:

```json
{
  "question": "Review this diff for bugs and regressions.",
  "mode": "categorized",
  "git_ref": "uncommitted"
}
```

`git_ref` is one of `"uncommitted"` (staged + unstaged vs `HEAD` — the usual "review my changes" case), `"staged"`, `"unstaged"`, or any git revision/range (`"main..HEAD"`, `"HEAD~3..HEAD"`, a commit SHA). `"git_repo"` defaults to the server's working directory, which for a Claude Code plugin session is normally your project root — pass it explicitly if it isn't (e.g. a standalone MCP install launched from elsewhere). Errors clearly (not silently) on an invalid ref, a ref that looks like a git option rather than a revision (rejected outright — no legitimate revision starts with `-`), a path that isn't a git repo, no changes found for the ref, or a diff too large to attach automatically (> 512 KB — narrow the range, or fall back to `"files"` for specific files). Note: like plain `git diff`, this doesn't show brand-new **untracked** files — only changes to files git already knows about. This only reads a diff on the server's own machine via `git diff` (no shell, args passed as an array, external diff/textconv and repo-configured `core.fsmonitor`/`core.hooksPath` all disabled, clean/smudge/process **filter drivers** neutralized (each configured `filter.<name>.{clean,smudge,process}` overridden to a no-op, so an untrusted repo's filter command can't execute during a working-tree diff — this disables the filter itself, so it's complete across all three attribute layers, `.gitattributes`/`.git/info/attributes`/`core.attributesFile`, and works on every Git version), a 15s subprocess timeout, run against the same canonicalized/realpath'd directory the repo-root validation itself checked) — it does not give any council member live/agentic git access; API-keyed members never gain filesystem access at all, and the CLI-based members (`claude-cli`/`codex-cli`/`grok-cli`) stay locked down exactly as before.

**Full repo-wide review.** `git_ref`/`files` cover "review this diff" / "review these files" — for a genuine repo-wide review (architecture, cross-cutting concerns, anything a diff or a hand-picked file list can't show), add `"full_repo_access": true`:

```json
{
  "question": "Review the whole repo: architecture, risky areas, what you'd improve.",
  "mode": "individual",
  "full_repo_access": true
}
```

**⚠️ This is a real permission grant, not a convenience flag — and the two providers enforce it differently.** `claude-cli` gets `Read`/`Grep`/`Glob` scoped to the repo root via `--add-dir`, an **enforced** boundary — verified empirically that a Read attempt outside the granted directory is denied by the CLI itself. `codex-cli` points its working root (`-C`) at the real repo instead of the usual empty directory, staying inside its `read-only` sandbox (writes are always blocked, everywhere) — but `-C` is only a **starting point, not a read boundary**: codex's `read-only` sandbox permits reading any file the OS-level user can read, anywhere on the machine, verified live (this is pre-existing behavior of every codex-cli call, not something this mode introduces — the mode's system prompt just actively invites exploration, so the practical likelihood of wandering outside the repo goes up even though the technical capability was always there). Codex is instructed to stay inside the repo root as a soft, unenforced guardrail. An Ollama-harness member (auto-populated curated `:cloud` models or explicit `CLAUDE_CLI_OLLAMA_MODELS`, above) is enforced identically to `claude-cli` — it's the same harness — but sends repo contents to whichever Ollama backend answers instead of Claude's. Neither provider can write, edit, or run commands that mutate anything. Defaults to `false`; the calling agent should confirm with the user before setting it true for an interactive request — it's reasonable to set it autonomously only for an unattended review step you already control (e.g. an end-of-workflow code review with no user waiting on a prompt). Other council members (`openai`/`anthropic`/`xai`/`ollama`/self-hosted, and `grok-cli`) are unaffected — they have no filesystem/tool concept in this architecture, so there's nothing to grant. Repo root is `"git_repo"` if set, else the server's working directory (see above) — validated the same way `git_ref` is (must resolve to a real git work tree, not an arbitrary directory, and not just inside a `.git` metadata directory) before anything is granted; your home directory is specifically rejected even when it is itself a valid git repository (e.g. a dotfiles checkout), since that's a common, high-blast-radius case no git-plumbing check can otherwise distinguish from a legitimate small project; the validated path is also **canonicalized (symlinks resolved)** before being granted onward, so a symlink in the path can't be retargeted between validation and the CLI call to redirect access somewhere never checked. This mode necessarily reveals file contents to whatever cloud subscription is answering (`claude-cli`/`codex-cli` run under your own Claude/ChatGPT login) — don't use it in a repo (or, for codex, on a machine) containing secrets/credentials you wouldn't otherwise send to that provider.

**Attach images (vision).** Add `"images"` (an array of local png/jpg/jpeg/gif/webp paths) to ask a vision question. Vision support is auto-detected per member with a **two-stage check**, then cached:

1. **Cheap negative prefilter** (per provider): Ollama's `/api/show` `capabilities` field; OpenAI-compatible (vLLM/SGLang/TRT-LLM/OpenAI/X.AI) and Anthropic send a real functional probe (a small test image + `max_tokens: 1`, since neither advertises vision via metadata). A "no" here is trustworthy and skips stage 2. `claude-cli`/`codex-cli` have no cheap signal and go straight to stage 2.
2. **Behavioral OCR-challenge confirmation**: a stage-1 "yes" is only trusted once the model has proven it can actually read pixels — it's sent a small, high-contrast rendered image containing a random 4-digit code (10 are pre-generated; the exact code is never in the prompt) and graded on whether its reply contains that exact code. This step exists because a stage-1 "yes" is **not** reliable on its own: some OpenAI-compatible servers accept an `image_url` part and silently ignore it for a non-vision model (confirmed live against a self-hosted SGLang endpoint — 200 OK, fabricated answer), and Ollama's `capabilities` metadata can be stale for custom/quantized builds (MLX conversions, GGUF imports) that dropped the vision projector while the tag still says `vision` (documented upstream: ollama#9967, and reproduced live with a local `-mlx` model that claimed vision support but denied ever receiving an image). Two challenge images are tried per model (pass if either is read correctly) to absorb one unlucky misread; only a clean, non-empty wrong answer counts as a real failure — a timeout or empty response is treated as inconclusive and retried next time, never cached as a false negative.

`codex-cli` attaches images via its first-party `-i/--image` flag (written to a temp file, passed directly — no workaround needed). `claude-cli` has no image flag, so images go to a narrowly-scoped `--tools Read --add-dir <freshTempDir>` (a fresh temp directory containing nothing but the image; `--add-dir` is an enforced permission boundary, verified empirically — a Read attempt outside the granted directory is denied by the CLI itself, not merely discouraged; every other lockdown — no MCP, no other tools, no session persistence — is unchanged, and calls with no images keep the original fully-closed `--tools ""`).

**Only the confirmed vision-capable members are queried** — everyone else is skipped for that call, never receiving the image in any form, correct or garbled. The routing decision is reported back in `visionRouting`. Caps: 8 MB/image, 24 MB total, 6 images. Passing an image to `"files"` (which reads as UTF-8 text) is rejected with a pointer to use `"images"` instead — that's the one other route to sending a model garbled data.

In a multi-round mode (`pooled`, `dialectic`, `deconflicted`), the image is re-attached to **every** member-facing round — reconsideration, defense, selection, deconfliction — not just the initial answer, so a member revising its view of the image is still looking at it rather than working from its own earlier description. It is never sent to the judge (pool-digest / dossier / categorization calls work from members' text responses only).

> First vision question against a never-before-verified member costs one extra round trip (the OCR challenge) before the real question is asked — a few seconds for a fast model, longer for a CLI subprocess or a slow local model. The verified result is cached per model **and persisted to disk** (the same state file that already survives restarts for your tiers and council edits), so this cost is paid at most once per model, not once per session — a `/reload-plugins` or server restart does not re-run the OCR challenge for a model already proven (in)capable, which matters most on a slower machine juggling several local models. Each cached result carries a 30-day TTL, so a stale "not vision-capable" from before a later Ollama pull or a provider fixing a bug eventually self-heals with a fresh probe rather than sticking forever. The detection round also respects the same per-provider concurrency limits as a real question (notably `local`, typically 1) — verifying multiple local Ollama models' vision at once is itself a real completion call per model, and firing them all concurrently can thrash memory on hardware that can only hold one large local model in RAM/VRAM at a time, which previously showed up as genuinely vision-capable local models being (transiently) misreported as not vision-capable under load. In practice, local vision-capable models vary widely in reading accuracy on dense-text screenshots even once verified — Claude/ChatGPT (via `claude-cli`/`codex-cli`) and a properly-sized self-hosted vision model both read fine text/numbers accurately; small local models can pass the OCR challenge while still misreading specifics in a real, denser image. The routing/format guarantee above is unconditional; read quality on your actual question depends on the model you point it at.
>
> `ask_council` (the synchronous call, not `ask_council_async`) reports progress via standard MCP `notifications/progress` when the caller supplies a progress token — most MCP clients do this transparently, surfacing a live status line ("Checking vision capability: ollama:gemma4:12b (2/5)", "Asking claude-cli:opus...") instead of a silent wait during a slow, multi-member vision-detection round.

> **On Ollama, avoid `-mlx`-tagged models for vision.** Ollama's native MLX runner (Apple Silicon) currently has an incomplete multimodal pipeline — no image-input stage is wired in yet at the runner level, and this is a documented, still-open gap ([ollama#16700](https://github.com/ollama/ollama/issues/16700)), not a fluke of one quantization. It shows up two ways: some `-mlx` builds simply don't claim `vision` in `/api/show` (`gemma4:31b-mlx` reports `[completion, tools, thinking]` — no vision — where the regular `gemma4:12b` reports `[completion, vision, audio, tools, thinking]`, verified directly); others still claim `vision` but the runtime can't actually use it (`qwen3.6:35b-mlx` reports `vision` yet denies ever receiving an image). Both shapes are already handled correctly by the two-stage check above — the "no claim" case is filtered cheaply at stage 1, the "false claim" case is caught at stage 2 — so nothing breaks either way, but you'll get more members answering a vision question if you pull the regular (non-`-mlx`) tag of a vision model instead.

```json
{
  "question": "What's the council verdict shown in this screenshot?",
  "mode": "individual",
  "images": ["/Users/me/Desktop/result.png"]
}
```
```json
{
  "mode": "individual",
  "responses": [ { "label": "ollama:llava3", "response": "…" } ],
  "visionRouting": {
    "imagesAttached": 1,
    "queriedVisionModels": ["ollama:llava3"],
    "skippedNonVision": ["ollama:llama3", "claude-cli:opus"]
  }
}
```

#### Individual result

```json
{
  "mode": "individual",
  "question": "...",
  "responses": [
    { "label": "ollama:llama3", "response": "...", "latencyMs": 1240 },
    { "label": "openai:gpt-4o", "response": "...", "latencyMs": 843 }
  ]
}
```

#### Categorized result

```json
{
  "mode": "categorized",
  "question": "...",
  "commonAgreement": "All models agree that ...",
  "complementary": [
    { "aspect": "performance", "models": ["ollama:llama3"], "insight": "..." }
  ],
  "conflicting": [
    {
      "id": "conflict-1",
      "topic": "retry strategy",
      "positions": [
        { "models": ["ollama:llama3"], "position": "exponential backoff" },
        { "models": ["openai:gpt-4o"], "position": "circuit breaker preferred" }
      ]
    }
  ],
  "judgeModel": "openai:gpt-4o"
}
```

`judgeDegraded: true` is added (empty `conflicting`/`complementary`, `commonAgreement: null`) only when the judge
model failed to produce usable/parseable output — a real "the council agreed on everything" result never sets it.

#### Deconflicted result

```json
{
  "mode": "deconflicted",
  "question": "...",
  "roundsTaken": 2,
  "maxRounds": 3,
  "deconflictionScore": 75,
  "resolved": 3,
  "totalConflicts": 4,
  "finalSynthesis": "The council recommends ...",
  "unresolvedConflicts": [ { "id": "conflict-3", "topic": "...", "positions": [...] } ],
  "roundHistory": [
    { "round": 1, "conflictsEntering": 4, "conflictsResolved": 2, "conflictsRemaining": 2 },
    { "round": 2, "conflictsEntering": 2, "conflictsResolved": 1, "conflictsRemaining": 1 }
  ],
  "judgeModel": "openai:gpt-4o"
}
```

**Deconfliction score**: `resolved / totalConflicts × 100`, computed to hold two invariants
regardless of how many rounds ran: it is **100 iff `unresolvedConflicts` is empty**, and it is
**always strictly below 100 while any conflict remains open** — `resolved` also never exceeds
`totalConflicts`. This matters because the judge can reword a still-open conflict between rounds
(see the exact-match note below); the topic is carried forward rather than silently dropped, which
means the same underlying disagreement can end up resolving under a wording that was never part of
the original `totalConflicts` count. Rather than trying to perfectly attribute a later resolution
back to the original conflict it descended from (which would need an ID-keyed judge protocol), the
score is clamped to stay numerically honest at the cost of some precision in the edge case.
`judgeDegraded: true` marks any run a judge failure affected — never set on a genuine outcome.
Two cases: if the judge failed on the *initial* categorization, no conflict count could even be
established, so `deconflictionScore` is `null` (not a fabricated 100 %). If a *later* round's
judge output failed, the loop stops without inventing a resolution for the conflicts that round
was assessing — `deconflictionScore` is still a real number computed from whichever rounds did
succeed, but treat it as a pessimistic **lower bound**: conflicts left "unresolved" may only look
that way because the judge never got to re-assess them, not because the council truly disagreed.

Round-to-round resolution matching is **exact** (case/whitespace-normalized), not fuzzy: each
round's categorization prompt is told the currently open conflict topics and instructed to reuse
them verbatim if a response still reflects the same disagreement, which is what makes exact
matching reliable — a judge that quietly rewords a still-open topic reads as that conflict having
resolved and a new one appearing, rather than the topic silently vanishing into a false match.

#### Pooled result (Delphi)

```json
{
  "mode": "pooled",
  "question": "...",
  "judgeModel": "openai:gpt-4o",
  "initialPool": {
    "options": [
      { "answer": "Exponential backoff", "rationale": "<reasons merged from everyone who said it>", "models": ["ollama:llama3", "openai:gpt-4o"] }
    ]
  },
  "reconsidered": [
    { "label": "ollama:llama3", "response": "<fresh answer after seeing the neutral pool>", "latencyMs": 1120 }
  ],
  "finalPool": { "options": [ { "answer": "...", "rationale": "...", "models": ["..."] } ] }
}
```

Why `pooled` exists: the `deconflicted` loop shows each member the *labelled* factions (`[modelA, modelB]: X`) and asks them to "agree with one of the existing positions" — that is social proof, and minority views tend to collapse toward the visible plurality in a single round, erasing the decorrelation the council exists to surface. `pooled` follows the **Delphi method** instead: the judge distils all answers into a neutral digest — one entry per distinct answer, rationale merged from everyone who gave it, but with **no counts, no attribution, and no ranking** — then re-asks members the original question against that digest ("in no particular order, here is what others said — what do you think?"). Members reconsider on substance, not popularity. The `models` field on each option is recorded for *your* analysis and is **never** shown back to members. No final winner is declared: compare `initialPool` vs. `finalPool` to see whether — and how much — opinion actually moved.
`judgeDegraded: true` on either digest means the judge failed to produce usable output for that step — its `options: []`
is a fallback, not a genuine "nothing distinct to pool" result. `dialectic` carries the same flag at the top level, covering
both the shared digest step and its own pros/cons dossier step.

#### Dialectic result (thesis → antithesis → synthesis)

```json
{
  "mode": "dialectic",
  "question": "...",
  "judgeModel": "openai:gpt-4o",
  "defenses": [
    { "label": "ollama:llama3", "response": "<defends its pick, argues the others are weaker>", "latencyMs": 3900 }
  ],
  "prosCons": [
    {
      "answer": "Exponential backoff",
      "pros": ["adapts to load", "avoids overwhelming a struggling dependency"],
      "cons": ["more complex", "longer worst-case latency"],
      "championedBy": ["ollama:llama3", "openai:gpt-4o"]
    }
  ],
  "selections": [
    { "label": "ollama:llama3", "response": "#1 ... #2 ... #3 ... (with the trade-off accepted)", "latencyMs": 4100 }
  ]
}
```

Where `pooled` is deliberately *neutral*, `dialectic` is deliberately *adversarial*. Step 1 (**antithesis**) shows every member the full option set and asks it to defend its own initial pick and argue why each alternative is not better — personalised per member. The judge then distils those defenses and critiques into a balanced **pros/cons dossier** (`prosCons`), one entry per option with arguments for *and* against. Step 2 (**synthesis**) shows that dossier to every member and asks for a fresh ranked top-3, accepting the main trade-off of each choice. `championedBy` records who originally proposed each option (for your analysis). Use it when you want each option stress-tested from both sides before anyone commits — the opposite of the social-proof collapse `deconflicted` can produce. Add `"verbose": true` to include the thesis (round-0) responses.

---

### `ask_council_async`

Same inputs as `ask_council` (including `context` / `files` / `git_ref`), but starts the run in the **background** and returns a `job_id` immediately — so a long deconfliction/dialectic run, or a council with slow local models, doesn't block you. At most 20 jobs may be **running** at once (finished jobs don't count against this — poll `get_council_result` and start more once one completes); a 21st concurrent call is rejected with a clear error rather than silently queued.

```json
{ "status": "running", "job_id": "6f2c…", "mode": "dialectic", "members": 8 }
```

### `get_council_result`

Fetch a background run by `job_id` (status `running` → `done`/`error`, with the full result when done), or omit `job_id` (or pass `"list": true`) to list recent jobs. Jobs live in memory and are dropped on server reload.

```json
{ "status": "done", "job_id": "6f2c…", "elapsedMs": 48210, "result": { "mode": "dialectic", … } }
```

### `get_council_config`

Returns current council settings plus all configured provider connections and the full env-var reference.

### `council_status`

The welcome/status readout (works in **every** client and install method). Returns the detected environment (local Ollama models, Ollama-cloud reachability, whether the Claude/Codex CLIs are installed **and logged in**), the current council members, resolved subscription tiers, per-provider concurrency, a quota warning, and hints for anything not usable. Read-only.

### `setup_council`

Set subscription tiers (`chatgpt`, `claude`, `ollama`), then re-detect and auto-populate the council with everything usable. Persists across reloads. Concurrency and newly-registered providers take full effect after a `/reload-plugins`.

### `set_council_timeouts`

Change the per-completion timeouts at runtime — `run_timeout_ms` (text-only calls) and/or `repo_timeout_ms` (calls with `full_repo_access`). Both in milliseconds (1000–1800000). Persists across reloads and overrides the `REQUEST_TIMEOUT_MS` / `REPO_REQUEST_TIMEOUT_MS` env defaults; **takes effect on the next `ask_council`, no reload needed.** Omit either to leave it unchanged. Returns the now-effective values. Unknown keys are rejected (the schema is strict), so a misspelled parameter errors rather than silently no-op'ing. `council_status` surfaces both current values under `timeouts`.

Use it when a member answer is cut mid-generation — the result then carries a `timeoutNotice` (see `ask_council`).

### Slash commands (Claude Code plugin only)

- **`/model-council:setup`** — interactive tier selection (arrow-select menus) → `setup_council`.
- **`/model-council:status`** — renders `council_status`.

Standalone MCP installs call the `setup_council` / `council_status` **tools** directly for the same result.

---

## Deconfliction algorithm

```
1. Query all council members in parallel → N raw responses
2. Judge model categorises → common / complementary / M conflicts
3. If M = 0 → synthesise final answer, score = 100 %
4. For each round r in 1..maxRounds:
   a. Ask all members specifically about each open conflict
   b. Judge re-categorises conflict responses
   c. Conflicts where positions converge → marked resolved
   d. If no conflicts remain → break
5. Score = resolvedCount / M × 100
6. Judge synthesises final answer, noting any unresolved conflicts
```

---

## Example: full multi-provider setup

```json
{
  "mcpServers": {
    "model-council": {
      "command": "node",
      "args": ["/absolute/path/to/model-council-mcp/bundle/server.cjs"],
      "env": {
        "OLLAMA_ADDRESS": "http://localhost:11434",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "XAI_API_KEY": "xai-...",
        "VLLM_SERVERS": "gpu1:192.168.1.10:8000,gpu2:192.168.1.10:8001",
        "SGLANG_SERVERS": "sgl1:192.168.1.30:30000",
        "COUNCIL_MODELS": "ollama:llama3,ollama:mistral,openai:gpt-4o,anthropic:claude-sonnet-4-5,xai:grok-4",
        "JUDGE_MODEL": "anthropic:claude-opus-4-5",
        "RESPONSE_MODE": "deconflicted",
        "MAX_DECONFLICT_ROUNDS": "3"
      }
    }
  }
}
```

---

## Background

The council's value comes from **decorrelation**: routing a question to independent models from different families and providers surfaces systematic biases and blind spots that any single model — or a set of correlated ones — would hide. The `categorized` and `deconflicted` modes make that disagreement explicit and then work to resolve it.

This design is informed by *The Mirror Law*, which shows that a learner trained against a single reference reproduces that reference's error field — so the bias is invisible from the loss curve alone, and a **decorrelated** second reference is what makes the hidden bias observable.

> Sarihan, Tom. *The Mirror Law: Reference Quality and the Transfer of Systematic Bias in Imitation and Distillation.* Preprint, 2026. DOI: [10.5281/zenodo.21282027](https://doi.org/10.5281/zenodo.21282027). Code and materials: [github.com/tsarihan/MirrorLaw](https://github.com/tsarihan/MirrorLaw).

```bibtex
@article{sarihan2026mirror,
  title  = {The Mirror Law: Reference Quality and the Transfer of Systematic Bias in Imitation and Distillation},
  author = {Sarihan, Tom},
  year   = {2026},
  doi    = {10.5281/zenodo.21282027},
  note   = {Preprint}
}
```

---

## FAQ

**How is this different from `claude-council` (hex/claude-council)?**
They solve different problems. `claude-council` gives Claude Code the opinions of *other* cloud coding agents (Gemini, GPT/Codex, Grok, Perplexity) with a rich coding-workflow UX (roles, vision, tmux streaming). **model-council** convenes a panel across your **own** infrastructure — local **Ollama**, self-hosted **vLLM / SGLang / TensorRT-LLM**, *and* your Claude + ChatGPT subscriptions — and reconciles it with decision-theoretic modes (Delphi **pooled**, **dialectic**, scored **deconfliction**), not just side-by-side + debate. Concretely, only model-council: (a) runs fully **local / offline / private**, (b) auto-discovers self-hosted models and their **context windows**, and (c) puts **Claude itself** on the panel. It also ships as a **standalone MCP server**, so it works in Claude Desktop and any MCP client, not only Claude Code.

**Do I need API keys?** No. Local Ollama and self-hosted servers need none; Claude, ChatGPT, and Grok members run under your existing subscriptions via the first-party `claude` / `codex` / `grok` CLIs. API keys are only for the optional OpenAI/Anthropic/X.AI cloud members.

**Does it work in Cowork / claude.ai?** No — it executes your local `claude`/`codex`/`grok` CLIs and reaches localhost/LAN model servers, which cloud-hosted surfaces can't do. Use it in **Claude Code** (plugin) or **Claude Desktop** (standalone MCP).

**Can it review a file, a diff, a whole repo, or run without blocking?** Yes — `ask_council` takes `context` / `files` / `git_ref` (auto-attaches a local `git diff`) / `full_repo_access` (WARNING: grants `claude-cli`/`codex-cli` members read-only access to the whole repo — see its section above), and `ask_council_async` + `get_council_result` run a council in the background and fetch the result when ready.

**What does "judge" mean?** Categorized / deconflicted / pooled / dialectic modes use one member as the judge that groups, re-questions, or distils the others. It's auto-selected as the largest member; override with `judge_model`.

---

## Privacy & data handling

model-council runs **entirely locally** and stores nothing off your machine. Full policy: [PRIVACY.md](PRIVACY.md).

- **Where your prompts go.** A question is sent only to the model endpoints you configure: your local Ollama server, any self-hosted vLLM/TRT-LLM/SGLang servers, cloud API providers you supply keys for (OpenAI/Anthropic/X.AI), Ollama `:cloud` models (routed through Ollama's cloud infrastructure), and — for subscription members — your own local `claude` / `codex` / `grok` CLIs. **Cloud models (of any provider) send your prompts to that provider's cloud.** Check each cloud provider's data-retention and training policies before use, and do not send personal or sensitive data to any cloud provider whose policies you have not reviewed. There is no model-council backend and no telemetry; nothing is sent to the author.
- **Credentials.** API keys are stored in your client's secure storage (system keychain) and used only to call the provider you gave them for. Subscription members run under **your own** Claude/ChatGPT/Grok login via the first-party CLIs; the server strips `ANTHROPIC_*` / `OPENAI_*` / `CODEX_*` / `XAI_API_KEY` keys from those child processes so inference is billed to your subscription, not an API key.
- **On disk.** The only file written is `~/.config/model-council/state.json` (your selected tiers + council members), plus `~/.codex` / Claude CLI / Grok CLI session state owned by those tools. No conversation content is persisted by this server.
- **Subprocesses.** Detection and subscription inference shell out to the locally-installed `claude`, `codex`, and `grok` binaries (read-only sandbox for Codex; MCP/tools disabled and `bypassPermissions` scoped to the nested call for Claude/Grok so they can't recurse or take actions).
- **`full_repo_access` (opt-in, off by default).** When set, `claude-cli`/`codex-cli`/harness members can read any file in the granted repo for that call, and their answer may include file contents from anywhere in the repo. It never grants write/execute access. For cloud members (subscription CLIs, API-keyed providers, Ollama `:cloud`, harness `:cloud`) repo contents are sent to that provider's cloud — the same data-handling considerations above apply. Don't enable it on a repo containing secrets/credentials you wouldn't send to that provider.
- **Judge and peer trust.** `categorized`/`deconflicted`/`pooled`/`dialectic` modes feed raw member responses into a judge-model prompt, prefixed with an explicit "treat this as data, not instructions" framing as defense-in-depth. The multi-round modes' member-facing prompts (deconfliction rounds, the pooled repoll, dialectic defense/selection) carry an equivalent framing when they show a member other members' positions — worded for a member meant to substantively engage with the content, not just classify it. Neither is a hard guarantee — a member response (especially one built from attacker-influenced content, e.g. `full_repo_access` on a hostile repo) could in principle contain text crafted to steer a judge's classification or another member's answer. Treat judge-synthesized fields (`commonAgreement`, `conflicting`, pooled/dialectic digests) with the same skepticism you'd apply to any LLM output over untrusted input.

---

## License

Apache License 2.0 — Copyright (c) 2026 Tom Sarihan (Desnet AI LLC). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
