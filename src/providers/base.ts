import { ModelInfo, ServerConfig } from '../types.js';
import { ReasoningEffort } from './effort.js';

/** A single image attached to a user message, decoded to base64 + its MIME type. */
export interface ChatImage {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Images attached to this message (user messages only). Providers that don't
   *  support vision simply never read this field, so it is always safe to set —
   *  the real guarantee against sending images to a non-vision model is that the
   *  orchestrator only attaches `images` to members already confirmed vision-capable. */
  images?: ChatImage[];
}

/**
 * A small (32×32), hand-built, metadata-free PNG used to functionally probe
 * whether a model/endpoint accepts image input. Deliberately NOT 1×1 — some
 * vision preprocessors enforce a minimum decoded size and would reject a 1×1
 * image even on a genuinely vision-capable model, producing a false negative.
 */
export const PROBE_IMAGE_BASE64 =
  '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';

/**
 * Neutralize `@<path>` file-MENTION syntax before a prompt is handed to an
 * agentic CLI (claude / grok / codex).
 *
 * VERIFIED LIVE, and severe: `claude -p --tools '' --strict-mcp-config` with NO
 * `--add-dir` still read an arbitrary file whose absolute path appeared in the
 * prompt as `@/tmp/x/secret.txt`, returning its contents with
 * `permission_denials: []`. The CLI expands mentions CLIENT-SIDE, before and
 * outside the tool-permission system, so `--tools ''`/`--add-dir` — the entire
 * lockdown this provider documents — does not apply to them.
 *
 * That matters here because prompts routinely carry UNTRUSTED text: member
 * responses interpolated into judge prompts, `context`/`files`/git-diff
 * attachments, and (under full_repo_access) repo file contents. Any of those
 * containing `@~/.ssh/id_rsa` would exfiltrate it into a council answer.
 *
 * Fix: insert a zero-width space (U+200B) after the `@` of anything path-shaped,
 * which breaks mention parsing while leaving the text visually identical and
 * fully readable to the model (verified: the same prompt then returns "I cannot
 * access ... the Read tool is not enabled", i.e. no client-side expansion and
 * the permission system back in control).
 *
 * Deliberately narrow: only `@` followed by a path-shaped token (contains `/`,
 * or starts with `~`/`.`). Plain `@Override`, `@user`, and `name@example.com`
 * are left untouched. A scoped package like `@scope/pkg` does pick up an
 * invisible character — an acceptable cosmetic cost versus arbitrary file read.
 */
