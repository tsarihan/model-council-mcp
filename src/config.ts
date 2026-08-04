import {
  CouncilConfig,
  CouncilMember,
  ModelId,
  ProviderType,
  ResponseMode,
  RuntimeConfig,
  ServerConfig,
  SubscriptionTiers,
} from './types.js';
import {
  loadSubscriptions,
  resolvePoolLimits,
  tierAllowsCloud,
  validTiers,
  SubProvider,
} from './subscriptions.js';
import { loadState } from './state.js';
import { EFFORT_ORDER, isReasoningEffort } from './providers/effort.js';

export interface AppConfig {
  servers: ServerConfig[];
  council: CouncilConfig;
  runtime: RuntimeConfig;
  /** Resolved subscription tiers (state > env > default). */
  tiers: SubscriptionTiers;
  /**
   * Boot-time config problems worth surfacing (e.g. to stderr) but not worth
   * crashing the whole server over — unlike a bad configure_council call
   * (which can reject with a clear error back to that one caller), a bad env
   * var discovered here has no request/response cycle to attach an error to,
   * and throwing would mean the entire server fails to start over what's
   * often a single typo. Silently falling back is still better than a crash,
   * but silently AND without any signal is what this exists to avoid.
   */
  warnings: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PORTS: Record<string, number> = {
  vllm: 8000,
  trtllm: 8000,
  sglang: 30000,
};

/**
 * Parse a comma-separated list of "name:host:port" or "name:host" entries
 * into ServerConfig objects.
 *
 * Full URL also accepted: "name:http://192.168.1.10:8000"
 */
function parseOpenAICompatibleServers(
  raw: string | undefined,
  type: ProviderType,
): ServerConfig[] {
  if (!raw?.trim()) return [];
  const defaultPort = DEFAULT_PORTS[type] ?? 8000;

  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      // Split on first colon only to get the name, rest is the address
      const firstColon = entry.indexOf(':');
      if (firstColon === -1) {
        // Just a name → localhost:defaultPort
        return buildServer(type, entry, `http://localhost:${defaultPort}`);
      }

      const name = entry.substring(0, firstColon);
      const rest = entry.substring(firstColon + 1);

      // If rest starts with "http" it's already a full URL
      if (rest.startsWith('http://') || rest.startsWith('https://')) {
        return buildServer(type, name, rest);
      }

      // Otherwise "host:port" or "host"
      const parts = rest.split(':');
      const host = parts[0];
      // Validate the port so a non-numeric value can't produce "http://host:NaN".
      // strictParseInt (not plain parseInt) so "8000oops" is rejected outright
      // rather than silently truncated to the port 8000.
      let port = defaultPort;
      if (parts[1] !== undefined) {
        const n = strictParseInt(parts[1]);
        port = n !== undefined && n > 0 && n <= 65535 ? n : defaultPort;
      }
      return buildServer(type, name, `http://${host}:${port}`);
    });
}

/** Prepend http:// when a URL is missing its scheme (a bare host:port is unusable). */
function normalizeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `http://${u}`;
}

/**
 * Strip HTTP basic-auth userinfo (`user:pass@`) from a URL before it reaches
 * any human-visible surface — server labels, list_models, get_council_config,
 * council_status. A base URL / address (CLAUDE_CLI_OLLAMA_ADDRESS, a
 * VLLM_SERVERS entry, an Ollama address) may legitimately embed credentials,
 * and these surfaces are echoed to MCP clients, IDE logs, and shared
 * transcripts — so the raw value would leak the secret to anyone who reads
 * them. Falls back to a manual regex if the string isn't a parseable URL
 * (never throws).
 */
export function redactUrlUserinfo(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) { u.username = ''; u.password = ''; return u.toString(); }
    return url;
  } catch {
    return url.replace(/(\/\/)[^/@]*@/, '$1');
  }
}

function buildServer(
  type: ProviderType,
  name: string,
  baseUrl: string,
): ServerConfig {
  return {
    id: `${type}-${name}`,
    type,
    baseUrl,
    // Redact any basic-auth creds embedded in the URL from the human-visible
    // label (baseUrl itself is kept raw for the actual connection).
    label: `${type.toUpperCase()} › ${name}  (${redactUrlUserinfo(baseUrl)})`,
  };
}

/**
 * Parse a model reference string into a ModelId.
 *
 * Formats:
 *   provider:model              →  { provider, model }
 *   provider/serverId:model     →  { provider, serverId, model }
 *
 * Examples:
 *   ollama:llama3
 *   openai:gpt-4o
 *   vllm/vllm-gpu1:meta-llama/Llama-3-8B
 */
