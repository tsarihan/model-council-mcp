# Quickstart

`model-council-mcp` fans one question out to a **council of models** — local (Ollama),
self-hosted (vLLM / SGLang / TRT-LLM), your **Claude**, **ChatGPT**, and **Grok**
subscriptions (via the first-party `claude` / `codex` / `grok` CLIs, no API key), and
cloud APIs — then reconciles their answers. It is designed to **just work** the moment
you install it: it auto-discovers what you already have and asks you to configure only
what it can't detect.

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

### 4) Ollama + Grok (your X.AI subscription, via the Grok Build CLI)

- Install xAI's **Grok Build CLI** and log in (`grok`, then follow its sign-in flow).
- Set `grok_tier` to match your plan (`supergrok` · `premiumplus` · `heavy`).

Unlike Claude/ChatGPT, **Grok is opt-in even when the CLI is detected as logged
in** — its tier defaults to `free` (no Grok members) since it's a newer provider added
on top of an existing install base. Set `grok_tier` above `free` and the `grok-4.5`
member is added. Override the model list with `grok_cli_models`.

### 5) Everything — Ollama + Claude + Codex + Grok + vLLM + SGLang + TRT-LLM

Do scenarios 1–4, **plus** point the plugin at your self-hosted OpenAI-compatible
servers. These are the one thing the plugin cannot discover on its own (it doesn't scan
your network), so you name them:

```jsonc
// plugin config (or the matching env vars for a standalone install)
"vllm_servers":   "gpu1:192.168.1.50:8000",            // name:host:port  (port defaults to 8000)
"trtllm_servers": "gpu1:192.168.1.50:8001",            // comma-separate multiple: "a:host:8000,b:host:8001"
"sglang_servers": "gpu2:192.168.1.51:30000"            // port defaults to 30000
```

Optionally add cloud APIs with `openai_api_key` / `anthropic_api_key` / `xai_api_key`.

Once a server is registered, its **models and context windows are auto-discovered** — you
only supplied the address. Then build the exact panel you want:

```
configure_council(models=[
  "vllm/gpu1:my-model",
  "sglang/gpu2:my-model",
  "trtllm/gpu1:my-model",
  "ollama:llama3.1:8b",
  "claude-cli:opus", "claude-cli:sonnet", "claude-cli:haiku",
  "codex-cli:gpt-5.6-sol", "codex-cli:gpt-5.6-luna", "codex-cli:gpt-5.6-terra",
  "grok-cli:grok-4.5"
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
| Claude / Codex / Grok **login state** | ✅ auto | detected; subscription members are added only when logged in |
| Judge model | ✅ auto | largest council member (override with `judge_model`) |
| Claude CLI model list | ⚙️ preset | `opus, sonnet, haiku` from bundled reference data — override with `claude_cli_models` |
| Codex CLI model list | ⚙️ preset | `gpt-5.6-*` from bundled reference data — override with `codex_cli_models` |
| Grok CLI model list | ⚙️ preset | `grok-4.5` from bundled reference data — override with `grok_cli_models` |
| Curated Ollama **cloud** models | ⚙️ preset | a top set from bundled reference data (needs `ollama_tier` pro/max) |
| **Self-hosted server address** | ❌ you set | `vllm_servers` / `trtllm_servers` / `sglang_servers` (`name:host:port`) |
| **API keys** | ❌ you set | `openai_api_key` / `anthropic_api_key` / `xai_api_key` |
| **Subscription tiers** | ❌ you set (has defaults) | `claude_tier` / `chatgpt_tier` / `ollama_tier` / `grok_tier` — set to your real plan (drives cloud access + concurrency; `grok_tier` defaults to `free` — opt-in) |
| CLI executable paths | ❌ you set (has defaults) | `claude_cli_path` / `codex_cli_path` / `grok_cli_path` if not on `PATH` |

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

**Let the council research instead of recall.** `web_access` grants members a live
web search for that call:

```
ask_council(question="Which US steakhouses currently hold three Michelin stars?",
            web_access=true)
```

Off by default. The subscription-CLI members search directly, and a bare `ollama:*`
member is automatically re-pointed through the claude-CLI harness so it can search
too; API-key providers (openai/xai/vllm/…) have no tool loop and still answer from
memory. The result's `webRouting` block names who did which, so a partly-researched
council isn't mistaken for a fully-researched one. It pulls untrusted page content
into the council — see the README before turning it on by default.

**Dial the reasoning depth.** `reasoning_effort` sets how hard every member
*and* the judge think — `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max`:

```
ask_council(question="Design a migration path off this schema.", mode="dialectic",
            reasoning_effort="max")
