/**
 * Unit tests for Phase 1: subscription reference data, tier → per-provider
 * concurrency derivation, poolKey bucketing, and persistent state round-trip.
 * Runs against the built dist/ modules (pure functions — no server needed).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadSubscriptions, resolvePoolLimits, tierAllowsCloud, tierConcurrency, validTiers,
} from '../dist/subscriptions.js';
import { poolKey } from '../dist/council/query.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const member = (type, model) => ({ modelId: { provider: type, model }, provider: { config: { type } } });

console.log('▶ subscriptions reference data');
const subs = loadSubscriptions();
check('loads valid subscriptions', !!subs.providers.chatgpt && subs.curatedCloudModels.length >= 5);
check('curated cloud models are :cloud/-cloud', subs.curatedCloudModels.every(m => m.endsWith(':cloud') || m.endsWith('-cloud')));

console.log('▶ tier → cloud + concurrency');
check('chatgpt/plus cloud on, conc 6', tierAllowsCloud('chatgpt', 'plus') && tierConcurrency('chatgpt', 'plus') === 6);
check('claude/max20x conc 8', tierConcurrency('claude', 'max20x') === 8);
check('ollama/pro conc 3, max conc 10', tierConcurrency('ollama', 'pro') === 3 && tierConcurrency('ollama', 'max') === 10);
check('free tiers deny cloud', !tierAllowsCloud('ollama', 'free') && !tierAllowsCloud('claude', 'free') && !tierAllowsCloud('chatgpt', 'free'));
check('unknown tier denies cloud (safe)', !tierAllowsCloud('ollama', 'bogus'));
check('validTiers lists ollama tiers', validTiers('ollama').includes('max') && validTiers('ollama').includes('free'));

console.log('▶ resolvePoolLimits');
const limits = resolvePoolLimits({ chatgpt: 'plus', claude: 'pro', ollama: 'max' });
check('chatgpt pool = 6', limits.chatgpt === 6, `got ${limits.chatgpt}`);
check('claude pool = 2', limits.claude === 2, `got ${limits.claude}`);
check('ollama-cloud pool = 10', limits['ollama-cloud'] === 10, `got ${limits['ollama-cloud']}`);
check('api pools = apiConcurrency default', limits.openai === subs.defaults.apiConcurrency && limits.groq === subs.defaults.apiConcurrency);
check('local pool = default 1', limits.local === subs.defaults.localConcurrency);
const overridden = resolvePoolLimits({ chatgpt: 'plus', claude: 'pro', ollama: 'max' }, { cloud: 2, local: 0 });
check('explicit cloud override collapses cloud pools', overridden.chatgpt === 2 && overridden.claude === 2 && overridden['ollama-cloud'] === 2 && overridden.openai === 2);
check('explicit local override applied', overridden.local === 0);
// Regression: an override equal to the cloud default must still apply to API pools.
const eqDefault = resolvePoolLimits({ chatgpt: 'plus', claude: 'pro', ollama: 'max' }, { cloud: subs.defaults.cloudConcurrency });
check('override == default still applies to API pools', eqDefault.openai === subs.defaults.cloudConcurrency, `got ${eqDefault.openai}`);

console.log('▶ poolKey bucketing');
check('codex-cli → chatgpt', poolKey(member('codex-cli', 'gpt-5.6-sol')) === 'chatgpt');
check('claude-cli → claude', poolKey(member('claude-cli', 'opus')) === 'claude');
check('openai → openai', poolKey(member('openai', 'gpt-4o')) === 'openai');
check('anthropic → anthropic', poolKey(member('anthropic', 'claude-opus-4-8')) === 'anthropic');
check('groq → groq', poolKey(member('groq', 'llama-3')) === 'groq');
check('ollama :cloud → ollama-cloud', poolKey(member('ollama', 'glm-5.2:cloud')) === 'ollama-cloud');
check('ollama -cloud → ollama-cloud', poolKey(member('ollama', 'qwen3-coder:480b-cloud')) === 'ollama-cloud');
check('ollama local → local', poolKey(member('ollama', 'gemma4:31b-mlx')) === 'local');
check('vllm (self-hosted) → local', poolKey(member('vllm', 'meta-llama/Llama-3')) === 'local');

console.log('▶ per-provider pools drain independently at their own limits');
{
  const { queryMembersVarying } = await import('../dist/council/query.js');
  const tracker = { inflight: 0, peak: 0, poolInflight: {}, poolPeak: {} };
  const fake = (type) => ({
    config: { type },
    complete: async (model) => {
      const pool = (model.endsWith(':cloud') || model.endsWith('-cloud')) ? 'ollama-cloud' : type;
      tracker.inflight++; tracker.peak = Math.max(tracker.peak, tracker.inflight);
      tracker.poolInflight[pool] = (tracker.poolInflight[pool] || 0) + 1;
      tracker.poolPeak[pool] = Math.max(tracker.poolPeak[pool] || 0, tracker.poolInflight[pool]);
      await new Promise(r => setTimeout(r, 40));
      tracker.inflight--; tracker.poolInflight[pool]--;
      return 'ok';
    },
  });
  const members = [
    ...Array.from({ length: 6 }, (_, i) => ({ modelId: { provider: 'openai', model: `gpt-${i}` }, provider: fake('openai') })),
    ...Array.from({ length: 4 }, (_, i) => ({ modelId: { provider: 'ollama', model: `m${i}:cloud` }, provider: fake('ollama') })),
  ];
  const runtime = {
    maxTokens: 50, retries: 1, cloudConcurrency: 3, localConcurrency: 1, verbose: false,
    poolLimits: { chatgpt: 1, claude: 1, openai: 6, anthropic: 1, groq: 1, 'ollama-cloud': 3, local: 1 },
  };
  const res = await queryMembersVarying(() => 'q', members, runtime);
  check('drain: all 10 members answered', res.length === 10 && res.every(r => r.response === 'ok'));
  // openai pool (6) + ollama-cloud pool (3) drain concurrently → global peak 9.
  // Under the old single-"cloud"-bucket scheme this would cap at cloudConcurrency (3).
  check('drain: two cloud pools run concurrently (peak 6+3=9)', tracker.peak === 9, `peak=${tracker.peak}`);
  check('drain: openai pool capped at its own limit (6)', tracker.poolPeak.openai === 6, `got ${tracker.poolPeak.openai}`);
  check('drain: ollama-cloud pool capped at its own limit (3)', tracker.poolPeak['ollama-cloud'] === 3, `got ${tracker.poolPeak['ollama-cloud']}`);
}

console.log('▶ persistent state round-trip');
const dir = mkdtempSync(join(tmpdir(), 'mc-state-'));
process.env.MODEL_COUNCIL_STATE = join(dir, 'state.json');
const { loadState, saveState, statePath } = await import('../dist/state.js');
try {
  check('empty state loads a default', loadState().version >= 1);
  saveState({ tiers: { ollama: 'max' }, members: ['ollama:x'] });
  const reloaded = loadState();
  check('saved tiers persist', reloaded.tiers?.ollama === 'max', JSON.stringify(reloaded));
  check('saved members persist', Array.isArray(reloaded.members) && reloaded.members[0] === 'ollama:x');
  check('statePath honours MODEL_COUNCIL_STATE', statePath() === process.env.MODEL_COUNCIL_STATE);
} finally {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MODEL_COUNCIL_STATE;
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('ALL PASSED ✅');
