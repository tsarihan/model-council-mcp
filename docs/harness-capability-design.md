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
2. **codex-cli harness** — custom provider, for OpenAI-compatible endpoints:
   `-c model_provider=mc -c model_providers.mc.base_url=<url>/v1`
   `-c model_providers.mc.wire_api=chat -c model_providers.mc.name=…`
   `wire_api=chat` is REQUIRED: codex's default provider assumes the Responses
   API, which most self-hosted servers do not serve.
3. **No harness** — single flattened completion. Still answers; reported as
   `fromMemory` rather than silently presented as researched.

## Seed matrix (researched, not assumed)

| Provider | Anthropic `/v1/messages` | OpenAI `/v1/chat/completions` | Preferred harness |
|---|---|---|---|
| `ollama` | **yes** — verified live in this repo (real `thinking` blocks returned) | yes | claude-cli |
| `vllm` | **yes** — `vllm/entrypoints/anthropic/` registered unconditionally; documented for Claude Code | yes | claude-cli |
| `sglang` | **no** — open feature request (sgl-project/sglang#9594) | yes | codex-cli |
| `trtllm` | not found — assume no until probed | yes | codex-cli |
| `openai` / `xai` | no | yes | codex-cli |
| `anthropic` (API key) | yes (native) | no | claude-cli |

Anything absent from this table is **probed**, not refused.

## Probe ladder for an unknown model

Cheap capability check first, then a real call:

1. `GET <base>/v1/messages` shape check → if plausible, try the claude harness.
2. Else `GET <base>/v1/models` → try the codex harness with `wire_api=chat`.
3. One tiny real completion through the chosen harness ("reply OK"), plus — when
   the caller wants web access — one tool-call probe, because *tool-calling* is
   the capability that actually varies (see below).
4. Record the winner (or a definitive "no harness") in `harnessCapability`.

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
