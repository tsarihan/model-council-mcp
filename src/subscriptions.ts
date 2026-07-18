/**
 * Subscription reference data: tiers → per-provider concurrency, curated cloud
 * models, and per-provider model names.
 *
 * The canonical, editable source is `config/subscriptions.json`, copied to
 * `bundle/subscriptions.json` at build time and read at boot. If the file can't
 * be found or parsed, an embedded copy (below) is used so a packaging problem
 * never bricks the server. Update the JSON and pull to pick up new plans/models.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoolKey } from './types.js';

export interface TierInfo {
  cloud: boolean;
  concurrency?: number;
}
export interface ProviderInfo {
  cliType?: string;
  tiers: Record<string, TierInfo>;
  models?: string[];
}
export interface Subscriptions {
  version: string;
  providers: {
    chatgpt: ProviderInfo;
    claude: ProviderInfo;
    ollama: ProviderInfo;
  };
  curatedCloudModels: string[];
  defaults: { cloudConcurrency: number; apiConcurrency: number; localConcurrency: number };
}

/** Embedded fallback — mirror of config/subscriptions.json. */
const EMBEDDED: Subscriptions = {
  version: '2026-07-14',
  providers: {
    chatgpt: {
      cliType: 'codex-cli',
      tiers: {
        free: { cloud: false },
        plus: { cloud: true, concurrency: 6 },
        pro5x: { cloud: true, concurrency: 6 },
        pro20x: { cloud: true, concurrency: 6 },
      },
      models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
    },
    claude: {
      cliType: 'claude-cli',
      tiers: {
        free: { cloud: false },
        pro: { cloud: true, concurrency: 2 },
        max5x: { cloud: true, concurrency: 4 },
        max20x: { cloud: true, concurrency: 8 },
      },
      models: ['opus', 'sonnet', 'haiku'],
    },
    ollama: {
      tiers: {
        free: { cloud: false },
        pro: { cloud: true, concurrency: 3 },
        max: { cloud: true, concurrency: 10 },
      },
    },
  },
  curatedCloudModels: [
    'glm-5.2:cloud', 'deepseek-v4-pro:cloud', 'qwen3.5:cloud', 'minimax-m3:cloud',
    'kimi-k2.7-code:cloud', 'nemotron-3-super:cloud', 'gemma4:cloud',
    'qwen3-coder:480b-cloud', 'mistral-large-3:675b-cloud', 'ministral-3:14b-cloud',
  ],
  defaults: { cloudConcurrency: 3, apiConcurrency: 4, localConcurrency: 1 },
};

/** Best-effort module directory: __dirname in the CJS bundle, import.meta.url under ESM/tsx. */
function moduleDir(): string | undefined {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {
    /* ESM — no __dirname */
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    /* no import.meta */
  }
  return undefined;
}

function candidatePaths(): string[] {
  const out: string[] = [];
  const override = process.env.MODEL_COUNCIL_SUBSCRIPTIONS;
  if (override && override.trim() && !override.includes('${')) out.push(override.trim());
  const dir = moduleDir();
  if (dir) out.push(join(dir, 'subscriptions.json'));
  out.push(join(process.cwd(), 'config', 'subscriptions.json'));
  out.push(join(process.cwd(), 'subscriptions.json'));
  return out;
}

function isValid(s: unknown): s is Subscriptions {
  const o = s as Partial<Subscriptions> | null;
  // A provider must have a tiers object AND (if present) a string[] models field.
  // Validating `models` here is what stops a structurally-valid but wrong-typed
  // file (e.g. "models": "opus") from reaching config.ts's `.join()` and crashing
  // boot — instead it falls through to the EMBEDDED copy below.
  const provOk = (p: unknown): boolean => {
    const pi = p as ProviderInfo | null;
    if (!pi || typeof pi.tiers !== 'object' || pi.tiers === null) return false;
    if (pi.models !== undefined &&
        !(Array.isArray(pi.models) && pi.models.every(m => typeof m === 'string'))) return false;
    return true;
  };
  const d = o?.defaults as Subscriptions['defaults'] | undefined;
  const defaultsOk =
    !!d &&
    typeof d.cloudConcurrency === 'number' &&
    typeof d.apiConcurrency === 'number' &&
    typeof d.localConcurrency === 'number';
  return (
    !!o && !!o.providers &&
    provOk(o.providers.chatgpt) && provOk(o.providers.claude) && provOk(o.providers.ollama) &&
    Array.isArray(o.curatedCloudModels) && defaultsOk
  );
}

let cached: Subscriptions | null = null;

/** Load the reference data (file if available, else embedded). Cached after first call. */
export function loadSubscriptions(): Subscriptions {
  if (cached) return cached;
  for (const p of candidatePaths()) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (isValid(parsed)) {
        cached = parsed;
        return cached;
      }
    } catch {
      /* try next candidate */
    }
  }
  cached = EMBEDDED;
  return cached;
}

/** Provider key → the pool key used for concurrency bucketing. */
export type SubProvider = 'chatgpt' | 'claude' | 'ollama';

/** Does `tier` grant cloud access for `provider`? Unknown tier → false (safe). */
export function tierAllowsCloud(provider: SubProvider, tier: string, subs = loadSubscriptions()): boolean {
  return subs.providers[provider]?.tiers?.[tier]?.cloud ?? false;
}

/** Concurrency for a provider at a tier (falls back to sensible defaults). */
export function tierConcurrency(provider: SubProvider, tier: string, subs = loadSubscriptions()): number {
  const t = subs.providers[provider]?.tiers?.[tier];
  if (t?.concurrency && t.concurrency > 0) return t.concurrency;
  return subs.defaults.cloudConcurrency;
}

/** Valid tier names for a provider (for validation / listing in setup). */
export function validTiers(provider: SubProvider, subs = loadSubscriptions()): string[] {
  return Object.keys(subs.providers[provider]?.tiers ?? {});
}

/**
 * Resolve per-provider concurrency limits from the selected tiers. API-keyed
 * providers (openai/anthropic/groq) use the apiConcurrency default; `local`
 * covers local Ollama + self-hosted servers. `overrides` (e.g. an explicit
 * CLOUD_CONCURRENCY/LOCAL_CONCURRENCY) win when provided.
 */
export function resolvePoolLimits(
  tiers: { chatgpt: string; claude: string; ollama: string },
  overrides: { cloud?: number; local?: number } = {},
  subs = loadSubscriptions(),
): Record<PoolKey, number> {
  // An explicit CLOUD_CONCURRENCY override collapses every cloud pool to that
  // ceiling; otherwise each pool comes from its tier (API-keyed providers use
  // the apiConcurrency default, since they're pay-per-token, not tier-gated).
  const cloud = overrides.cloud;
  return {
    chatgpt: cloud ?? tierConcurrency('chatgpt', tiers.chatgpt, subs),
    claude: cloud ?? tierConcurrency('claude', tiers.claude, subs),
    'ollama-cloud': cloud ?? tierConcurrency('ollama', tiers.ollama, subs),
    openai: cloud ?? subs.defaults.apiConcurrency,
    anthropic: cloud ?? subs.defaults.apiConcurrency,
    groq: cloud ?? subs.defaults.apiConcurrency,
    local: overrides.local ?? subs.defaults.localConcurrency,
  };
}
