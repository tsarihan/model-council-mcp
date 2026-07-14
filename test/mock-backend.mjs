/**
 * Mock Ollama backend for deterministic end-to-end testing.
 *
 * Emulates:
 *   GET  /api/tags   → model list (small-a 7B, small-b 7B, big-judge 70B)
 *   POST /api/chat   → context-aware response:
 *                        • categorization prompt → judge JSON (counter-driven)
 *                        • synthesis prompt      → final answer text
 *                        • deconflict round      → member convergence stance
 *                        • normal question       → member opinion
 *   POST /reset      → reset the categorization counter
 */
import http from 'node:http';

let categorizeCalls = 0;
let poolCalls = 0;
let lastRepollPrompt = null;
let curConcurrent = 0;
let maxConcurrent = 0;
let lastNumPredict = null;
let flakyCalls = 0;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const MODELS = [
  { name: 'small-a',   details: { parameter_size: '7B',  family: 'llama' }, size: 4_000_000_000 },
  { name: 'small-b',   details: { parameter_size: '7B',  family: 'mistral' }, size: 4_100_000_000 },
  { name: 'big-judge', details: { parameter_size: '70B', family: 'llama' }, size: 40_000_000_000 },
  // Cloud-proxied model (Ollama :cloud) — must be INCLUDED in auto-council
  { name: 'kimi-k2:cloud', details: { parameter_size: '1T', family: 'kimi' }, size: 0 },
  // Embedding model — must be EXCLUDED from auto-council
  { name: 'bge-m3',    details: { parameter_size: '567M', family: 'bert' }, size: 1_200_000_000 },
];

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

  // Flaky model: empty on first call, content afterwards (exercises retry-on-empty)
  if (model === 'flaky-empty') {
    flakyCalls++;
    return flakyCalls === 1 ? '' : 'Recovered after retry.';
  }

  // Always-empty model (exercises graceful degradation when the judge yields nothing)
  if (model === 'empty-judge') {
    return '';
  }

  if (content.includes('Categorize these responses')) {
    categorizeCalls++;
    return JSON.stringify(categorizationFor(categorizeCalls));
  }

  if (content.includes('Synthesize a comprehensive final answer')) {
    return `SYNTHESIS: Log everything with structured JSON. Use exponential backoff for retries. ` +
           `(Caching may remain a judgment call.)`;
  }

  if (content.includes('[Deconfliction round')) {
    return `[${model}] After reconsidering, I can align with exponential backoff. ` +
           `On caching I still lean toward my original position.`;
  }

  // Pooled/Delphi: judge distils responses into a neutral digest.
  if (content.includes('pooled digest')) {
    poolCalls++;
    return JSON.stringify(poolDigestFor(poolCalls));
  }

  // Pooled/Delphi: member re-poll against the neutral, attribution-free digest.
  if (content.includes('in no particular order')) {
    lastRepollPrompt = content;
    const reconsidered = {
      'small-a': 'On reflection I keep exponential backoff; write-through caching is non-essential.',
      'small-b': 'Weighing the pooled reasoning, I move from fixed-interval to exponential backoff.',
      'big-judge': 'Exponential backoff with strong observability; caching is a separate concern.',
    };
    return reconsidered[model] ?? `[${model}] reconsidered opinion.`;
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

  if (req.method === 'POST' && req.url === '/reset') {
    categorizeCalls = 0;
    poolCalls = 0;
    lastRepollPrompt = null;
    maxConcurrent = 0;
    flakyCalls = 0;
    lastNumPredict = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ maxConcurrent, lastNumPredict, lastRepollPrompt }));
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
