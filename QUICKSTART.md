# Quickstart

`model-council-mcp` fans one question out to a **council of models** — local (Ollama),
self-hosted (vLLM / SGLang / TRT-LLM), your **Claude** and **ChatGPT** subscriptions
(via the first-party `claude` / `codex` CLIs, no API key), and cloud APIs — then
reconciles their answers. It is designed to **just work** the moment you install it:
it auto-discovers what you already have and asks you to configure only what it can't
detect.

- **Install (Claude Code plugin):**
  ```
  /plugin marketplace add tsarihan/model-council-mcp
  /plugin install model-council@model-council
  ```
- **Install (standalone MCP, any client):**
  ```
  claude mcp add model-council -s user -- npx -y model-council-mcp
  ```

On first use it detects your environment, builds a council, and tells you what it
found. Change anything anytime with **`/model-council:setup`** (interactive) or the
`configure_council` / `setup_council` tools. Ask with `ask_council`.

---

## Pick your scenario

Each scenario below lists the **minimum** you need. Everything auto-detected needs no
configuration at all.

### 1) Ollama only — zero config

Install the plugin. Done.

- It auto-discovers **every local Ollama chat model** (embedding models excluded) and
  makes them the council.
- Nothing to set. If Ollama runs on another host/port, set `ollama_address`
  (e.g. `http://192.168.1.20:11434`).
- Want Ollama **cloud** models (`:cloud`) too? Set `ollama_tier` to `pro` or `max` and
  sign in to Ollama cloud — a curated set is added automatically.

> Remove any model you don't want (e.g. safety/guard classifiers) with
> `configure_council` — the removal persists across restarts.

### 2) Ollama + Claude (your Claude subscription)

- Install the **Claude Code CLI** and **log in** to your Pro/Max plan (`claude`, then
  `/login`).
- Set `claude_tier` to match your plan (`pro` · `max5x` · `max20x`).

That's it — Claude members (`opus`, `sonnet`, `haiku`) are added **only when the CLI is
detected as logged in**. Inference runs under your subscription (no API key, no
per-token billing). Override the model list with `claude_cli_models` if you want.

### 3) Ollama + ChatGPT (your ChatGPT subscription, via Codex)

- Install the **Codex CLI** and **sign in with ChatGPT** (`codex login`).
- Set `chatgpt_tier` to match your plan (`plus` · `pro5x` · `pro20x`).

Codex members (`gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`) are added **only when the
CLI is detected as signed in**. Note: Codex is a coding agent, so its answers carry a
coding-agent flavor. Override with `codex_cli_models`.

### 4) Everything — Ollama + Claude + Codex + vLLM + SGLang + TRT-LLM

Do scenarios 1–3, **plus** point the plugin at your self-hosted OpenAI-compatible
servers. These are the one thing the plugin cannot discover on its own (it doesn't scan
your network), so you name them:

```jsonc
// plugin config (or the matching env vars for a standalone install)
"vllm_servers":   "gpu1:192.168.1.50:8000",            // name:host:port  (port defaults to 8000)
"trtllm_servers": "gpu1:192.168.1.50:8001",            // comma-separate multiple: "a:host:8000,b:host:8001"
"sglang_servers": "gpu2:192.168.1.51:30000"            // port defaults to 30000
```

Optionally add cloud APIs with `openai_api_key` / `anthropic_api_key` / `groq_api_key`.

Once a server is registered, its **models and context windows are auto-discovered** — you
only supplied the address. Then build the exact panel you want:

```
configure_council(models=[
  "vllm/gpu1:my-model",
  "sglang/gpu2:my-model",
  "trtllm/gpu1:my-model",
  "ollama:llama3.1:8b",
  "claude-cli:opus", "claude-cli:sonnet", "claude-cli:haiku",
  "codex-cli:gpt-5.6-sol", "codex-cli:gpt-5.6-luna", "codex-cli:gpt-5.6-terra"
])
ask_council(question="…", mode="pooled")
```

> Slow local models (large MLX/GGUF)? Raise `request_timeout_ms` (default 120000 ms).
> CLI providers keep a 300 s floor regardless.

---

## What's auto-discovered vs. what you set

The rule of thumb: **the plugin discovers capabilities, you supply connections and
credentials.** It never scans your network or logs you in — but once it can reach a
server or a logged-in CLI, it figures out the rest.