export function neutralizeFileMentions(text: string): string {
  if (!text) return text;
  // A file MENTION starts a token: `@` at the start of input or after
  // whitespace/an opening delimiter. An EMAIL's `@` is preceded by a word
  // character (bob@example.com), so the lookbehind alone separates the two —
  // which is what lets the path shape stay broad without eating addresses.
  //
  // Path shapes covered: absolute/relative/home (`/x`, `./x`, `~/x`), any token
  // containing a POSIX or Windows separator, AND a bare `name.ext` — the last of
  // these matters because the CLI resolves a bare filename against its cwd, so
  // `@credentials.json` is a real read even with no slash in it.
  //
  // DOUBLE-@ (`@@/path`): the lookbehind previously also excluded `@`
  // (`(?<![\w@])`) to avoid neutralizing the second `@` of a `@@` pair. But
  // that left `@@/path` wholly un-neutralized: the first `@`'s lookahead saw
  // `@`, not a path shape, so it did not match; and the second `@` was then
  // blocked by the lookbehind — so a live `@/path` mention survived inside
  // `@@/path`. (Any `@@path` where the first `@` is preceded by a word char
  // — `foo@@bar.txt` — was already a bypass for the same reason.) The fix has
  // two halves: (1) the lookahead now ALSO accepts `@` followed by any of the
  // same path shapes (`@[~./\\]`, `@[\w.\-:]*[/\\]`, …) so the first `@` of a
  // `@@/path` pair matches; (2) the lookbehind is narrowed to `(?<!\w)` (no
  // `@`), so the second `@` — now preceded by the first `@`, not a word char —
  // matches the ORDINARY path alternation on the same pass. Both `@`s end up
  // broken. A `@@` NOT followed by a path shape (`@@channel`) still matches
  // neither the `@`-prefixed nor the ordinary path alts, so it is left
  // untouched; and an email's `@` is still blocked by the word char before it.
  //
  // BARE SECRET FILENAMES (round 20, kimi): a plain single-word, extensionless
  // filename with no `_`/`-` and not in the well-known list (`@secrets`,
  // `@token`, `@key`, `@credentials`, …) matched NONE of the alts above, so it
  // stayed live. This is NOT an exploitable out-of-scope escape — the CLI
  // provider always pins cwd to an empty temp dir (or the granted repo root
  // under full_repo_access), so `@secrets` resolves to nothing (or to an
  // in-scope repo file), never to an arbitrary system file (deepseek verified
  // this containment in round 19). But neutralization is defense-in-depth and
  // must not lean on a single layer, so the common secret bare filenames are
  // added to the extensionless well-known list (alongside Makefile/LICENSE/…),
  // matching them the same way. Common decorators/handles (`@Override`,
  // `@Bean`, `@property`, `@tom`) are NOT secret filenames and stay untouched.
  return text.replace(
    /(?<!\w)@(?=[~./\\]|[\w.\-:]*[/\\]|[\w-]+\.[A-Za-z0-9]{1,8}(?![\w-])|(?:Makefile|Dockerfile|Procfile|Rakefile|Gemfile|Jenkinsfile|CMakeLists|LICENSE|README|CHANGELOG|Cargo|secrets|secret|token|tokens|credentials|credential|password|passwd|otp|apikey|key|keys)\b|[A-Za-z0-9]+[_-][\w-]*(?![\w-]*@)|@[~./\\]|@[\w.\-:]*[/\\]|@[\w-]+\.[A-Za-z0-9]{1,8}(?![\w-])|@(?:Makefile|Dockerfile|Procfile|Rakefile|Gemfile|Jenkinsfile|CMakeLists|LICENSE|README|CHANGELOG|Cargo|secrets|secret|token|tokens|credentials|credential|password|passwd|otp|apikey|key|keys)\b|@[A-Za-z0-9]+[_-][\w-]*(?![\w-]*@))/g,
    '@​',
  );
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** If true, response MUST be valid JSON */
  jsonMode?: boolean;
  /**
   * JSON Schema for SCHEMA-CONSTRAINED decoding, where the surface supports it
   * (Ollama `format:<schema>`, OpenAI-compatible `response_format.json_schema`).
   * This is strictly stronger than `jsonMode`: json-mode only guarantees
   * PARSEABLE JSON, and a judge under json-mode was observed live returning a
   * valid JSON *schema* instead of an answer. Constrained decoding makes the
   * shape itself unrepresentable-if-wrong.
   *
   * Support, verified against docs + measured live:
   *   - Ollama LOCAL: `format: <schema>` (XGrammar), v0.3.0+ — true constraint.
   *   - Ollama `:cloud`: NOT supported — the proxy silently drops it, so even
   *     `format:'json'` is a no-op (measured on 0.32.4; matches Ollama's own
   *     docs: "Ollama's Cloud service does not currently support structured
   *     outputs"). These fall back to the parse+shape guard.
   *   - OpenAI / vLLM: `response_format.json_schema` — true constraint. We send
   *     `strict: false` deliberately: `strict: true` additionally REQUIRES
   *     `additionalProperties: false` throughout, which these schemas don't set
   *     and which some OpenAI-compatible servers reject outright.
   *   - SGLang: works, but is documented to fail SILENTLY when the model has
   *     reasoning enabled (constrained text lands in `reasoning_content`,
   *     leaving `content` empty) — another reason the parse+shape guard stays.
   *   - CLI providers (claude/codex/grok): no constrained decoding at all.
   *     (`claude --json-schema` is POST-HOC validation, not constraint.)
   * Surfaces without it simply omit the field and rely on the parse+shape guard.
   */
  jsonSchema?: Record<string, unknown>;
  /** Per-attempt wall-clock timeout (ms). Bounds a hung server/subprocess. */
  timeoutMs?: number;
  /**
   * How much reasoning to ask the model for, on the council's own canonical
   * scale (`none` … `max` — see providers/effort.ts). Every provider honours
   * it through whatever knob its backend exposes:
   *   - claude-cli:  `--effort <level>`
   *   - codex-cli:   `-c model_reasoning_effort=<level>`
   *   - grok-cli:    `--reasoning-effort <level>`
   *   - ollama:      `think: <level>` (or `think: false` for `none`)
   *   - openai/vllm/trtllm/sglang: `reasoning_effort`
   *   - anthropic:   extended thinking with a derived `budget_tokens`
   * A level the backend doesn't support is CLAMPED to its nearest supported
   * one (clampEffort) rather than erroring the member — the whole point is
   * that one council-wide setting works across a mixed council. Undefined
   * (the default) sends nothing at all, leaving each model at its own default.
   */
  effort?: ReasoningEffort;
  /**
   * Absolute repo root to grant repo exploration access to, for the CLI
   * providers that support it — enforced DIFFERENTLY per provider:
   *   - claude-cli: Read/Grep/Glob CONFINED to this root via --add-dir, a
   *     real enforced boundary (verified empirically — a Read attempt
   *     outside it is denied by the CLI itself).
   *   - codex-cli: --cd points its working root here, but its read-only
   *     sandbox does NOT confine reads to it — it can read any file the OS
   *     user can read, anywhere on the machine (verified live; this is
   *     pre-existing codex-cli behavior, not added by this option — only
   *     writes are blocked, everywhere, regardless of this value).
   * Undefined (the default) keeps a provider fully locked down as before.
   * Providers that don't support this (everything except claude-cli/
   * codex-cli) simply ignore it — they have no filesystem/tool concept to
   * grant in the first place.
   */
  fullRepoAccess?: string;
}

