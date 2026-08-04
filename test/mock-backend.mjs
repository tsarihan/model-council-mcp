/**
 * Mock Ollama backend for deterministic end-to-end testing.
 *
 * Emulates:
 *   GET  /api/tags   → model list (small-a 7B, small-b 7B, big-judge 70B, vision-a 8B, …)
 *   POST /api/show   → per-model capabilities (vision-a + fake-vision-a report "vision"; others don't)
 *   POST /api/chat   → context-aware response:
 *                        • categorization prompt → judge JSON (counter-driven)
 *                        • synthesis prompt      → final answer text
 *                        • deconflict round      → member convergence stance
 *                        • OCR verification challenge → vision-a answers correctly (genuine
 *                          vision); fake-vision-a answers wrong (recreates the real SGLang/
 *                          qwen3.6-mlx false-positive: capabilities metadata claims vision,
 *                          the model can't actually read the image)
 *                        • normal question       → member opinion
 *                      also records the request's `images` array for wire-shape assertions
 *   POST /reset      → reset the categorization counter
 */
import http from 'node:http';
import { CHALLENGE_IMAGES, CHALLENGE_PROMPT } from '../dist/vision-challenge.js';

// base64 → code lookup, so the mock can answer (or deliberately misanswer) an
// OCR verification challenge without hardcoding any specific challenge image.
const CHALLENGE_BY_BASE64 = new Map(CHALLENGE_IMAGES.map(c => [c.base64, c.code]));

let categorizeCalls = 0;
let poolCalls = 0;
let challengeCalls = 0; // count of OCR-challenge requests — proves a seeded cache skips re-probing
let lastRepollPrompt = null;
let lastDefensePrompt = null;
let defensePrompts = {};
let lastSelectionPrompt = null;
let lastDossierPrompt = null;
let curConcurrent = 0;
let maxConcurrent = 0;
let lastNumPredict = null;
let flakyCalls = 0;
let lastUserPrompt = null;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const MODELS = [
  { name: 'small-a',   details: { parameter_size: '7B',  family: 'llama' }, size: 4_000_000_000 },
  { name: 'small-b',   details: { parameter_size: '7B',  family: 'mistral' }, size: 4_100_000_000 },
  { name: 'big-judge', details: { parameter_size: '70B', family: 'llama' }, size: 40_000_000_000 },
  // Cloud-proxied model (Ollama :cloud) — must be INCLUDED in auto-council
  { name: 'kimi-k2:cloud', details: { parameter_size: '1T', family: 'kimi' }, size: 0 },
  // Embedding model — must be EXCLUDED from auto-council
  { name: 'bge-m3',    details: { parameter_size: '567M', family: 'bert' }, size: 1_200_000_000 },
  // Vision-capable model, for vision-routing tests — reports "vision" in /api/show capabilities
  // AND correctly reads the OCR verification challenge (genuine vision).
  { name: 'vision-a',  details: { parameter_size: '8B',  family: 'llava' }, size: 5_000_000_000 },
  // A second genuinely vision-capable model — exists so a test can assert the vision-DETECTION
  // phase itself (not just the real query round) respects the `local` concurrency pool, since
  // probing 2+ local models' OCR challenges concurrently is exactly what thrashes memory on
  // hardware that can only hold one large local model at a time.
  { name: 'vision-b',  details: { parameter_size: '9B',  family: 'llava' }, size: 5_200_000_000 },
  // Reports "vision" in /api/show capabilities but answers the OCR challenge WRONG — recreates
  // the real false positive found live (a custom/quantized build whose metadata claims vision
  // support the underlying weights don't actually have). Stage 2 must exclude this model even
  // though stage 1 (capabilities metadata) says yes.
  { name: 'fake-vision-a', details: { parameter_size: '7B', family: 'qwen' }, size: 4_500_000_000 },
];

