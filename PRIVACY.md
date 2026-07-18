# Privacy Policy

**Effective date:** 2026-07-18
**Applies to:** the `model-council` Claude Code plugin and the `model-council-mcp` standalone MCP server (the "Software").

model-council runs **entirely on your own machine**. It has no backend service, no
analytics, and no telemetry. The author receives nothing — no prompts, no responses, no
usage data, no crash reports.

## What data the Software handles

- **Your prompts and the models' responses** are sent only to the model endpoints **you**
  configure: your local Ollama server, any self-hosted vLLM / SGLang / TensorRT-LLM
  servers, cloud API providers you supply keys for (OpenAI / Anthropic / Groq), and — for
  subscription members — your own locally installed `claude` and `codex` CLIs. Each
  provider processes that data under **its own** privacy policy. There is no
  model-council intermediary.
- **Credentials.** API keys are read from your MCP client's configuration / secure
  storage and used only to call the provider you supplied them for. Subscription members
  run under **your own** Claude and ChatGPT logins via the first-party CLIs; the Software
  strips `ANTHROPIC_*`, `OPENAI_*`, and `CODEX_*` environment variables from those child
  processes so inference is billed to your subscription rather than to an API key.

## What is stored on disk

- `~/.config/model-council/state.json` — your selected subscription tiers and chosen
  council members. This is the only file the Software itself writes. It contains no
  conversation content.
- Session state owned by the `claude` / `codex` CLIs (e.g. `~/.codex`) is managed by
  those tools, not by this Software.

Nothing is transmitted off your machine except the model requests you initiate to the
endpoints you configured.

## Subprocesses

Environment detection and subscription inference shell out to the locally installed
`claude` and `codex` binaries. The Codex probe runs read-only; the Claude probe runs with
MCP and tools disabled so it cannot recurse or take actions on your system.

## Data sharing and third parties

The author does not collect, receive, sell, or share any of your data — there is no
mechanism by which it could. The only third parties involved are the model providers
**you** explicitly configure, each governed by its own terms and privacy policy.

## Changes

Updates to this policy are published in this file in the public repository.

## Contact

Questions: **tsarihan@gmail.com** · Issues:
<https://github.com/tsarihan/model-council-mcp/issues>