export const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<ProviderType>([
  'ollama', 'openai', 'anthropic', 'xai', 'vllm', 'trtllm', 'sglang', 'claude-cli', 'codex-cli', 'grok-cli',
]);

export function parseModelId(str: string): ModelId | null {
  const colonIdx = str.indexOf(':');
  if (colonIdx === -1) return null;

  const providerPart = str.substring(0, colonIdx);
  const model = str.substring(colonIdx + 1);
  if (!model) return null;

  const slashIdx = providerPart.indexOf('/');
  const provider =
    slashIdx === -1 ? providerPart : providerPart.substring(0, slashIdx);
  // Reject unknown/mistyped providers (e.g. "claud:opus") so a typo is caught at
  // the boundary rather than silently becoming a dead council member.
  if (!KNOWN_PROVIDERS.has(provider)) return null;
  const serverId =
    slashIdx === -1 ? undefined : providerPart.substring(slashIdx + 1);

  return { provider: provider as ProviderType, serverId, model };
}

export function modelIdLabel(m: ModelId): string {
  const prefix = m.serverId ? `${m.provider}/${m.serverId}` : m.provider;
  return `${prefix}:${m.model}`;
}

// ─── Main config loader ───────────────────────────────────────────────────────

/**
 * Read an env var, treating empty strings and unsubstituted plugin
 * placeholders (e.g. a literal "${user_config.foo}") as "not set".
 * This guards against the plugin host leaving a placeholder in place when a
 * userConfig option is empty.
 */
function envClean(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  if (trimmed.includes('${')) return undefined; // unsubstituted placeholder
  return trimmed;
}

/**
 * Strict integer parse: the WHOLE trimmed string must be an optionally-signed
 * run of digits, or this returns `undefined`. Plain `parseInt()` accepts a
 * valid leading numeric PREFIX with trailing garbage (`parseInt("16000kb",
 * 10) === 16000`, `parseInt("3oops", 10) === 3`) — every numeric env/config
 * value in this file used to parse independently with that same lenient
 * behavior (round 6 fixed ONE call site, `CLOUD_CONCURRENCY`/
 * `LOCAL_CONCURRENCY`'s `parseOverride`, and a round-7 review found three
 * sibling sites — `envInt` here, `MAX_DECONFLICT_ROUNDS`, and the
 * OpenAI-compatible server port parser — still had the exact same gap).
 * Centralizing the check here means a future numeric setting can't diverge
 * from the others by accident.
 */
function strictParseInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function envInt(name: string, fallback: number): number {
  return strictParseInt(envClean(name)) ?? fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = envClean(name);
  if (v === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(): AppConfig {
  const servers: ServerConfig[] = [];

  // ── Subscription tiers (resolved early: state > env > code default) ────────
  // Tiers gate which subscription-CLI providers are registered and drive
  // per-provider concurrency. Reference data (subscriptions.json) is editable
  // and pulled; the state file carries the user's interactive choices.
  const subs = loadSubscriptions();
  const state = loadState();
  const resolveTier = (provider: SubProvider, envName: string, def: string): string => {
    const valid = validTiers(provider, subs);
    // Each step of the documented "state > env > default" chain must be
    // validated and skipped independently — collapsing them into one `??`
    // chain (the previous `chosen = state.tiers?.[provider] ?? envClean(...)
    // ?? def`) meant a PRESENT-but-INVALID state value (hand-edited
    // state.json, or persisted before subscriptions.json renamed/removed
    // that tier) short-circuited the whole chain and skipped straight past a
    // perfectly valid env var to the hardcoded default.
    const stateVal = state.tiers?.[provider];
    if (stateVal !== undefined && valid.includes(stateVal)) return stateVal;
    const envVal = envClean(envName);
    if (envVal !== undefined && valid.includes(envVal)) return envVal;
    // `def` (the hardcoded literal default, e.g. "pro") is not itself
    // guaranteed to still be a valid tier — if subscriptions.json ever
    // renames/removes it, falling back to `def` unconditionally would return
    // an invalid tier just as readily as `chosen` was. Fall back one step
    // further, to the provider's first ("free", by convention — see
    // subscriptions.json) tier, which validTiers() always recognizes.
    return valid.includes(def) ? def : (valid[0] ?? def);
  };
  const tiers = {
    chatgpt: resolveTier('chatgpt', 'CHATGPT_TIER', 'plus'),
    claude: resolveTier('claude', 'CLAUDE_TIER', 'pro'),
    grok: resolveTier('grok', 'GROK_TIER', 'free'),
    ollama: resolveTier('ollama', 'OLLAMA_TIER', 'pro'),
  };

  // ── Ollama ────────────────────────────────────────────────────────────────
  const ollamaAddr = envClean('OLLAMA_ADDRESS');
  servers.push({
    id: 'ollama',
    type: 'ollama',
    baseUrl: ollamaAddr ? normalizeUrl(ollamaAddr) : 'http://localhost:11434',
    label: 'Ollama (local)',
  });

  // ── Cloud providers ───────────────────────────────────────────────────────
  const openaiKey = envClean('OPENAI_API_KEY');
  if (openaiKey) {
    servers.push({
      id: 'openai',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: openaiKey,
      label: 'OpenAI',
    });
  }

  const anthropicKey = envClean('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    servers.push({
      id: 'anthropic',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: anthropicKey,
      label: 'Anthropic',
    });
  }

  const xaiKey = envClean('XAI_API_KEY');
  if (xaiKey) {
    servers.push({
      id: 'xai',
      type: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: xaiKey,
      label: 'Grok (xAI)',
    });
  }

  // ── OpenAI-compatible inference servers ───────────────────────────────────
  servers.push(
    ...parseOpenAICompatibleServers(envClean('VLLM_SERVERS'), 'vllm'),
    ...parseOpenAICompatibleServers(envClean('TRTLLM_SERVERS'), 'trtllm'),
    ...parseOpenAICompatibleServers(envClean('SGLANG_SERVERS'), 'sglang'),
  );

  // ── Claude subscription via the first-party CLI ───────────────────────────
  // Registered when the Claude tier grants cloud (default) or the legacy
  // CLAUDE_CLI boolean is set. Registration only makes the provider available;
  // whether its members join the auto-council depends on live login detection.
  if (tierAllowsCloud('claude', tiers.claude, subs) || envBool('CLAUDE_CLI', false)) {
    const defModels =
      (Array.isArray(subs.providers.claude.models) ? subs.providers.claude.models.join(',') : '') ||
      'opus,sonnet';
    const cliModels = (envClean('CLAUDE_CLI_MODELS') ?? defModels)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    servers.push({
      id: 'claude-cli',
      type: 'claude-cli',
      baseUrl: '(subscription via claude CLI)',
      label: 'Claude (subscription CLI)',
      command: envClean('CLAUDE_CLI_PATH') ?? 'claude',
      models: cliModels.length ? cliModels : ['opus', 'sonnet'],
    });
  }

  // ── Open-weight models via the claude CLI's own harness ───────────────────
  // A SEPARATE registration from the real subscription CLI above (distinct
  // server id) that points the `claude` CLI's ANTHROPIC_BASE_URL at Ollama's
  // native Anthropic-Messages-API-compatible endpoint instead of the real
  // Anthropic API — see claude-cli.ts's file header for why this is the only
  // way an Ollama-hosted model gets genuine full_repo_access (Read/Grep/Glob
  // tool use), rather than the flattened, no-tool-use single completion every
  // other Ollama/OpenAI-compatible/API provider gets. These are NOT Claude —
  // ClaudeCliProvider.listModels() labels them distinctly.
  //
  // Always registered (even with an empty model list) so autoPopulatedMembers
  // and autoDiscoverCouncil can route Ollama cloud models through the harness
  // for tool access. CLAUDE_CLI_OLLAMA_MODELS adds explicit models on top.
  const claudeCliOllamaModels = (envClean('CLAUDE_CLI_OLLAMA_MODELS') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  {
    const harnessAddr = envClean('CLAUDE_CLI_OLLAMA_ADDRESS') ?? ollamaAddr;
    servers.push({
      id: 'claude-cli-ollama',
      type: 'claude-cli',
      baseUrl: '(Ollama via claude CLI harness)',
      label: 'Ollama (via claude CLI harness)',
      command: envClean('CLAUDE_CLI_PATH') ?? 'claude',
      models: claudeCliOllamaModels,
      anthropicBaseUrl: normalizeUrl(harnessAddr ?? 'http://localhost:11434'),
    });
  }

  // ── ChatGPT subscription via the first-party Codex CLI ────────────────────
  // Registered when the ChatGPT tier grants cloud (default) or the legacy
  // CODEX_CLI boolean is set. Codex is a coding agent; members answer with a
  // coding-agent flavour.
  if (tierAllowsCloud('chatgpt', tiers.chatgpt, subs) || envBool('CODEX_CLI', false)) {
    const defModels =
      (Array.isArray(subs.providers.chatgpt.models) ? subs.providers.chatgpt.models.join(',') : '') ||
      'default';
    const codexModels = (envClean('CODEX_CLI_MODELS') ?? defModels)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    servers.push({
      id: 'codex-cli',
      type: 'codex-cli',
      baseUrl: '(subscription via codex CLI)',
      label: 'Codex (ChatGPT subscription CLI)',
      command: envClean('CODEX_CLI_PATH') ?? 'codex',
      models: codexModels.length ? codexModels : ['default'],
    });
  }

  // ── Grok subscription via the first-party Grok Build CLI ──────────────────
  // Registered when the Grok tier grants cloud (default 'free' — opt-in via
  // GROK_TIER or setup_council, unlike claude/chatgpt's paid defaults, since
  // this is a newer provider added on top of an existing install base) or the
  // legacy GROK_CLI boolean is set.
  if (tierAllowsCloud('grok', tiers.grok, subs) || envBool('GROK_CLI', false)) {
    const defModels =
      (Array.isArray(subs.providers.grok.models) ? subs.providers.grok.models.join(',') : '') ||
      'grok-4.5';
    const grokModels = (envClean('GROK_CLI_MODELS') ?? defModels)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    servers.push({
      id: 'grok-cli',
      type: 'grok-cli',
      baseUrl: '(subscription via grok CLI)',
      label: 'Grok (X.AI subscription CLI)',
      command: envClean('GROK_CLI_PATH') ?? 'grok',
      models: grokModels.length ? grokModels : ['grok-4.5'],
    });
  }

  // ── Council members ───────────────────────────────────────────────────────
  const warnings: string[] = [];
  const councilModelsRaw = envClean('COUNCIL_MODELS');
  const councilModelEntries = (councilModelsRaw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const members: CouncilMember[] = councilModelEntries.flatMap(s => {
    const id = parseModelId(s);
    return id ? [{ modelId: id }] : [];
  });
  // Unlike configure_council (which can reject an all-unparseable `models`
  // list back to the caller with a clear error — see index.ts), a typo'd
  // COUNCIL_MODELS env var has no request/response cycle to attach an error
  // to, and throwing here would fail the WHOLE server to start over what's
  // often a single typo. Silently falling through to auto-population instead
  // (the pre-existing behavior) is the safer default, but doing so with NO
  // signal at all means the user has no idea their explicit setting was
  // ignored — surface it as a boot warning instead.
  if (councilModelEntries.length > 0 && members.length === 0) {
    warnings.push(
      `COUNCIL_MODELS was set but none of its entries parsed (expected "provider:model", ` +
        `e.g. "ollama:llama3"): ${councilModelEntries.join(', ')} — falling back to auto-population.`,
    );
  }

  // ── Judge model ───────────────────────────────────────────────────────────
  const judgeStr = envClean('JUDGE_MODEL');
  if (judgeStr && judgeStr !== 'auto' && !parseModelId(judgeStr)) {
    // Silently mapping a typo to `undefined` makes it indistinguishable from an
    // intentional "auto" — the user believes they pinned a judge and never finds
    // out otherwise. Every other malformed env var here surfaces a boot warning.
    warnings.push(
      `JUDGE_MODEL="${judgeStr}" is not a valid model id (expected "provider:model" or ` +
      `"provider/serverId:model") — falling back to automatic judge selection.`,
    );
  }
  const judgeModelId =
    judgeStr && judgeStr !== 'auto'
      ? (parseModelId(judgeStr) ?? undefined)
      : undefined;

  // ── Response mode ─────────────────────────────────────────────────────────
  const modeRaw = envClean('RESPONSE_MODE');
  const responseMode: ResponseMode =
    modeRaw === 'individual' ||
    modeRaw === 'categorized' ||
    modeRaw === 'deconflicted' ||
    modeRaw === 'pooled' ||
    modeRaw === 'dialectic'
      ? modeRaw
      : 'categorized';
  const maxDeconflictRounds = Math.max(
    1,
    Math.min(10, strictParseInt(envClean('MAX_DECONFLICT_ROUNDS')) ?? 3),
  );

  // ── Reasoning effort ──────────────────────────────────────────────────────
  // Boot default for how hard every member (and the judge) thinks. Unset means
  // "send nothing", which is NOT the same as any particular level — each model
  // then runs at its own default, exactly as before this setting existed.
  const effortRaw = envClean('REASONING_EFFORT');
  if (effortRaw !== undefined && !isReasoningEffort(effortRaw)) {
    // Same treatment as a typo'd JUDGE_MODEL: silently ignoring it would leave
    // the user believing they'd set a level, with nothing to tell them apart
    // from an intentionally unset one.
    warnings.push(
      `REASONING_EFFORT="${effortRaw}" is not a valid level (expected one of ` +
      `${EFFORT_ORDER.join(', ')}) — falling back to each model's own default.`,
    );
  }
  const reasoningEffort = isReasoningEffort(effortRaw) ? effortRaw : undefined;

  // Auto-council: default ON. Only "false"/"0"/"no" disables it.
  const autoRaw = (envClean('AUTO_COUNCIL') ?? 'true').toLowerCase();
  const autoCouncil = !['false', '0', 'no', 'off'].includes(autoRaw);

  // ── Per-provider concurrency from the tiers resolved above ────────────────
  // Each tier maps to a concurrency ceiling in subscriptions.json (editable +
  // pullable). Explicit CLOUD_CONCURRENCY / LOCAL_CONCURRENCY still override,
  // for back-compat and power users.
  const cloudOverrideRaw = envClean('CLOUD_CONCURRENCY');
  const localOverrideRaw = envClean('LOCAL_CONCURRENCY');
  // `0` is a legitimate, documented "unlimited" sentinel (matches the
  // Semaphore's own `limit <= 0` convention — see LOCAL_CONCURRENCY's own
  // README entry). The previous `parseInt(...) || default` here treated 0 as
  // falsy and silently substituted the default, and `Math.max(1, ...)`
  // floored anything below 1 regardless — CLOUD_CONCURRENCY=0 could never
  // actually mean unlimited, unlike LOCAL_CONCURRENCY=0 one line below (which
  // already used the correct Number.isFinite-based pattern). Match it.
  //
  // A genuinely UNPARSEABLE value (e.g. CLOUD_CONCURRENCY=three, or a valid
  // prefix with trailing garbage like "3oops") must resolve to `undefined` —
  // "as if unset" — not to the numeric default. A defined override collapses
  // EVERY cloud pool to that single ceiling in resolvePoolLimits() below, so
  // mapping a typo to the default number silently pins
  // chatgpt/claude/grok/ollama-cloud/openai/anthropic/xai all to that one
  // value, discarding each provider's real per-tier concurrency with no
  // visible signal — worse than just falling through to per-tier limits,
  // which is what an actually-unset var does. strictParseInt() (shared with
  // envInt/MAX_DECONFLICT_ROUNDS/the server-port parser above) is what
  // rejects the trailing-garbage case; a plain Number.isFinite(parseInt(...))
  // check alone does not, since parseInt("3oops", 10) === 3.
  const cloudOverride = strictParseInt(cloudOverrideRaw);
  const localOverride = strictParseInt(localOverrideRaw);
  const poolLimits = resolvePoolLimits(tiers, { cloud: cloudOverride, local: localOverride }, subs);

  const runtime: RuntimeConfig = {
    // Output-token budget per completion. Clamped per-model to fit the server's
    // context window (clampMaxTokens) on Ollama and OpenAI-compatible providers,
    // so a generous default gives longer answers on large-context models without
    // risking an over-context request; CLI members ignore it (subscription-
    // managed). 32K is a generous-but-bounded default (raise via MAX_TOKENS for
    // even longer answers — slower/costlier, multiplied across members × rounds).
    maxTokens: Math.max(1, envInt('MAX_TOKENS', 32768)),
    reasoningEffort,
    cloudConcurrency: cloudOverride ?? subs.defaults.cloudConcurrency,
    localConcurrency: localOverride ?? subs.defaults.localConcurrency,
    poolLimits,
    retries: Math.max(1, envInt('COMPLETION_RETRIES', 3)),
    // 5 min default for text-only calls: local Ollama models run sequentially
    // (local_concurrency=1), so a single completion on a busy box can take a
    // while, and a too-tight cap cuts member answers mid-generation. Raise via
    // REQUEST_TIMEOUT_MS (or set_council_timeouts).
    requestTimeoutMs: Math.max(1000, envInt('REQUEST_TIMEOUT_MS', 300000)),
    // 10 min default when full_repo_access is set: the CLI member Read/Grep/
    // Globs the repo tree, materially longer than a flat text completion.
    repoRequestTimeoutMs: Math.max(1000, envInt('REPO_REQUEST_TIMEOUT_MS', 600000)),
    verbose: envBool('DECONFLICT_VERBOSE', false),
  };

  return {
    servers,
    council: {
      members,
      judgeModelId,
      responseMode,
      maxDeconflictRounds,
      autoCouncil,
    },
    runtime,
    tiers,
    warnings,
  };
}