/** Default per-attempt completion timeout when a caller supplies none. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;

/** Whether an error looks like a request/subprocess timeout (so callers can skip retrying it). */
export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'APIConnectionTimeoutError') return true;
  return /\btimed out\b|\btimeout\b/i.test(String((err as { message?: string }).message ?? err));
}

/**
 * Raised (or detected) when a provider refuses because the user's QUOTA / rate
 * limit is exhausted, rather than because anything is wrong with the request.
 *
 * This is an ordinary production case for a subscription-billed council — every
 * CLI provider here runs on the user's own plan — and it needs its own handling
 * for two reasons:
 *   1. RETRYING IS POINTLESS AND COSTLY. The generic retry path made 3 attempts
 *      with backoff, so one exhausted plan burned three calls and seconds of
 *      wall-clock per member, per round.
 *   2. IT MUST BE LEGIBLE. A quota refusal is not a bug in the council or a bad
 *      answer, and it must not be mistaken for one. (It fooled this project's own
 *      verification twice: a grok probe returned the usage-limit error and the
 *      run *looked* like the security fix had worked.)
 * A quota-failed member is also a partial outage, so the council already marks
 * the result judgeDegraded rather than reporting clean convergence over a
 * silently-shrunken council.
 */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/**
 * PERMANENT exhaustion signatures only — the plan/credits are used up and the
 * same call will fail identically for the rest of the session.
 *
 * Deliberately EXCLUDES a bare HTTP 429 / "rate limit" / "too many requests":
 * those are TRANSIENT throttling that a backoff retry is expected to clear, and
 * treating them as permanent (the first version of this did) silently disables
 * legitimate retries — turning a momentary slow-down into a failed member. Note
 * OpenAI's `insufficient_quota` arrives AS a 429 but says "quota" in the body,
 * so the message patterns still classify it correctly as permanent.
 */
const QUOTA_EXHAUSTED_PATTERNS = [
  /\busage limit\b/i,                 // grok "reached your free Grok Build usage limit", claude CLI
  /\bquota\b/i,                       // OpenAI insufficient_quota / "exceeded your current quota"
  /\bcredit balance is too low\b/i,   // Anthropic billing
  /\bout of credits?\b/i,
  /\bbilling\b.*\b(hard limit|required)\b/i,
  /\bplan limit\b|\bupgrade to\b.*\b(continue|higher)\b/i,
];