// /api/show capabilities per model name — everything not listed reports no vision.
const CAPABILITIES = {
  'vision-a': ['completion', 'tools', 'vision'],
  'vision-b': ['completion', 'tools', 'vision'],
  'fake-vision-a': ['completion', 'tools', 'vision'],
};

let lastImages = null; // last /api/chat request's `images` array on the user message, if any

// Per-prompt-type images, so a test can prove images reach MEMBER round-queries
// (repoll/defense/selection/deconflict-round) but never a JUDGE call (categorize/
// pool-digest/dossier) — `lastImages` alone can't distinguish this since it's
// just whatever the most recent call happened to carry.
let lastCategorizeImages = undefined;
let lastPoolDigestImages = undefined;
let lastDossierImages = undefined;
let lastRepollImages = undefined;
let lastDefenseImages = undefined;
let lastSelectionImages = undefined;
let lastDeconflictRoundImages = undefined;

// Judge categorization responses, indexed by call number.
function categorizationFor(call) {
  if (call === 1) {
    return {
      commonAgreement: 'All models agree that errors should be logged and observable.',
      complementary: [
        { aspect: 'tooling', models: ['ollama:small-a'], insight: 'use structured JSON logs' },
      ],
      conflicting: [
        {
          topic: 'retry strategy',
          positions: [
            { models: ['ollama:small-a'], position: 'exponential backoff' },
            { models: ['ollama:small-b'], position: 'fixed interval retry' },
          ],
        },
        {
          topic: 'caching approach',
          positions: [
            { models: ['ollama:small-a'], position: 'write-through cache' },
            { models: ['ollama:big-judge'], position: 'write-back cache' },
          ],
        },
      ],
    };
  }
  if (call === 2) {
    // round 1: retry resolved, caching still open
    return {
      commonAgreement: 'Council converged on exponential backoff for retries.',
      complementary: [],
      conflicting: [
        {
          topic: 'caching approach',
          positions: [
            { models: ['ollama:small-a'], position: 'write-through cache' },
            { models: ['ollama:big-judge'], position: 'write-back cache' },
          ],
        },
      ],
    };
  }
  // round 2+: everything resolved
  return {
    commonAgreement: 'Full consensus reached.',
    complementary: [],
    conflicting: [],
  };
}

// Neutral pooled digest (pooled/Delphi mode), indexed by call number.
// Call 1 = round-0 pool (two distinct options); call 2 = post-reconsideration
// pool (converged to one). Rationales are deliberately attribution-free.
function poolDigestFor(call) {
  if (call === 1) {
    return {
      options: [
        {
          answer: 'Exponential backoff',
          rationale: 'Retry with progressively longer delays to avoid overwhelming a struggling dependency.',
          models: ['ollama:small-a', 'ollama:big-judge'],
        },
        {
          answer: 'Fixed-interval retry',
          rationale: 'Retry on a simple constant cadence for predictability.',
          models: ['ollama:small-b'],
        },
      ],
    };
  }
  return {
    options: [
      {
        answer: 'Exponential backoff',
        rationale: 'A single converged approach: retry with increasing delays and clear observability.',
        models: ['ollama:small-a', 'ollama:small-b', 'ollama:big-judge'],
      },
    ],
  };
}