| Thing | Auto? | How |
|---|---|---|
| Ollama model names | ✅ auto | queried from `/api/tags` |
| Ollama context length | ✅ auto | `/api/show` → used to clamp `max_tokens` so requests never overflow |
| Ollama size / family | ✅ auto | used to auto-pick the judge (largest member) |
| vLLM / SGLang model names | ✅ auto | `/v1/models` |
| vLLM / SGLang context window | ✅ auto | `max_model_len` from `/v1/models` → clamps `max_tokens` |
| TRT-LLM model names | ✅ auto | `/v1/models` |
| **TRT-LLM context window** | ⚠️ not advertised | TRT-LLM's `/v1/models` omits it; your `max_tokens` is sent as-is — size it yourself |
| Claude / Codex **login state** | ✅ auto | detected; subscription members are added only when logged in |
| Judge model | ✅ auto | largest council member (override with `judge_model`) |
| Claude CLI model list | ⚙️ preset | `opus, sonnet, haiku` from bundled reference data — override with `claude_cli_models` |
| Codex CLI model list | ⚙️ preset | `gpt-5.6-*` from bundled reference data — override with `codex_cli_models` |
| Curated Ollama **cloud** models | ⚙️ preset | a top set from bundled reference data (needs `ollama_tier` pro/max) |
| **Self-hosted server address** | ❌ you set | `vllm_servers` / `trtllm_servers` / `sglang_servers` (`name:host:port`) |
| **API keys** | ❌ you set | `openai_api_key` / `anthropic_api_key` / `groq_api_key` |
| **Subscription tiers** | ❌ you set (has defaults) | `claude_tier` / `chatgpt_tier` / `ollama_tier` — set to your real plan (drives cloud access + concurrency) |
| CLI executable paths | ❌ you set (has defaults) | `claude_cli_path` / `codex_cli_path` if not on `PATH` |

⚙️ **preset** = comes from `config/subscriptions.json`, a checked-in reference file the
CLIs can't enumerate on their own. It's updated by pulling the repo, or override per
install with the `*_models` options.

---

## Asking the council

`ask_council(question, mode)` supports five reconciliation modes:

| Mode | What you get |
|---|---|
| `individual` | Every member's raw answer, side by side. |
| `categorized` | A judge groups answers into **agreement / complementary / conflicting**. |
| `deconflicted` | Iterative loop that re-questions members until conflicts resolve, with a **resolution score**. |
| `pooled` | Delphi-style: members reconsider a neutral, attribution-free pool of answers — divergence is preserved, not averaged away. |
| `dialectic` | thesis → antithesis → synthesis: members defend their pick, the judge builds a pros/cons dossier, members re-select. |

**Attach context or files.** `ask_council` also takes `context` (inline background
text) and `files` (local paths, read and fenced as labelled context for every
member) — e.g. review a snippet of code or a design doc across the whole council:

```
ask_council(question="What's wrong with this auth flow?", mode="dialectic",
            files=["src/auth.ts"], context="This is a public SaaS signup path.")
```
Caps: 256 KB/file, 768 KB total, 20 files (pass an excerpt via `context` for bigger inputs).

**Run it in the background.** A deconfliction/dialectic run over slow local models
can take a while — `ask_council_async` returns a `job_id` immediately so you keep
working, and `get_council_result(job_id)` fetches the answer when ready
(`get_council_result(list=true)` lists recent jobs). Jobs are in-memory and reset
on `/reload-plugins`.

Handy tools & commands:

- `ask_council` — ask the council (modes above; `context` / `files` optional).
- `ask_council_async` / `get_council_result` — background runs + fetch/list.
- `council_status` — detected environment, current members, tiers, per-provider
  concurrency, quota warning. (`/model-council:status` in the Claude Code plugin.)
- `setup_council` — pick subscription tiers interactively.
  (`/model-council:setup` in the plugin.)
- `configure_council` — set/trim members, judge, and default mode (persists across
  restarts).
- `list_models` — everything reachable across all configured providers.
- `get_council_config` — inspect the full current configuration.

---

## Common tweaks

| Want to… | Set |
|---|---|
| Point Ollama at a remote host | `ollama_address` |
| Give slow local models more time | `request_timeout_ms` (ms; default 120000) |
| Review a file / add background | `ask_council(files=[…], context="…")` |
| Not block on a long run | `ask_council_async` → `get_council_result(job_id)` |
| Cap output length | `max_tokens` (auto-clamped down to each server's context) |
| Change default answer style | `response_mode` |
| Pin an exact council | `council_models` (or `configure_council`) |
| Match your real plans | `claude_tier` / `chatgpt_tier` / `ollama_tier` |
| Tune parallelism | `local_concurrency` / `cloud_concurrency` (per-provider limits come from your tiers) |

Members run under **your own** subscription quotas and local hardware — the plugin adds
no backend of its own. See the [README](README.md) for the full option reference,
environment-variable equivalents (for standalone installs), and the deconfliction
algorithm.