/**
 * Is this a PERMANENT quota/credit exhaustion (as opposed to transient
 * throttling)? Message-based rather than status-based, because the CLI
 * providers return their refusal as ordinary JSON/stderr text with no status
 * code at all — and because the status alone (429) cannot distinguish
 * "slow down" from "you are out of credits".
 */
export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof QuotaExceededError) return true;
  const e = err as { status?: number; message?: string };
  const msg = String(e.message ?? err);
  // Several APIs (Google/Gemini among them) use the word "quota" for a
  // PER-MINUTE throttle — "Quota exceeded for quota metric … per minute, retry
  // after 30s". That is transient, so an unrestricted /\bquota\b/ classified it
  // permanent and killed the retries that would have cleared it. Anything that
  // tells the caller to wait or names a time window is throttling, not exhaustion.
  if (/\bper[- ]?(minute|second|hour|day)\b|\bretry after\b|\btry again\b|\btemporarily\b|\bslow down\b/i.test(msg)) {
    return false;
  }
  return QUOTA_EXHAUSTED_PATTERNS.some(re => re.test(msg));
}

/**
 * Transient throttling: retry with backoff (the default path already does).
 * Exposed so a provider/caller can tell the two apart when reporting.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || isQuotaError(err)) return false;
  const e = err as { status?: number; message?: string };
  if (e.status === 429) return true;
  return /\brate[ _-]?limit|\btoo many requests\b|(?<!\d)429(?!\d)/i.test(String(e.message ?? err));
}

/** Ceiling for a single CLI subprocess's accumulated stdout/stderr — see CappedBuffer. */
export const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Accumulates a spawned CLI subprocess's stdout/stderr with a hard ceiling, so
 * a runaway or misbehaving configured executable (a bad `--command`/`_PATH`
 * override, or one that goes into an infinite-output loop) can't grow an
 * unbounded in-memory string and exhaust server memory the way `str += chunk`
 * does with no cap. Every legitimate response here is bounded well under this
 * ceiling by `maxTokens`; once hit, further chunks are silently dropped rather
 * than killing the process — the caller's existing JSON-parse/shape checks
 * already turn truncated output into a clear error.
 */