function chatResponse(body) {
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const content = lastUser?.content ?? '';
  const model = body.model ?? 'unknown';
  lastUserPrompt = content;
  lastImages = lastUser?.images ?? null;

  // OCR-challenge verification (stage 2 of vision detection): the orchestrator's
  // supportsVision() sends this exact prompt with one challenge image attached.
  // vision-a genuinely reads it; fake-vision-a accepts the image (stage-1 metadata
  // said vision) but answers with the wrong digits, same as the real SGLang bug.
  if (content === CHALLENGE_PROMPT && lastImages?.length) {
    challengeCalls++;
    const code = CHALLENGE_BY_BASE64.get(lastImages[0]);
    if (model === 'vision-a' || model === 'vision-b') return code ?? 'unknown';
    if (model === 'fake-vision-a') return '0000'; // clean, confident, wrong
  }

  // Flaky model: empty on first call, content afterwards (exercises retry-on-empty)
  if (model === 'flaky-empty') {
    flakyCalls++;
    return flakyCalls === 1 ? '' : 'Recovered after retry.';
  }

  // Always-empty model (exercises graceful degradation when the judge yields nothing)
  if (model === 'empty-judge') {
    return '';
  }

  // Judge that answers the INITIAL categorization validly (so a real conflict
  // exists and a deconfliction round loop actually runs), then degrades to
  // unparseable JSON on every later round — proves a mid-loop judge failure
  // can't be silently read as "the conflict is now resolved" (categorizeCalls
  // is shared across all models/tests, but each test resets it via /reset).
  if (model === 'flaky-judge' && content.includes('Categorize these responses')) {
    categorizeCalls++;
    if (categorizeCalls === 1) {
      return JSON.stringify({
        commonAgreement: 'Partial agreement on logging.',
        complementary: [],
        conflicting: [
          {
            topic: 'retry strategy',
            positions: [
              { models: ['ollama:small-a'], position: 'exponential backoff' },
              { models: ['ollama:small-b'], position: 'fixed interval retry' },
            ],
          },
        ],
      });
    }
    return '{not valid json';
  }

  if (content.includes('Categorize these responses')) {
    categorizeCalls++;
    lastCategorizeImages = lastImages;
    return JSON.stringify(categorizationFor(categorizeCalls));
  }

  if (content.includes('Synthesize a comprehensive final answer')) {
    return `SYNTHESIS: Log everything with structured JSON. Use exponential backoff for retries. ` +
           `(Caching may remain a judgment call.)`;
  }

  if (content.includes('[Deconfliction round')) {
    lastDeconflictRoundImages = lastImages;
    return `[${model}] After reconsidering, I can align with exponential backoff. ` +
           `On caching I still lean toward my original position.`;
  }

  // Pooled/Delphi: judge distils responses into a neutral digest.
  if (content.includes('pooled digest')) {
    poolCalls++;
    lastPoolDigestImages = lastImages;
    return JSON.stringify(poolDigestFor(poolCalls));
  }

  // Pooled/Delphi: member re-poll against the neutral, attribution-free digest.
  if (content.includes('in no particular order')) {
    lastRepollPrompt = content;
    lastRepollImages = lastImages;
    const reconsidered = {
      'small-a': 'On reflection I keep exponential backoff; write-through caching is non-essential.',
      'small-b': 'Weighing the pooled reasoning, I move from fixed-interval to exponential backoff.',
      'big-judge': 'Exponential backoff with strong observability; caching is a separate concern.',
    };
    return reconsidered[model] ?? `[${model}] reconsidered opinion.`;
  }

  // Dialectic: judge compiles the pros/cons dossier (capitalised marker is unique).
  if (content.includes('DIALECTICAL pros/cons')) {
    lastDossierImages = lastImages;
    lastDossierPrompt = content; // the one prompt showing thesis + antithesis together
    return JSON.stringify({
      options: [
        {
          answer: 'Exponential backoff',
          pros: ['Adapts to load', 'Avoids overwhelming a struggling dependency'],
          cons: ['More complex to implement', 'Longer worst-case latency'],
        },
        {
          answer: 'Fixed-interval retry',
          pros: ['Simple and predictable'],
          cons: ['Can hammer a failing service', 'No adaptive backpressure'],
        },
      ],
    });
  }

  // Dialectic: member defends its initial pick and critiques the alternatives.
  if (content.includes('Defend your initial selection')) {
    lastDefensePrompt = content;
    lastDefenseImages = lastImages;
    defensePrompts[model] = content; // per-member, for index-alignment assertions
    const defense = {
      'small-a': 'Defending exponential backoff: it adapts to load; fixed-interval risks hammering a down service.',
      'small-b': 'Defending fixed-interval: simplicity wins; backoff adds complexity for marginal gain.',
      'big-judge': 'Backoff with observability beats fixed-interval, which lacks adaptive backpressure.',
    };
    return defense[model] ?? `[${model}] defense.`;
  }

  // Dialectic: member re-selects a ranked top-3 from the pros/cons dossier.
  if (content.includes('Weighing both sides')) {
    lastSelectionPrompt = content;
    lastSelectionImages = lastImages;
    return `#1 Exponential backoff — adaptive under load, accepting added complexity.\n` +
           `#2 Fixed-interval retry — a simple fallback where predictability matters.`;
  }

  // Normal first-pass member opinion — vary by model so responses differ
  const opinions = {
    'small-a':   'Handle errors with exponential backoff and write-through caching. Log as JSON.',
    'small-b':   'Use fixed-interval retries. Keep it simple. Log to stderr.',
    'big-judge': 'Prefer write-back caching for throughput; retries need backoff. Ensure observability.',
  };
  return opinions[model] ?? `[${model}] generic opinion.`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: MODELS }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/show') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      const capabilities = CAPABILITIES[body.model] ?? ['completion'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model_info: {}, capabilities }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/reset') {
    categorizeCalls = 0;
    poolCalls = 0;
    challengeCalls = 0;
    lastRepollPrompt = null;
    lastDefensePrompt = null;
    defensePrompts = {};
    lastSelectionPrompt = null;
    lastDossierPrompt = null;
    maxConcurrent = 0;
    flakyCalls = 0;
    lastNumPredict = null;
    lastUserPrompt = null;
    lastImages = null;
    lastCategorizeImages = undefined;
    lastPoolDigestImages = undefined;
    lastDossierImages = undefined;
    lastRepollImages = undefined;
    lastDefenseImages = undefined;
    lastSelectionImages = undefined;
    lastDeconflictRoundImages = undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      maxConcurrent, lastNumPredict, lastRepollPrompt, lastDefensePrompt, defensePrompts,
      lastSelectionPrompt, lastDossierPrompt, lastUserPrompt, lastImages, challengeCalls,
      lastCategorizeImages, lastPoolDigestImages, lastDossierImages,
      lastRepollImages, lastDefenseImages, lastSelectionImages, lastDeconflictRoundImages,
    }));
    return;
  }

  // Anthropic Messages API — used by the claude CLI harness (ANTHROPIC_BASE_URL
  // points here when a cloud model is routed through claude-cli-ollama).
  if (req.method === 'POST' && req.url === '/v1/messages') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      // Extract content from Anthropic format (content can be string or array)
      const msgs = body.messages ?? [];
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      let textContent = '';
      if (typeof lastUser?.content === 'string') {
        textContent = lastUser.content;
      } else if (Array.isArray(lastUser?.content)) {
        textContent = lastUser.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      }
      // Reuse the Ollama chat logic by constructing an equivalent body
      const ollamaBody = { model: body.model ?? 'unknown', messages: [{ role: 'user', content: textContent }] };
      const responseText = chatResponse(ollamaBody);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        model: body.model ?? 'unknown',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      if (body?.options?.num_predict !== undefined) lastNumPredict = body.options.num_predict;
      curConcurrent++;
      if (curConcurrent > maxConcurrent) maxConcurrent = curConcurrent;
      try {
        // 'conc*' models add latency so concurrency limits are observable
        if (typeof body.model === 'string' && body.model.startsWith('conc')) {
          await delay(60);
        }
        // 'slow-timeout' model sleeps well past a short test timeout so the
        // per-completion timeout cuts it — exercises the timeoutNotice path.
        if (body.model === 'slow-timeout') {
          await delay(3000);
        }
        const contentText = chatResponse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: contentText } }));
      } finally {
        curConcurrent--;
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const PORT = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 11499;
server.listen(PORT, () => {
  process.stdout.write(`mock-backend listening on http://localhost:${PORT}\n`);
});