```

Leave it out and nothing is sent, so each model runs at its own default depth.
Each backend accepts a different slice of the scale, so a level it doesn't take
is **clamped to its nearest supported one, never errored** — `max` runs as
`high` on an Ollama model, `none` as `low` on the Claude CLI — which is what
lets one setting work across a mixed council without dropping members. Set a
persisted default with `configure_council(reasoning_effort=…)` (or the
**Default reasoning effort** plugin option), and pass `"auto"` there to clear it
back to each model's own default. Higher levels cost real time and subscription
quota, multiplied across members × rounds — see the README for the full
per-backend mapping table.

**Know the cost before you spend it — and don't spend it twice.** `estimate_council_cost`
predicts an ask's member completions, judge calls and wall-clock *before* you run it,
calibrated from what each member has actually needed on this machine (members with no
history use defaults and say `measured: false`); it makes no model calls. An **identical
ask repeated within 15 minutes** returns the cached result instantly, marked
`cache: { hit, ageMs }` — pass `no_cache=true` to force a fresh run; degraded or errored
runs are never cached. Background `ask_council_async` jobs now **survive `/reload-plugins`**:
a finished-but-unfetched result is still there afterwards, and a job that was mid-flight
comes back as an explicit `interrupted` error instead of an eternal `running`.

**Reading a result.** Every result carries `usage` (member completions and per-member
wall-clock — what the ask actually spent). With web access on, `webRouting.sources` merges
every URL the members cited, ordered by corroboration, so "3 of 4 members cite AP" is a
fact you can read rather than reconstruct. A conflict whose sides differ in cited backing
carries the judge's `assessment` of which is better supported; `judgeIsMember: true`
discloses a judge that also answered as a member.

**Which round an answer came from (`dialectic`, mainly).** `dialectic` is the one
mode where each member answers *three times* — its opening position, its defense
of that position, and its final ranked re-selection. So every member response
carries a `phase` tag naming the round that produced it, and you never have to
work it out from context:

| `phase` | Round | Modes |
|---|---|---|
| `thesis` | The opening, independent answer | all |
| `antithesis` | Defend your pick, argue the alternatives are worse | `dialectic` |
| `synthesis` | Final ranked re-selection after the pros/cons dossier | `dialectic` |
| `reconsidered` | Fresh answer after seeing the neutral pool | `pooled` |
| `deconflict` | A re-question aimed at the open conflicts (`round` says which pass) | `deconflicted` |

Pass `verbose: true` to get the `thesis` round back alongside the rest. See the
README for why the tag exists on the record rather than just in the field name.

**Attach context or files.** `ask_council` also takes `context` (inline background
text) and `files` (local paths, read and fenced as labelled context for every
member) — e.g. review a snippet of code or a design doc across the whole council:

```
ask_council(question="What's wrong with this auth flow?", mode="dialectic",
            files=["src/auth.ts"], context="This is a public SaaS signup path.")
```
Caps: 256 KB/file, 768 KB total, 20 files (pass an excerpt via `context` for bigger inputs).

**Repo review? Auto-attach a diff instead.** Skip hand-listing changed files — add
`git_ref` and the server runs `git diff` locally and attaches it as context:

```
ask_council(question="Review this diff for bugs and regressions.", mode="categorized",
            git_ref="uncommitted")
```

`git_ref` is `"uncommitted"` (staged + unstaged vs `HEAD` — the usual case),
`"staged"`, `"unstaged"`, or any git revision/range (`"main..HEAD"`,
`"HEAD~3..HEAD"`). `git_repo` defaults to the server's working directory
(normally your project root in a Claude Code plugin session) — set it
explicitly if that's not where your repo is. Errors clearly on a bad ref
(including anything that looks like a git option rather than a revision —
rejected outright), a non-repo path, no changes, or a diff too large to attach
(> 512 KB — narrow the range or use `files` instead). Note: won't show
brand-new untracked files, same as plain `git diff`. This doesn't give any
council member live git access — it's a local `git diff` read on the server's
own machine, same trust model as `files`.

**Reviewing the whole repo, not just a diff?** `full_repo_access: true` grants
`claude-cli`/`codex-cli` members repo exploration for that call — but the two
enforce it differently. `claude-cli` gets `Read`/`Grep`/`Glob` **confined** to
the repo root (`--add-dir` is a real enforced boundary, verified empirically).
`codex-cli` points its working directory at the real repo instead of an empty
one, but stays in its `read-only` sandbox — which blocks all writes everywhere,
but does **not** confine reads to the repo (verified live: it can read any
file the OS user can read, anywhere on the machine — that's pre-existing
behavior of every codex-cli call, not something this mode adds; it's told to
stay in the repo root as a soft, unenforced guardrail). **⚠️ This is a real
permission grant** — off by default, and the calling agent should confirm with
the user before setting it true for an interactive request (autonomous use is
fine for an unattended review step you already control, e.g. end-of-workflow).
Other members (`openai`/`anthropic`/`xai`/`ollama`/self-hosted, `grok-cli`) are
unaffected — no filesystem access to grant. Neither member can write or run
mutating commands. The granted root is validated the same way `git_ref` is
(must be a real git repository) before anything is granted.

```
ask_council(question="Review the whole repo: architecture, risky areas, what you'd improve.",
            mode="individual", full_repo_access=true)