export class CappedBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private readonly cap: number;

  constructor(cap: number = MAX_CLI_OUTPUT_BYTES) {
    this.cap = cap;
  }

  append(chunk: string): void {
    if (this.bytes >= this.cap) return;
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    // A single chunk larger than the remaining budget must be TRUNCATED, not
    // appended whole — otherwise one oversized chunk (a CLI can write however
    // much it wants to a pipe in one write()) blows straight past the cap,
    // silently defeating the "hard" bound this class exists to guarantee.
    if (this.bytes + chunkBytes <= this.cap) {
      this.chunks.push(chunk);
      this.bytes += chunkBytes;
      return;
    }
    const remaining = this.cap - this.bytes;
    // Slice by BYTES, not JS string length (chunk may contain multi-byte
    // UTF-8 chars) — truncate at the last full character boundary.
    const buf = Buffer.from(chunk, 'utf8').subarray(0, remaining);
    this.chunks.push(buf.toString('utf8'));
    this.bytes = this.cap;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

/**
 * Reasoning models emit their chain-of-thought wrapped in a reasoning tag.
 * Some wrap it fully; others emit only the closing tag (the opening is implicit,
 * so the reasoning is everything before it). Strip both shapes so callers get
 * just the answer. Text with no such tag is returned trimmed but unchanged.
 *
 * Covers the two tag names actually seen in the wild — `<think>` (DeepSeek,
 * Qwen, nemotron, most local reasoners) and `<thinking>` (Anthropic-style, some
 * OpenAI-compatible builds) — since a member that emits `<thinking>…</thinking>`
 * inline in its content would otherwise leak its whole chain-of-thought into the
 * answer shown to the council. (Ollama returns reasoning in a separate
 * `message.thinking` field, handled at that layer, not here.)
 */
const REASON_TAG = 'think|thinking';
export function stripThinkBlocks(text: string): string {
  if (!text) return text;
  // If the reply is ALREADY a structured JSON object/array, leave it completely
  // alone. The stripping below is a text heuristic with no notion of JSON
  // structure: when the tags appear inside two DIFFERENT string VALUES — e.g. a
  // judge summarising a council that discussed reasoning tags, which is exactly
  // what happens when this very repo is under review — the non-greedy delete
  // spans the structural JSON between them (quotes, field names, brackets) and
  // destroys the object. Verified: it produces unparseable output, so a
  // perfectly good judge answer is thrown away and the run is marked
  // judgeDegraded (safe direction, but real data loss). A pure JSON reply has no
  // chain-of-thought to strip in the first place — reasoning models emit CoT
  // either outside the JSON (still handled, since that text doesn't parse) or in
  // a separate field (Ollama's `message.thinking`, handled at that layer).
  // Check the fence-stripped text too: a judge commonly wraps its JSON in
  // ```json … ```, and a guard that only looks at a RAW leading brace missed
  // that entirely — so a fenced reply whose string VALUES mention reasoning tags
  // was still spliced apart. Return the ORIGINAL text (fences and all) when the
  // payload is structured JSON; the judge parsers strip fences themselves.
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  for (const candidate of [trimmed, unfenced]) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      const v = JSON.parse(candidate);
      if (v !== null && typeof v === 'object') return trimmed;
    } catch { /* not valid JSON → try the next form, then strip as before */ }
  }
  // Remove complete <tag>…</tag> blocks (tag name matched case-insensitively).
  let out = text.replace(new RegExp(`<(?:${REASON_TAG})>[\\s\\S]*?</(?:${REASON_TAG})>`, 'gi'), '');
  // Handle a dangling closing tag (chain-of-thought with no opening tag):
  // everything up to and including the final closing tag is reasoning.
  const m = out.match(new RegExp(`</(?:${REASON_TAG})>(?![\\s\\S]*</(?:${REASON_TAG})>)`, 'i'));
  if (m && m.index !== undefined) {
    const after = out.slice(m.index + m[0].length);
    // The dangling-closer heuristic assumes the ANSWER FOLLOWS the tag ("all the
    // reasoning, then </think>, then the answer"). When nothing follows, that
    // assumption is inverted — the answer came FIRST and a stray closer trailed
    // it — and slicing would delete the entire reply (measured: a valid judge
    // JSON followed by "\n</think>" reduced to ""). Keep what precedes and drop
    // just the tag in that case.
    out = after.trim() ? after : out.slice(0, m.index);
  }
  return out.trim();
}

/**
 * Extract a single JSON object from model output that may wrap it in prose or a
 * markdown fence. Finds the FIRST `{` and its BALANCED matching `}` — respecting
 * string literals and escapes — rather than the last `}` in the whole string.
 * A judge that appends explanatory text CONTAINING a brace (e.g. "…{json}\nLet
 * me know if you'd like {more}") is a common, reproducible behaviour that the
 * old `indexOf('{')..lastIndexOf('}')` slice would over-capture, breaking
 * JSON.parse and spuriously degrading an otherwise-valid judge result. Falls
 * back to the widest slice if no balanced object is found (a genuinely truncated
 * object still gets its best chance).
 */
/**
 * Throw unless `v` is a plain object whose REQUIRED fields are present AND of
 * the required type.
 *
 * jsonMode (where it exists) only guarantees PARSEABLE JSON, not the expected
 * SHAPE — and the default CLI judges have no structured-output mode at all — so
 * a judge can return valid JSON that silently produces a fabricated
 * 100%-consensus result with no judgeDegraded flag. Three distinct shapes do it,
 * all seen in review:
 *   1. WRONG CONTAINER — a wrapper `{"analysis":{…}}`, a bare array `[{…}]`
 *      (sliceBalancedJson extracts the first inner object), or a scalar.
 *   2. MISSING the decisive key — e.g. `{"commonAgreement":"all agree"}` with no
 *      `conflicting` at all. A presence-of-ANY-key check accepts this.
 *   3. WRONG TYPE on the decisive key — e.g. `{"conflicting":"none"}`. The key is
 *      present, so a presence-only check accepts it, and the caller's
 *      `Array.isArray(…) ? … : []` guard then coerces it to empty.
 * In every case the conflict list ends up `[]` and the council reports perfect
 * convergence that never happened. Requiring the decisive field to be present
 * AND correctly typed routes all three through the caller's judge-failure
 * fallback (judgeDegraded) instead.
 */
