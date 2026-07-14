# model-council-mcp

An MCP server that routes a question to a **council** of AI models — local (Ollama, vLLM, TRT-LLM, SGLang) and cloud (OpenAI, Anthropic, Groq) — and synthesizes their answers in five configurable modes:

| Mode | What you get |
|---|---|
| `individual` | Each model's raw answer, side by side |
| `categorized` | Judge groups responses into **common agreement**, **complementary insights**, and **conflicting positions** |
| `deconflicted` | Iterative loop — judge re-questions the council on each conflict until resolved or rounds exhausted; returns a **deconfliction score** (0–100 %) |
| `pooled` | **Delphi-style** — judge distils all answers into a neutral, deduplicated pool (no counts, no attribution, no ranking); members reconsider against it and answer freshly. No winner is forced, so genuine divergence is **preserved** rather than collapsed by social proof |
| `dialectic` | **Thesis → antithesis → synthesis** — members defend their initial pick and argue why the alternatives aren't better; the judge compiles a balanced **pros/cons dossier** per option; members then re-select a ranked top-3 having weighed both sides |

---

## Install as a Claude Code plugin (recommended)

This repo is a self-contained Claude Code **plugin** — the server is bundled into a single zero-dependency file (`bundle/server.cjs`), so it runs offline against local models with no `npm install` step.

```bash
# 1. Add this repo as a marketplace (from GitHub)
/plugin marketplace add tsarihan/model-council-mcp

# 2. Install the plugin
/plugin install model-council@model-council
```

**Zero-config:** accept the defaults and it just works. With no council models pinned, the council auto-uses **every local Ollama model plus your Ollama `:cloud` models** (embedding models like `bge-m3` are skipped). The judge auto-selects your largest model. Ask a question immediately — no setup.

On install, Claude Code prompts you for the (all-optional) configurable options — Ollama address, whether to pin specific council models, API keys, default mode, deconfliction rounds. Nothing is required. API keys are stored in your system keychain. Change settings any time from `/plugin` → Configure.

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
| Judge model | Categorizer/deconflicter, or `auto` (largest) | `auto` |
| Default response mode | `individual` / `categorized` / `deconflicted` / `pooled` / `dialectic` | `categorized` |
| Max deconfliction rounds | 1–10 | `3` |
| OpenAI / Anthropic / Groq API key | Enable cloud models (stored in keychain) | — |
| vLLM / TRT-LLM / SGLang servers | `name:host:port` entries | — |
| Max response tokens | Tokens per completion | `16000` |
| Cloud / local concurrency | Simultaneous requests (cloud pool / local pool) | `3` / `1` |
| Completion retries | Retries on an empty/failed response | `3` |
| Verbose deconfliction | Include per-round detail in deconflicted results | `false` |
| Claude subscription (CLI) | Use your Claude Pro/Max subscription via `claude -p` (no API key) | `false` |
| ChatGPT subscription (Codex CLI) | Use your ChatGPT subscription via `codex exec` (no API key) | `false` |

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

### `get_council_config`

Returns current council settings plus all configured provider connections and the full env-var reference.

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

## License

Apache License 2.0 — Copyright (c) 2026 Tom Sarihan. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
