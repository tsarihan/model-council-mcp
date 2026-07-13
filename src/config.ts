import {
  CouncilConfig,
  CouncilMember,
  ModelId,
  ProviderType,
  ResponseMode,
  RuntimeConfig,
  ServerConfig,
} from './types.js';

export interface AppConfig {
  servers: ServerConfig[];
  council: CouncilConfig;
  runtime: RuntimeConfig;
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
      const port = parts[1] ? parseInt(parts[1], 10) : defaultPort;
      return buildServer(type, name, `http://${host}:${port}`);
    });
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
    label: `${type.toUpperCase()} › ${name}  (${baseUrl})`,
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
export function parseModelId(str: string): ModelId | null {
  const colonIdx = str.indexOf(':');
  if (colonIdx === -1) return null;

  const providerPart = str.substring(0, colonIdx);
  const model = str.substring(colonIdx + 1);
  if (!model) return null;

  const slashIdx = providerPart.indexOf('/');
  const provider = (
    slashIdx === -1 ? providerPart : providerPart.substring(0, slashIdx)
  ) as ProviderType;
  const serverId =
    slashIdx === -1 ? undefined : providerPart.substring(slashIdx + 1);

  return { provider, serverId, model };
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

function envInt(name: string, fallback: number): number {
  const v = envClean(name);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = envClean(name);
  if (v === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(): AppConfig {
  const servers: ServerConfig[] = [];

  // ── Ollama ────────────────────────────────────────────────────────────────
  servers.push({
    id: 'ollama',
    type: 'ollama',
    baseUrl: envClean('OLLAMA_ADDRESS') ?? 'http://localhost:11434',
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

  const groqKey = envClean('GROQ_API_KEY');
  if (groqKey) {
    servers.push({
      id: 'groq',
      type: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: groqKey,
      label: 'Groq',
    });
  }

  // ── OpenAI-compatible inference servers ───────────────────────────────────
  servers.push(
    ...parseOpenAICompatibleServers(envClean('VLLM_SERVERS'), 'vllm'),
    ...parseOpenAICompatibleServers(envClean('TRTLLM_SERVERS'), 'trtllm'),
    ...parseOpenAICompatibleServers(envClean('SGLANG_SERVERS'), 'sglang'),
  );

  // ── Claude subscription via the first-party CLI (opt-in) ──────────────────
  // Adds subscription-backed Claude members that shell out to the local
  // `claude -p` binary instead of billing an API key. Requires the Claude Code
  // CLI installed and logged in to a Pro/Max subscription.
  if (envBool('CLAUDE_CLI', false)) {
    const cliModels = (envClean('CLAUDE_CLI_MODELS') ?? 'opus,sonnet')
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

  // ── Council members ───────────────────────────────────────────────────────
  const members: CouncilMember[] = (envClean('COUNCIL_MODELS') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .flatMap(s => {
      const id = parseModelId(s);
      return id ? [{ modelId: id }] : [];
    });

  // ── Judge model ───────────────────────────────────────────────────────────
  const judgeStr = envClean('JUDGE_MODEL');
  const judgeModelId =
    judgeStr && judgeStr !== 'auto'
      ? (parseModelId(judgeStr) ?? undefined)
      : undefined;

  // ── Response mode ─────────────────────────────────────────────────────────
  const modeRaw = envClean('RESPONSE_MODE');
  const responseMode: ResponseMode =
    modeRaw === 'individual' || modeRaw === 'categorized' || modeRaw === 'deconflicted'
      ? modeRaw
      : 'categorized';
  const maxDeconflictRounds = Math.max(
    1,
    Math.min(10, parseInt(envClean('MAX_DECONFLICT_ROUNDS') ?? '3', 10) || 3),
  );

  // Auto-council: default ON. Only "false"/"0"/"no" disables it.
  const autoRaw = (envClean('AUTO_COUNCIL') ?? 'true').toLowerCase();
  const autoCouncil = !['false', '0', 'no', 'off'].includes(autoRaw);

  // ── Runtime tuning ────────────────────────────────────────────────────────
  // Cloud concurrency defaults to 3 (Ollama cloud requires a Pro plan, which
  // grants at least 3 concurrent requests). Local defaults to 1 (sequential)
  // to avoid resource contention; set LOCAL_CONCURRENCY=0 for unlimited.
  const runtime: RuntimeConfig = {
    maxTokens: Math.max(1, envInt('MAX_TOKENS', 16000)),
    cloudConcurrency: Math.max(1, envInt('CLOUD_CONCURRENCY', 3)),
    localConcurrency: envInt('LOCAL_CONCURRENCY', 1),
    retries: Math.max(1, envInt('COMPLETION_RETRIES', 3)),
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
  };
}