export function assertJsonShape(v: unknown, required: Record<string, 'array'>): void {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('judge JSON has an unexpected top-level shape');
  }
  for (const [key, kind] of Object.entries(required)) {
    const val = (v as Record<string, unknown>)[key];
    if (kind === 'array' && !Array.isArray(val)) {
      throw new Error(
        `judge JSON: required field "${key}" is ${val === undefined ? 'missing' : 'not an array'}`,
      );
    }
  }
}

/**
 * Every top-level balanced `{…}` object in `text`, in order (string/escape
 * aware). A judge often emits more than one: the DEFAULT judges are CLI
 * subprocesses with no structured-output mode, so they're prone to
 * "here is the schema I'll use: {…schema…} and here is my answer: {…}" —
 * reproduced live. An extractor that takes the FIRST object then parses the
 * SCHEMA ECHO instead of the answer, and because a schema example has
 * `conflicting` as an array it passes the shape check and yields garbage
 * conflicts. Enumerating candidates lets the caller pick the right one.
 */
export function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;      // unterminated — nothing further is parseable
    out.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

/**
 * Parse a judge reply into a shape-valid object, tolerating markdown fences,
 * prose around the JSON, and multiple JSON objects in one reply.
 *
 * Candidates are tried LAST-first: the instruction to emit JSON is the final
 * thing the judge reads, so the real answer is the last JSON in the reply,
 * while a schema echo or worked example precedes it. Combined with the shape
 * check, this rejects both the decoy-preamble case and trailing prose. Throws
 * when nothing shape-valid is present, so callers route it through their
 * existing judgeDegraded fallback rather than acting on a fabricated result.
 */
/**
 * Does this parsed object look like an ECHO of the schema we asked for, rather
 * than an answer? Our judge prompts show the schema with angle-bracket
 * placeholders ("<summary of what all/most models agree on>"), and weak-JSON
 * CLI judges sometimes restate it before answering. A JSON-Schema document
 * (`type`/`properties`) is the other shape seen live. Neither is an answer.
 */
function looksLikeSchemaEcho(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.type === 'string' && o.properties && typeof o.properties === 'object') return true;
  let placeholders = 0, strings = 0;
  const walk = (x: unknown, depth: number): void => {
    if (depth > 6 || x === null) return;
    if (typeof x === 'string') { strings++; if (/^<.+>$/.test(x.trim())) placeholders++; return; }
    if (Array.isArray(x)) { for (const i of x) walk(i, depth + 1); return; }
    if (typeof x === 'object') { for (const i of Object.values(x as object)) walk(i, depth + 1); }
  };
  walk(o, 0);
  return strings > 0 && placeholders / strings >= 0.5;
}

export function parseJudgeJson<T>(raw: string, required: Record<string, 'array'>): T {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  const candidates = extractJsonCandidates(stripped);
  // Collect every shape-valid candidate, then choose — rather than returning the
  // first one tried. Two opposite failure modes exist and they pull in opposite
  // directions: a SCHEMA ECHO before the answer ("here's the format: {…}") and a
  // worked EXAMPLE after it. Preferring the last handles the (much more common)
  // preamble case; the schema-echo filter below removes the echo explicitly so
  // the choice doesn't rest on position alone.
  const valid: Array<{ obj: unknown; echo: boolean }> = [];
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      assertJsonShape(obj, required);
      valid.push({ obj, echo: looksLikeSchemaEcho(obj) });
    } catch (err) {
      lastErr = err;
    }
  }
  if (valid.length) {
    // Prefer the last NON-echo candidate; fall back to the last of any kind.
    const real = valid.filter(v => !v.echo);
    return ((real.length ? real : valid)[(real.length ? real : valid).length - 1].obj) as T;
  }
  throw lastErr instanceof Error ? lastErr : new Error('judge reply contained no shape-valid JSON object');
}

