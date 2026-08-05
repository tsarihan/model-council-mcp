# Harness capability matrix & capability memory — design

Goal: **zero config, and never fail closed.** A member that *could* work through
some harness must be tried, and what worked must be remembered — rather than
being dropped because we didn't know.

## The two halves (both already have a precedent in this repo)

| Half | Precedent to copy | Lives in |
|---|---|---|
| Shipped knowledge — what we already know works | `config/subscriptions.json` (editable, pullable reference data) | `config/harness-capabilities.json` |
| Learned knowledge — what we probed on this machine | `state.json` `visionCapability` (definitive results only, TTL'd, survives restarts) | `state.json` `harnessCapability` |

Seeded knowledge means we don't probe what we already know; learned knowledge
means an unknown model is tried once and never re-probed. Both are keyed the
same way `visionCapability` already is (model-id label), and the learned map
carries `checkedAt` so a stale "no" expires instead of being sticky forever.

## Harness selection rule

**Always try the claude-cli harness first. Use codex only because the inference
engine cannot speak the Anthropic Messages API — never as a preference.**

That ordering is not stylistic. The claude harness is the one this repo has
actually exercised end to end (repo access, vision, and now web search all run
through it), its tool grants are enforced boundaries we have verified, and one
harness for most members keeps behaviour comparable across a mixed council.
Codex is the compatibility fallback: it reaches OpenAI-compatible engines that
have no `/v1/messages` to point `ANTHROPIC_BASE_URL` at.

So the matrix below is really answering one question per provider — *can this
endpoint speak Anthropic Messages?* If yes, claude-cli. If no, codex-cli with
`wire_api="chat"`. If neither, a flattened completion, reported not dropped.

Note for hosted OpenAI-compatible providers (`openai`, `xai`): the codex custom
provider needs `env_key` naming the variable holding their API key, so those
members bill per token through the harness exactly as they do today.

## Harnesses, in preference order

1. **claude-cli harness** — `ANTHROPIC_BASE_URL=<endpoint>` + `--model <name>`.
   Works against anything serving the Anthropic **Messages** API.
2. **codex-cli harness** — custom provider, for engines serving the OpenAI
   **Responses** API:
   `-c model_provider=mc -c model_providers.mc.base_url=<url>/v1`
   `-c model_providers.mc.wire_api=responses -c model_providers.mc.name=…`
   plus `-c model_providers.mc.env_key=NAME` (a variable NAME, so the secret
   never lands in argv).

   **CORRECTED after live testing.** The documented advice everywhere is
   `wire_api="chat"`. Codex 0.144.6 **rejects it at config load**: *"`wire_api =
   \"chat\"` is no longer supported … set `wire_api = \"responses\"`"*
   ([openai/codex#7782](https://github.com/openai/codex/discussions/7782)). So
   the codex harness reaches an engine only if it serves `/v1/responses` —
   being "OpenAI-compatible" via `/v1/chat/completions` is **not** enough. That
   narrows the fallback a lot, and it is why the matrix tracks
   `openaiResponses` rather than `openaiChat`.
3. **No harness** — single flattened completion. Still answers; reported as
   `fromMemory` rather than silently presented as researched.

## Seed matrix (researched, not assumed)

| Provider | Anthropic `/v1/messages` | OpenAI `/v1/responses` (what codex needs) | Harness |
|---|---|---|---|
| `ollama` | **yes** — verified live (real `thinking` blocks) | **no** — verified live (route does not answer; `/v1/chat/completions` returns 200) | claude-cli (no fallback needed, or possible) |
| `vllm` | **yes** — `entrypoints/anthropic/` registered unconditionally; Claude Code documented | **yes** — documented | claude-cli, codex as fallback |
| `sglang` | **no** — open request (sgl-project/sglang#9594) | unconfirmed → probe | codex-cli, else none |
| `trtllm` | unconfirmed → probe | unconfirmed → probe | claude-cli first, then codex |
| `openai` | no | **yes** (its own API) | codex-cli |
| `xai` | no | unconfirmed → probe | codex-cli, else none |
| `anthropic` (API key) | yes (native) | no | claude-cli |

`null` in the matrix means **unconfirmed, so probe** — never "unsupported".
"We have not checked" is not "it cannot", which is why `trtllm` still tries the
preferred harness first.

Anything absent from this table is **probed**, not refused.

## Probe ladder for an unknown model — BUILT (`src/probe.ts`)

Walks `harnessLadder()` and measures, rather than inspecting endpoints:

1. **Chat probe** per rung — one tiny completion. First rung that answers wins;
   a rung that fails falls through to the next instead of failing the member.
2. **Tool probe**, only when web access is actually wanted (it costs a real
   search). Detects three distinct outcomes: a real answer (`ok`), the model's
   own tool-call markup leaking as text (`leaks`), or a self-reported
   `NOSEARCH` (`unsupported`).
3. Records the outcome — **including a definitive "no harness"**, so a dead
   endpoint is not re-probed on every ask.

**A timeout is never a verdict.** Measured during development: a 45s tool probe
against a local model timed out and was written down as `tools: unsupported`,
permanently condemning a model that was merely slow. Timeouts now record
`untested` (re-probe next time) and the tool budget is 180s. Re-measured after
the fix, the same model returned `tools: ok`. This mirrors the vision cache,
which already refuses to cache inconclusive probes.

**Measured beats seeded.** `rememberedHarness()` is consulted before the matrix,
and a member proven unable to execute tool calls is reported in
`webRouting.fromMemory` rather than `researched` — reporting it as researched
would be the precise false assurance `webRouting` exists to prevent.

## Why tool-calling is probed separately from chat

Chat working does not mean tool-calling works. Verified live in this repo:
`kimi-k3:cloud` through the claude harness answered fine, but at `--effort max`
emitted its **own native tool-call markup as plain text** instead of an
executable call — no search ran. Models differ in tool-call dialect (Qwen's
JSON-style calls, Hermes-style tags, etc.), and the harness only executes calls
it can parse. So the memory stores two independent facts per model:
`chat: ok` and `tools: ok|leaks|unsupported`.

`providers/claude-cli.ts` already refuses a leaked-markup reply; the memory turns
that from a per-call failure into a remembered fact, so the next ask can pick a
different harness for that model instead of repeating the failure.

## Surviving updates

`state.json` is outside the plugin directory (`~/.config/model-council/`), so it
already survives plugin updates — the same reason tiers and `visionCapability`
persist today. The shipped matrix may change under it, so learned entries win
for a model the matrix doesn't mention, and the matrix wins when it names a
model explicitly (it can be corrected by a pull; a stale probe cannot).
