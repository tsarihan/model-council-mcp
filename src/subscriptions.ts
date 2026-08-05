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
    grok: ProviderInfo;
    ollama: ProviderInfo;
  };
  curatedCloudModels: string[];
  defaults: { cloudConcurrency: number; apiConcurrency: number; localConcurrency: number };
}

/** Embedded fallback — mirror of config/subscriptions.json. */
const EMBEDDED: Subscriptions = {
  version: '2026-07-20',
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
    grok: {
      cliType: 'grok-cli',
      tiers: {
        free: { cloud: false },
        supergrok: { cloud: true, concurrency: 2 },
        premiumplus: { cloud: true, concurrency: 3 },
        heavy: { cloud: true, concurrency: 6 },
      },
      models: ['grok-4.5'],
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

export function isValid(s: unknown): s is Subscriptions {
  const o = s as Partial<Subscriptions> | null;
  // A provider must have a tiers object AND (if present) a string[] models field.
  // Validating `models` here is what stops a structurally-valid but wrong-typed
  // file (e.g. "models": "opus") from reaching config.ts's `.join()` and crashing
  // boot — instead it falls through to the EMBEDDED copy below.
  // Each tier entry must have a real boolean `cloud` and (if present) a finite
  // `concurrency` — otherwise a malformed file (e.g. `"cloud": "false"`, a
  // truthy string) would pass this check and then get read by tierAllowsCloud()
  // at face value, silently granting cloud access instead of denying it.
  const tierOk = (t: unknown): boolean => {
    const ti = t as TierInfo | null;
    if (!ti || typeof ti.cloud !== 'boolean') return false;
    if (ti.concurrency !== undefined && !Number.isFinite(ti.concurrency)) return false;
    return true;
  };
  const provOk = (p: unknown): boolean => {
    const pi = p as ProviderInfo | null;
    // Array.isArray excluded explicitly (typeof [] === 'object' too) and a
    // non-empty check: Object.values({}).every(...) — and
    // Object.values([]).every(...) — are both vacuously TRUE for an empty
    // input, so `{tiers: {}}` or `{tiers: []}` would otherwise pass this
    // check with ZERO actual tiers defined. validTiers() would then always
    // return [], and every tier-resolution fallback chain (resolveTier/
    // effectiveTiers) would report a tier that isn't actually a real key in
    // this provider's tiers at all — a structurally broken config accepted
    // as valid instead of falling back to the embedded defaults.
    if (!pi || typeof pi.tiers !== 'object' || pi.tiers === null || Array.isArray(pi.tiers)) return false;
    if (Object.keys(pi.tiers).length === 0) return false;
    if (!Object.values(pi.tiers).every(tierOk)) return false;
    if (pi.models !== undefined &&
        !(Array.isArray(pi.models) && pi.models.every(m => typeof m === 'string'))) return false;
    return true;
  };
  const d = o?.defaults as Subscriptions['defaults'] | undefined;
  // Number.isFinite (not typeof === 'number') — a zero or negative value is a
  // legitimate, documented "unlimited" sentinel for these fields (matches the
  // Semaphore's own `limit <= 0` convention), but NaN/Infinity are not
  // meaningful concurrency values and must not silently reach the semaphore.
  const defaultsOk =
    !!d &&
    Number.isFinite(d.cloudConcurrency) &&
    Number.isFinite(d.apiConcurrency) &&
    Number.isFinite(d.localConcurrency);
  // Each element must be a string, same as `pi.models` above — otherwise a
  // non-string entry (object/number/null) reaches Ollama completion probes
  // and template interpolation in autoPopulatedMembers unchanged, producing
  // a malformed model id (e.g. "ollama:[object Object]") that can get
  // persisted into the council.
  const curatedOk =
    Array.isArray(o?.curatedCloudModels) && o.curatedCloudModels.every(m => typeof m === 'string');
  return (
    !!o && !!o.providers &&
    provOk(o.providers.chatgpt) && provOk(o.providers.claude) && provOk(o.providers.grok) && provOk(o.providers.ollama) &&
    curatedOk && defaultsOk
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
export type SubProvider = 'chatgpt' | 'claude' | 'grok' | 'ollama';

/** Does `tier` grant cloud access for `provider`? Unknown tier → false (safe). */
export function tierAllowsCloud(provider: SubProvider, tier: string, subs = loadSubscriptions()): boolean {
  return subs.providers[provider]?.tiers?.[tier]?.cloud ?? false;
}

/** Concurrency for a provider at a tier (falls back to sensible defaults). */
export function tierConcurrency(provider: SubProvider, tier: string, subs = loadSubscriptions()): number {
  const t = subs.providers[provider]?.tiers?.[tier];
  // Number.isFinite (not `> 0`) — 0/negative is a legitimate, documented
  // "unlimited" sentinel for a tier's own concurrency too, matching
  // isValid()'s tierOk() (which already accepts any finite value here) and
  // the Semaphore's own `limit <= 0` convention. The previous `> 0` check
  // silently discarded a tier's explicit unlimited sentinel and substituted
  // the unrelated global default instead — accepted by validation, ignored
  // by the only function that reads it.
  if (t?.concurrency !== undefined && Number.isFinite(t.concurrency)) return t.concurrency;
  return subs.defaults.cloudConcurrency;
}

/** Valid tier names for a provider (for validation / listing in setup). */
export function validTiers(provider: SubProvider, subs = loadSubscriptions()): string[] {
  return Object.keys(subs.providers[provider]?.tiers ?? {});
}

/**
 * Resolve per-provider concurrency limits from the selected tiers. API-keyed
 * providers (openai/anthropic/xai) use the apiConcurrency default; `local`
 * covers local Ollama + self-hosted servers. `overrides` (e.g. an explicit
 * CLOUD_CONCURRENCY/LOCAL_CONCURRENCY) win when provided.
 */
export function resolvePoolLimits(
  tiers: { chatgpt: string; claude: string; grok: string; ollama: string },
  overrides: { cloud?: number; local?: number } = {},
  subs = loadSubscriptions(),
  /**
   * How many council server processes share this machine's subscriptions.
   * The user runs one server per Claude Code session — up to five at once —
   * and the Semaphores enforcing these ceilings are per-process, so N
   * sessions otherwise run N× the account's intended concurrency. The
   * divisor applies ONLY to the four SUBSCRIPTION pools (chatgpt, claude,
   * grok, ollama-cloud), whose ceilings are account-wide plan limits;
   * API-keyed pools (openai/anthropic/xai) are pay-per-token with no shared
   * plan ceiling, and dividing them would just over-throttle. Default 1 =
   * exactly today's behaviour.
   */
  sessions = 1,
): Record<PoolKey, number> {
  // An explicit CLOUD_CONCURRENCY override collapses every cloud pool to that
  // ceiling; otherwise each pool comes from its tier (API-keyed providers use
  // the apiConcurrency default, since they're pay-per-token, not tier-gated).
  const cloud = overrides.cloud;
  // ceil, floored at 1: a session must never be starved to zero slots, and
  // rounding up biases toward finishing work over strict fairness.
  const share = (n: number): number =>
    sessions > 1 && n > 0 ? Math.max(1, Math.ceil(n / sessions)) : n;
  return {
    chatgpt: cloud ?? share(tierConcurrency('chatgpt', tiers.chatgpt, subs)),
    claude: cloud ?? share(tierConcurrency('claude', tiers.claude, subs)),
    grok: cloud ?? share(tierConcurrency('grok', tiers.grok, subs)),
    'ollama-cloud': cloud ?? share(tierConcurrency('ollama', tiers.ollama, subs)),
    openai: cloud ?? subs.defaults.apiConcurrency,
    anthropic: cloud ?? subs.defaults.apiConcurrency,
    xai: cloud ?? subs.defaults.apiConcurrency,
    local: overrides.local ?? subs.defaults.localConcurrency,
  };
}