export function sliceBalancedJson(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  const end = text.lastIndexOf('}');
  return end > start ? text.slice(start, end + 1) : text;
}

/**
 * Conservative per-attached-image token reserve. A vision model consumes real
 * prompt/vision tokens for each image that plain char-counting can't see, so an
 * image-bearing request would otherwise under-estimate the prompt and let
 * clampMaxTokens over-allocate the output budget — which vLLM/SGLang hard-reject
 * when prompt+max_tokens exceeds max_model_len. ~1500 covers a typical single
 * high-detail image while staying small enough that one image against an 8k
 * context still leaves ample output room (never spuriously trips
 * PromptTooLargeError). It's an estimate in the same rough spirit as chars/3,
 * erring high (the safe direction), not an exact tokenizer.
 */
const IMAGE_TOKEN_ESTIMATE = 1500;

/**
 * Rough prompt-token estimate without a client-side tokenizer. Uses chars/3
 * (English averages ~4 chars/token) so it slightly OVER-estimates the text —
 * that makes the output budget conservative, which is the safe direction — plus
 * a per-image reserve so attached images (which cost real prompt tokens a char
 * count can't see) are accounted for too.
 */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  const imageCount = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  return Math.ceil(chars / 3) + 4 * messages.length + imageCount * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Clamp requested output tokens so prompt + output fit the server's advertised
 * context window. vLLM (and some others) hard-reject when max_tokens exceeds
 * max_model_len; this keeps every request valid. When the server advertises no
 * context length (maxModelLen undefined), the request is returned unchanged.
 */
/** Thrown by clampMaxTokens when a prompt already exceeds a model's context window. */
export class PromptTooLargeError extends Error {
  constructor(message = 'prompt exceeds the model\'s context window') {
    super(message);
    this.name = 'PromptTooLargeError';
  }
}

export function clampMaxTokens(
  requested: number,
  maxModelLen: number | undefined,
  messages: ChatMessage[],
): number {
  if (!maxModelLen || maxModelLen <= 0) return requested;
  const MIN_OUTPUT = 16;
  const budget = maxModelLen - estimatePromptTokens(messages) - 64; // reserve prompt + headroom
  // A budget below a usable output floor means the prompt itself already
  // doesn't fit — silently sending the request anyway with a token-starved
  // MIN_OUTPUT max_tokens produces a response so truncated it's unusable,
  // contradicting this function's job of keeping requests valid. Reject
  // clearly instead so the caller surfaces "prompt too large" rather than a
  // mysteriously truncated/garbled answer.
  if (budget < MIN_OUTPUT) {
    throw new PromptTooLargeError(
      `prompt (~${estimatePromptTokens(messages)} tokens) leaves no room for a response within the model's ${maxModelLen}-token context window`,
    );
  }
  return Math.min(requested, budget);
}

export interface Provider {
  readonly serverId: string;
  readonly config: ServerConfig;

  /** List models available on this server */
  listModels(): Promise<ModelInfo[]>;

  /** Single completion call */
  complete(
    model: string,
    messages: ChatMessage[],
    opts?: CompletionOptions,
  ): Promise<string>;

  /** Quick reachability check */
  ping(): Promise<boolean>;

  /**
   * Whether `model` accepts image input. Cached per model where the answer is
   * definitive; a transient probe failure (unreachable/timeout) returns false
   * for that call without poisoning the cache, so a network blip doesn't
   * permanently mislabel a vision model as text-only.
   */
  supportsVision(model: string): Promise<boolean>;

  /**
   * The current DEFINITIVE vision-capability results, keyed by bare model
   * name — never includes a transient/inconclusive result (those are
   * deliberately never cached at all, see supportsVision). Read by the
   * orchestrator to persist verified capability to disk so a restart doesn't
   * re-pay the detection round trip for a model already proven capable.
   */
  getVisionCache(): Record<string, boolean>;

  /**
   * Seed the vision-capability cache from persisted state. Never overwrites
   * an existing in-memory entry — a fresh result computed earlier this
   * session always wins over a stale disk value.
   */
  seedVisionCache(entries: Record<string, boolean>): void;
}
