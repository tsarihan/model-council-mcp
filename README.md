# model-council-mcp

An MCP server that routes a question to a **council** of AI models — local (Ollama, vLLM, TRT-LLM, SGLang) and cloud (OpenAI, Anthropic, Groq) — and synthesizes their answers in five configurable modes:

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
- **Code / design review across models** — attach a file (`files=["src/auth.ts"]`) and ask the whole council to critique it; use `context` to add constraints ("must be OWASP-clean").
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

| Option | Purpose | Default |
|---|---|---|
| Ollama address | Base URL of your Ollama server | `http://localhost:11434` |
| Council models | Pin specific models, or leave blank to auto-use all Ollama models | *(empty → auto)* |
| Auto-discover council | Use all Ollama chat models (local + `:cloud`) when none pinned | `true` |
| **Claude tier** | `free` / `pro` / `max5x` / `max20x` — cloud access + Claude concurrency | `pro` |
| **ChatGPT tier** | `free` / `plus` / `pro5x` / `pro20x` — Codex concurrency | `plus` |
| **Ollama tier** | `free` / `pro` / `max` — `free` = local only; `pro`/`max` = cloud + 3/10 concurrency | `pro` |
| Judge model | Categorizer/deconflicter, or `auto` (largest) | `auto` |
| Default response mode | `individual` / `categorized` / `deconflicted` / `pooled` / `dialectic` | `categorized` |
| Max deconfliction rounds | 1–10 | `3` |
| OpenAI / Anthropic / Groq API key | Enable cloud models (stored in keychain) | — |
| vLLM / TRT-LLM / SGLang servers | `name:host:port` entries | — |
| Max response tokens | Tokens per completion | `16000` |
| Cloud concurrency (override) | Optional; caps all cloud pools, overriding the per-tier limits | *(unset → tiers)* |
| Local concurrency | Simultaneous local requests (0 = unlimited) | `1` |
| Completion retries | Retries on an empty/failed response | `3` |

---

## Subscription tiers, auto-population & detection

The council mixes three kinds of member, each gated by a **subscription tier** so it never quietly burns quota you don't have:

| Provider | Tiers | `free` means | Reference file |
|---|---|---|---|
| **Ollama** | `free` / `pro` / `max` | local models only (no `:cloud`) | [`config/subscriptions.json`](config/subscriptions.json) |
| **Claude** (via `claude` CLI) | `free` / `pro` / `max5x` / `max20x` | no Claude members | ″ |
| **ChatGPT** (via `codex` CLI) | `free` / `plus` / `pro5x` / `pro20x` | no ChatGPT/Codex members | ″ |

- **Per-provider concurrency.** Each subscription gets its own concurrency ceiling (e.g. ChatGPT 6, Claude 2, Ollama-cloud 3 on Pro / 10 on Max), so one slow, tightly-rate-limited provider can't starve another. Tier→limit mappings, curated cloud models, and provider model names all live in **`config/subscriptions.json`** — edit it and pull to pick up new plans/models.
- **Detection.** On boot (and on `council_status`) the server checks: is Ollama reachable, does your plan reach `:cloud`, is the `claude` CLI installed **and logged in** (a locked-down probe), is the `codex` CLI **signed in** (`codex login status`). Only usable providers are auto-added; the rest get a hint (e.g. *"Codex CLI installed but not signed in — run `codex login`"*).
- **It persists.** Your tier choices and member edits are saved to `~/.config/model-council/state.json` (override with `MODEL_COUNCIL_STATE`), so they survive plugin reloads.
- **Works standalone too.** The auto-config, `council_status`, and `setup_council` tools all work for a plain `claude mcp add` / MCP-store install; only the SessionStart welcome line and the `/model-council:*` slash commands are Claude-Code-plugin-only sugar.

> Cloud and subscription members run under **your own** subscription quotas via the sanctioned first-party CLIs. `council_status` always shows a quota warning listing which paid providers are in the council. Reusing a subscription *token* against a raw vendor API from a third-party app is a separate, prohibited thing — this plugin does not do that.

---

## Install as a standalone MCP server (npm)

```bash
# Quick try
npx model-council-mcp

# Add to Claude Code
claude mcp add model-council-mcp -s user -- npx -y model-council-mcp
```