```

**Ask a vision question.** Add `images` (local png/jpg/jpeg/gif/webp paths) and the
plugin auto-detects which configured members can actually see, with a two-stage
check: a cheap prefilter (Ollama's `/api/show` capabilities, a functional probe for
self-hosted/cloud OpenAI-compatible and Anthropic members) trusted only as a
**negative**, then a behavioral OCR-challenge confirmation — the model is shown a
small rendered image with a random 4-digit code and graded on whether it reads it
back correctly — before a "yes" is trusted. This catches two real failure modes:
a server accepting an image request without the model actually reading it, and
Ollama capability metadata that's stale for custom/quantized builds. `codex-cli`
uses its native `-i` image flag; `grok-cli` passes a native `image` content block
via `--prompt-json`; `claude-cli` has no image flag, so the image goes to a fresh
temp dir with a narrowly-scoped, permission-enforced `Read`. **Only vision-capable
members are queried**; the rest are skipped and reported in the result's
`visionRouting`:

```
ask_council(question="What does this chart show?", images=["/Users/me/chart.png"])
```
Caps: 8 MB/image, 24 MB total, 6 images. The OCR-challenge check runs once per
member (cached after) — the first vision question against a given member costs
one extra round trip. In practice, small local vision models vary a lot in
reading accuracy on dense text/screenshots even once verified (they may engage
with the image but misread specifics); Claude/ChatGPT/Grok
(`claude-cli`/`codex-cli`/`grok-cli`) and a properly-sized self-hosted vision
model both read fine text accurately.

**Run it in the background.** A deconfliction/dialectic run over slow local models
can take a while — `ask_council_async` returns a `job_id` immediately so you keep
working, and `get_council_result(job_id)` fetches the answer when ready
(`get_council_result(list=true)` lists recent jobs). Jobs are in-memory and reset
on `/reload-plugins`.

Handy tools & commands:

- `ask_council` — ask the council (modes above; `context` / `files` / `git_ref` / `full_repo_access` / `images` optional).
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
| Review a diff (repo review) | `ask_council(git_ref="uncommitted")` |
| Review the whole repo (⚠️ real permission grant) | `ask_council(full_repo_access=true)` |
| Ask about an image | `ask_council(images=[…])` — routed only to vision-capable members |
| Not block on a long run | `ask_council_async` → `get_council_result(job_id)` |
| Have the council research instead of recall | `ask_council(web_access=true)` |
| Price an ask before running it | `estimate_council_cost(mode=…, web_access=…)` — free, no model calls |
| Force a fresh run past the repeat cache | `ask_council(no_cache=true)` |
| Run several Claude Code sessions at once | set `COUNCIL_SESSIONS` to your usual count — subscription concurrency is shared, not multiplied |
| Members' web research feels serialized | `configure_council(harness_tool_concurrency=16)` — parallel tools inside one claude-cli member (seeded 16; overrides any throttle inherited from your own session) |
| Pin one slow member's effort below the rest | `ask_council(member_efforts={"gpt-5.6-sol": "medium"})` — per-model beats per-call beats default |
| Cap output length | `max_tokens` (auto-clamped down to each server's context) |
| Make the council think harder (or cheaper) | `reasoning_effort` on `ask_council`, or `configure_council(reasoning_effort=…)` for a persisted default |
| Change default answer style | `response_mode` |
| Pin an exact council | `council_models` (or `configure_council`) |
| Match your real plans | `claude_tier` / `chatgpt_tier` / `grok_tier` / `ollama_tier` |
| Tune parallelism | `local_concurrency` / `cloud_concurrency` (per-provider limits come from your tiers) |

Members run under **your own** subscription quotas and local hardware — the plugin adds
no backend of its own. See the [README](README.md) for the full option reference,
environment-variable equivalents (for standalone installs), and the deconfliction
algorithm.
