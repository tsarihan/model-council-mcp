# model-council-mcp

An MCP server that routes a question to a **council** of AI models — local (Ollama, vLLM, TRT-LLM, SGLang) and cloud (OpenAI, Anthropic, Groq) — and synthesizes their answers in three configurable modes:

| Mode | What you get |
|---|---|
| `individual` | Each model's raw answer, side by side |
| `categorized` | Judge groups responses into **common agreement**, **complementary insights**, and **conflicting positions** |
| `deconflicted` | Iterative loop — judge re-questions the council on each conflict until resolved or rounds exhausted; returns a **deconfliction score** (0–100 %) |

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
| Default response mode | `individual` / `categorized` / `deconflicted` | `categorized` |
| Max deconfliction rounds | 1–10 | `3` |
| OpenAI / Anthropic / Groq API key | Enable cloud models (stored in keychain) | — |
| vLLM / TRT-LLM / SGLang servers | `name:host:port` entries | — |
| Max response tokens | Tokens per completion | `16000` |
| Cloud / local concurrency | Simultaneous requests (cloud pool / local pool) | `3` / `1` |
| Completion retries | Retries on an empty/failed response | `3` |
| Verbose deconfliction | Include per-round detail in deconflicted results | `false` |

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
| `RESPONSE_MODE` | `individual` \| `categorized` \| `deconflicted` | `categorized` |
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

`mode` and `max_deconflict_rounds` override the configured defaults for this call only. In `deconflicted` mode, set `"verbose": true` to include the initial categorization, every member's per-round responses, and the round-by-round re-categorization alongside the final synthesis.

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