Or add to `~/.claude.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "model-council": {
      "command": "npx",
      "args": ["-y", "model-council-mcp"],
      "env": {
        "OLLAMA_ADDRESS": "http://localhost:11434",
        "COUNCIL_MODELS": "ollama:llama3,ollama:mistral",
        "RESPONSE_MODE": "categorized"
      }
    }
  }
}
```

---

## Configuration (environment variables)

### Provider connections

| Variable | Description | Default |
|---|---|---|
| `OLLAMA_ADDRESS` | Ollama server URL | `http://localhost:11434` |
| `OPENAI_API_KEY` | Enables OpenAI models | — |
| `ANTHROPIC_API_KEY` | Enables Anthropic Claude models | — |
| `GROQ_API_KEY` | Enables Groq models | — |
| `VLLM_SERVERS` | vLLM servers (see below) | — |
| `TRTLLM_SERVERS` | TRT-LLM servers | — |
| `SGLANG_SERVERS` | SGLang servers | — |
| `CLAUDE_CLI` | `true` → add subscription-backed Claude members via the local `claude` CLI (no API key) | `false` |
| `CLAUDE_CLI_MODELS` | Model aliases for the CLI member | `opus,sonnet` |
| `CLAUDE_CLI_PATH` | Path to the `claude` binary | `claude` |
| `CODEX_CLI` | `true` → add a subscription-backed ChatGPT member via the local `codex exec` CLI (no API key) | `false` |
| `CODEX_CLI_MODELS` | Model names for the Codex member (`default` = Codex's configured model) | `default` |
| `CODEX_CLI_PATH` | Path to the `codex` binary | `codex` |

### Claude via your subscription (first-party CLI)

Set `CLAUDE_CLI=true` to add council members that run through the locally-installed **Claude Code CLI** (`claude -p`) instead of the Anthropic API. Inference runs under whatever your `claude` CLI is logged in with — typically your own **Claude Pro/Max subscription** — so these members don't consume API credits. They appear as `claude-cli:opus`, `claude-cli:sonnet`, etc.

**Behavior & requirements**
- The `claude` CLI must be installed and logged in (`claude` → `/login`, or `claude setup-token`). Set `CLAUDE_CLI_PATH` if it isn't on `PATH`.
- Each call shells out to `claude -p` with all tools disabled (`--tools ""`), MCP disabled (`--strict-mcp-config`, so it can't recurse into this plugin), and sessions not persisted — a clean single text answer.
- **`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are stripped from the nested call**, because the CLI silently prefers an API key over the subscription. So these members stay subscription-billed even if you also set an API key for the regular `anthropic:` provider.
- They are **not** auto-discovered — add them explicitly via `configure_council` or `COUNCIL_MODELS` (e.g. `claude-cli:opus`), so they don't quietly draw down your subscription.

**Where it works:** anywhere the `claude` CLI actually executes — the Claude Code CLI, or the Claude Desktop app on a machine that also has the CLI. With `/remote-control` on your CLI, driving it from the Claude web/mobile *code* tab still runs `claude -p` on your machine, so it works there too. It does **not** work for a remotely-hosted copy of this server (no local CLI), and it can't borrow the Claude *app's* subscription directly (no client supports MCP sampling yet).

> This uses the sanctioned first-party CLI under your own subscription, for your own use. High-volume automated fan-out can hit your subscription's rate limits — keep `CLOUD_CONCURRENCY` modest (these members use the cloud pool). Reusing a subscription *token* against the raw Anthropic API from a third-party app is a separate thing and is prohibited; this feature does not do that.

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

### Performance & output

| Variable | Description | Default |
|---|---|---|
| `MAX_TOKENS` | Max tokens requested per model completion | `16000` |
| `CLOUD_CONCURRENCY` | Max simultaneous requests to cloud members (Ollama cloud `:cloud`/`-cloud`, OpenAI, Anthropic, Groq). Ollama cloud needs Pro (3 concurrent) or Max (10) | `3` |
| `LOCAL_CONCURRENCY` | Max simultaneous requests to local models; `1` runs them one at a time to avoid contention, `0` = unlimited | `1` |
| `COMPLETION_RETRIES` | Attempts per completion before giving up on an empty/failed response | `3` |
| `DECONFLICT_VERBOSE` | `true` → deconflicted results include per-round detail by default | `false` |

The council queries members in parallel but respects these concurrency limits — cloud members share one pool and local members another, so a large council never exceeds your Ollama cloud plan's concurrent-request cap, and local models can be run sequentially to avoid GPU contention.

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
groq:llama-3.3-70b-versatile
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
  "max_deconflict_rounds": 4
}
```

All fields are optional — only supplied fields are updated.

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

`mode` and `max_deconflict_rounds` override the configured defaults for this call only. In `deconflicted` mode, set `"verbose": true` to include the initial categorization, every member's per-round responses, and the round-by-round re-categorization alongside the final synthesis. In `pooled` mode, `"verbose": true` adds the initial (round-0) raw member responses.

**Attach context / files.** Add `"context"` (inline background text) and/or `"files"` (an array of local file paths). Files are read from disk and fenced with a `----- FILE: <path> -----` header so every member sees them as labelled context alongside the question. Caps: 256 KB/file, 768 KB total, 20 files — for anything larger, pass an excerpt via `context`. A missing/oversized/binary file returns a clear error rather than being silently dropped.

```json
{
  "question": "What's wrong with this auth flow?",
  "mode": "dialectic",
  "files": ["src/auth.ts"],
  "context": "Public SaaS signup path; must be OWASP-clean."
}
```

**Attach images (vision).** Add `"images"` (an array of local png/jpg/jpeg/gif/webp paths) to ask a vision question. Vision support is auto-detected per member with a **two-stage check**, then cached:

1. **Cheap negative prefilter** (per provider): Ollama's `/api/show` `capabilities` field; OpenAI-compatible (vLLM/SGLang/TRT-LLM/OpenAI/Groq) and Anthropic send a real functional probe (a small test image + `max_tokens: 1`, since neither advertises vision via metadata). A "no" here is trustworthy and skips stage 2. `claude-cli`/`codex-cli` have no cheap signal and go straight to stage 2.
2. **Behavioral OCR-challenge confirmation**: a stage-1 "yes" is only trusted once the model has proven it can actually read pixels — it's sent a small, high-contrast rendered image containing a random 4-digit code (10 are pre-generated; the exact code is never in the prompt) and graded on whether its reply contains that exact code. This step exists because a stage-1 "yes" is **not** reliable on its own: some OpenAI-compatible servers accept an `image_url` part and silently ignore it for a non-vision model (confirmed live against a self-hosted SGLang endpoint — 200 OK, fabricated answer), and Ollama's `capabilities` metadata can be stale for custom/quantized builds (MLX conversions, GGUF imports) that dropped the vision projector while the tag still says `vision` (documented upstream: ollama#9967, and reproduced live with a local `-mlx` model that claimed vision support but denied ever receiving an image). Two challenge images are tried per model (pass if either is read correctly) to absorb one unlucky misread; only a clean, non-empty wrong answer counts as a real failure — a timeout or empty response is treated as inconclusive and retried next time, never cached as a false negative.

`codex-cli` attaches images via its first-party `-i/--image` flag (written to a temp file, passed directly — no workaround needed). `claude-cli` has no image flag, so images go to a narrowly-scoped `--tools Read --add-dir <freshTempDir>` (a fresh temp directory containing nothing but the image; `--add-dir` is an enforced permission boundary, verified empirically — a Read attempt outside the granted directory is denied by the CLI itself, not merely discouraged; every other lockdown — no MCP, no other tools, no session persistence — is unchanged, and calls with no images keep the original fully-closed `--tools ""`).

**Only the confirmed vision-capable members are queried** — everyone else is skipped for that call, never receiving the image in any form, correct or garbled. The routing decision is reported back in `visionRouting`. Caps: 8 MB/image, 24 MB total, 6 images. Passing an image to `"files"` (which reads as UTF-8 text) is rejected with a pointer to use `"images"` instead — that's the one other route to sending a model garbled data.

> First vision question against a never-before-verified member costs one extra round trip (the OCR challenge) before the real question is asked — a few seconds for a fast model, longer for a CLI subprocess or a slow local model. The verified result is cached per model **and persisted to disk** (the same state file that already survives restarts for your tiers and council edits), so this cost is paid at most once per model, not once per session — a `/reload-plugins` or server restart does not re-run the OCR challenge for a model already proven (in)capable, which matters most on a slower machine juggling several local models. The detection round also respects the same per-provider concurrency limits as a real question (notably `local`, typically 1) — verifying multiple local Ollama models' vision at once is itself a real completion call per model, and firing them all concurrently can thrash memory on hardware that can only hold one large local model in RAM/VRAM at a time, which previously showed up as genuinely vision-capable local models being (transiently) misreported as not vision-capable under load. In practice, local vision-capable models vary widely in reading accuracy on dense-text screenshots even once verified — Claude/ChatGPT (via `claude-cli`/`codex-cli`) and a properly-sized self-hosted vision model both read fine text/numbers accurately; small local models can pass the OCR challenge while still misreading specifics in a real, denser image. The routing/format guarantee above is unconditional; read quality on your actual question depends on the model you point it at.

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

**Deconfliction score**: `resolved / totalConflicts × 100`.  
100 % means all conflicts resolved; n/m means n conflicts resolved out of m found.

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

Same inputs as `ask_council` (including `context` / `files`), but starts the run in the **background** and returns a `job_id` immediately — so a long deconfliction/dialectic run, or a council with slow local models, doesn't block you.

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
      "command": "npx",
      "args": ["-y", "model-council-mcp"],
      "env": {
        "OLLAMA_ADDRESS": "http://localhost:11434",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "GROQ_API_KEY": "gsk_...",
        "VLLM_SERVERS": "gpu1:192.168.1.10:8000,gpu2:192.168.1.10:8001",
        "SGLANG_SERVERS": "sgl1:192.168.1.30:30000",
        "COUNCIL_MODELS": "ollama:llama3,ollama:mistral,openai:gpt-4o,anthropic:claude-sonnet-4-5,groq:llama-3.3-70b-versatile",
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

**Do I need API keys?** No. Local Ollama and self-hosted servers need none; Claude and ChatGPT members run under your existing subscriptions via the first-party `claude` / `codex` CLIs. API keys are only for the optional OpenAI/Anthropic/Groq cloud members.

**Does it work in Cowork / claude.ai?** No — it executes your local `claude`/`codex` CLIs and reaches localhost/LAN model servers, which cloud-hosted surfaces can't do. Use it in **Claude Code** (plugin) or **Claude Desktop** (standalone MCP).

**Can it review a file, or run without blocking?** Yes — `ask_council` takes `context` / `files`, and `ask_council_async` + `get_council_result` run a council in the background and fetch the result when ready.

**What does "judge" mean?** Categorized / deconflicted / pooled / dialectic modes use one member as the judge that groups, re-questions, or distils the others. It's auto-selected as the largest member; override with `judge_model`.

---

## Privacy & data handling

model-council runs **entirely locally** and stores nothing off your machine. Full policy: [PRIVACY.md](PRIVACY.md).

- **Where your prompts go.** A question is sent only to the model endpoints you configure: your local Ollama server, any self-hosted vLLM/TRT-LLM/SGLang servers, cloud API providers you supply keys for (OpenAI/Anthropic/Groq), and — for subscription members — your own local `claude` / `codex` CLIs. There is no model-council backend and no telemetry; nothing is sent to the author.
- **Credentials.** API keys are stored in your client's secure storage (system keychain) and used only to call the provider you gave them for. Subscription members run under **your own** Claude/ChatGPT login via the first-party CLIs; the server strips `ANTHROPIC_*` / `OPENAI_*` / `CODEX_*` keys from those child processes so inference is billed to your subscription, not an API key.
- **On disk.** The only file written is `~/.config/model-council/state.json` (your selected tiers + council members), plus `~/.codex` / Claude CLI session state owned by those tools. No conversation content is persisted by this server.
- **Subprocesses.** Detection and subscription inference shell out to the locally-installed `claude` and `codex` binaries (read-only sandbox for Codex; MCP/tools disabled for the Claude probe so it can't recurse or take actions).

## Submitting to a directory

This plugin is distributed as a GitHub plugin marketplace (above). To also list it:

- **Community Plugin Marketplace** (`anthropics/claude-plugins-community`) — open a PR; it passes automated validation + safety screening. `claude plugin validate .` must pass (it does).
- **Anthropic Connectors Directory** — submit via the claude.ai admin portal. Checklist: tool annotations (present — `title` + `readOnlyHint` on every tool), the Privacy section above (also linked from the manifest), clear docs, and an explicit disclosure that inference shells out to the user's own local `claude`/`codex` CLIs under their subscription (keys stripped; no third-party backend).

---

## License

Apache License 2.0 — Copyright (c) 2026 Tom Sarihan. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
