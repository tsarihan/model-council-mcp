/**
 * End-to-end test: spawn the built MCP server over stdio (pointed at the mock
 * backend) and drive all 4 tools + 3 response modes via the MCP protocol.
 */
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MOCK_PORT = 11499;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const MOCK_CLAUDE = fileURLToPath(new URL('./mock-claude.mjs', import.meta.url));
const MOCK_CODEX = fileURLToPath(new URL('./mock-codex.mjs', import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`  ❌ ${name}  ${detail}`);
  }
}

async function resetMock() {
  await fetch(`${MOCK_URL}/reset`, { method: 'POST' });
}

// Parse the JSON text payload from a tool result
function parseToolResult(result) {
  const text = result.content?.[0]?.text ?? '{}';
  return JSON.parse(text);
}

async function main() {
  // ── 1. Start mock backend ──────────────────────────────────────────────────
  const mock = spawn('node', ['test/mock-backend.mjs'], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stdout.on('data', d => process.stdout.write(`[mock] ${d}`));
  mock.stderr.on('data', d => process.stderr.write(`[mock-err] ${d}`));

  // Wait for mock to be ready
  await new Promise(r => setTimeout(r, 600));

  // ── 2. Start MCP server as subprocess, connect client ───────────────────────
  const serverEntry = process.env.SERVER_ENTRY ?? 'dist/index.js';
  console.log(`(server entry: ${serverEntry})`);
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    env: {
      ...process.env,
      OLLAMA_ADDRESS: MOCK_URL,
      COUNCIL_MODELS: 'ollama:small-a,ollama:small-b,ollama:big-judge',
      RESPONSE_MODE: 'categorized',
      MAX_DECONFLICT_ROUNDS: '3',
      CLOUD_CONCURRENCY: '2',
      LOCAL_CONCURRENCY: '1',
    },
  });

  const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    // ── Test: tools are listed ────────────────────────────────────────────────
    console.log('\n▶ list tools');
    const tools = await client.listTools();
    const toolNames = tools.tools.map(t => t.name).sort();
    check('4 tools exposed', toolNames.length === 4, `got ${toolNames.join(',')}`);
    check('has ask_council', toolNames.includes('ask_council'));
    check('has configure_council', toolNames.includes('configure_council'));
    check('has list_models', toolNames.includes('list_models'));
    check('has get_council_config', toolNames.includes('get_council_config'));

    // ── Test: list_models ─────────────────────────────────────────────────────
    console.log('\n▶ list_models');
    const lm = parseToolResult(await client.callTool({ name: 'list_models', arguments: {} }));
    check('lists all 5 models (incl. cloud + embedding)', lm.total === 5, `got ${lm.total}`);
    check('big-judge present', lm.models.some(m => m.model === 'big-judge'));
    check('cloud model present', lm.models.some(m => m.model === 'kimi-k2:cloud'));
    check('embedding model present in list', lm.models.some(m => m.model === 'bge-m3'));
    check('param size surfaced', lm.models.find(m => m.model === 'big-judge')?.paramSize === '70B');

    // ── Test: individual mode ─────────────────────────────────────────────────
    console.log('\n▶ ask_council (individual)');
    await resetMock();
    const ind = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'individual' },
    }));
    check('mode individual', ind.mode === 'individual');
    check('3 responses', ind.responses?.length === 3, `got ${ind.responses?.length}`);
    check('all responses non-empty', ind.responses?.every(r => r.response && !r.error));
    check('responses differ', new Set(ind.responses.map(r => r.response)).size === 3);
    check('latency recorded', ind.responses?.every(r => typeof r.latencyMs === 'number'));

    // ── Test: categorized mode ────────────────────────────────────────────────
    console.log('\n▶ ask_council (categorized)');
    await resetMock();
    const cat = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'categorized' },
    }));
    check('mode categorized', cat.mode === 'categorized');
    check('common agreement present', typeof cat.commonAgreement === 'string' && cat.commonAgreement.length > 0);
    check('1 complementary item', cat.complementary?.length === 1, `got ${cat.complementary?.length}`);
    check('2 conflicts', cat.conflicting?.length === 2, `got ${cat.conflicting?.length}`);
    check('conflicts have ids', cat.conflicting?.every(c => c.id?.startsWith('conflict-')));
    check('judge is big-judge (auto = largest)', cat.judgeModel === 'ollama:big-judge', `got ${cat.judgeModel}`);
    check('raw responses included', cat.rawResponses?.length === 3);

    // ── Test: deconflicted mode — full resolution ─────────────────────────────
    console.log('\n▶ ask_council (deconflicted, maxRounds=3 → full resolve)');
    await resetMock();
    const dec = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'deconflicted', max_deconflict_rounds: 3 },
    }));
    check('mode deconflicted', dec.mode === 'deconflicted');
    check('total conflicts 2', dec.totalConflicts === 2, `got ${dec.totalConflicts}`);
    check('resolved 2', dec.resolved === 2, `got ${dec.resolved}`);
    check('score 100', dec.deconflictionScore === 100, `got ${dec.deconflictionScore}`);
    check('rounds taken 2', dec.roundsTaken === 2, `got ${dec.roundsTaken}`);
    check('no unresolved conflicts', dec.unresolvedConflicts?.length === 0, `got ${dec.unresolvedConflicts?.length}`);
    check('round history length 2', dec.roundHistory?.length === 2, `got ${dec.roundHistory?.length}`);
    check('synthesis present', typeof dec.finalSynthesis === 'string' && dec.finalSynthesis.includes('SYNTHESIS'));
    check('round1 resolved 1', dec.roundHistory?.[0]?.conflictsResolved === 1, JSON.stringify(dec.roundHistory?.[0]));

    // ── Test: deconflicted mode — partial (maxRounds=1) ───────────────────────
    console.log('\n▶ ask_council (deconflicted, maxRounds=1 → partial n/m)');
    await resetMock();
    const part = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'deconflicted', max_deconflict_rounds: 1 },
    }));
    check('partial: total 2', part.totalConflicts === 2, `got ${part.totalConflicts}`);
    check('partial: resolved 1', part.resolved === 1, `got ${part.resolved}`);
    check('partial: score 50', part.deconflictionScore === 50, `got ${part.deconflictionScore}`);
    check('partial: rounds 1', part.roundsTaken === 1, `got ${part.roundsTaken}`);
    check('partial: 1 unresolved', part.unresolvedConflicts?.length === 1, `got ${part.unresolvedConflicts?.length}`);
    check('partial: unresolved is caching', /caching/i.test(part.unresolvedConflicts?.[0]?.topic ?? ''));

    // ── Test: pooled (Delphi) mode ────────────────────────────────────────────
    console.log('\n▶ ask_council (pooled — Delphi neutral reconsideration)');
    await resetMock();
    const pool = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'pooled', verbose: true },
    }));
    check('pooled: mode pooled', pool.mode === 'pooled');
    check('pooled: judge is big-judge', pool.judgeModel === 'ollama:big-judge', `got ${pool.judgeModel}`);
    check('pooled: initial pool has 2 options', pool.initialPool?.options?.length === 2, `got ${pool.initialPool?.options?.length}`);
    check('pooled: option has answer + rationale', typeof pool.initialPool?.options?.[0]?.answer === 'string' && typeof pool.initialPool?.options?.[0]?.rationale === 'string');
    check('pooled: option records models (for analysis)', Array.isArray(pool.initialPool?.options?.[0]?.models));
    check('pooled: all 3 members reconsidered', pool.reconsidered?.length === 3, `got ${pool.reconsidered?.length}`);
    check('pooled: final pool converged to 1', pool.finalPool?.options?.length === 1, `got ${pool.finalPool?.options?.length}`);
    check('pooled: verbose includes round-0 responses', pool.initialResponses?.length === 3, `got ${pool.initialResponses?.length}`);
    // Neutrality: the prompt shown to members must carry NO attribution/labels.
    const dbgPool = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('pooled: re-poll prompt framed "in no particular order"', /in no particular order/.test(dbgPool.lastRepollPrompt ?? ''));
    check('pooled: re-poll prompt shows the pooled answers', /Exponential backoff/.test(dbgPool.lastRepollPrompt ?? ''));
    check('pooled: re-poll prompt leaks NO model attribution', !!dbgPool.lastRepollPrompt && !/ollama:|small-a|small-b|big-judge/.test(dbgPool.lastRepollPrompt));

    // verbose off → round-0 responses omitted
    await resetMock();
    const poolQuiet = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'pooled' },
    }));
    check('pooled: non-verbose omits round-0 responses', poolQuiet.initialResponses === undefined);

    // ── Test: dialectic mode (thesis → antithesis → synthesis) ────────────────
    console.log('\n▶ ask_council (dialectic — defend / pros-cons / re-select)');
    await resetMock();
    const dia = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'dialectic', verbose: true },
    }));
    check('dialectic: mode dialectic', dia.mode === 'dialectic');
    check('dialectic: judge is big-judge', dia.judgeModel === 'ollama:big-judge', `got ${dia.judgeModel}`);
    check('dialectic: 3 members defended', dia.defenses?.length === 3, `got ${dia.defenses?.length}`);
    check('dialectic: pros/cons has 2 options', dia.prosCons?.length === 2, `got ${dia.prosCons?.length}`);
    const backoff = dia.prosCons?.find(o => /Exponential backoff/i.test(o.answer));
    check('dialectic: option has non-empty pros AND cons', backoff?.pros?.length > 0 && backoff?.cons?.length > 0);
    check('dialectic: option records championedBy', Array.isArray(backoff?.championedBy) && backoff.championedBy.includes('ollama:small-a'));
    check('dialectic: 3 members re-selected', dia.selections?.length === 3, `got ${dia.selections?.length}`);
    check('dialectic: verbose includes thesis responses', dia.initialResponses?.length === 3, `got ${dia.initialResponses?.length}`);
    // Structure: defense prompt is personalised; selection prompt carries the dossier.
    const dbgDia = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('dialectic: defense prompt asks to defend + shows own answer', /Defend your initial selection/.test(dbgDia.lastDefensePrompt ?? '') && /Your initial answer was/.test(dbgDia.lastDefensePrompt ?? ''));
    check('dialectic: selection prompt shows pros AND cons', /Pros:/.test(dbgDia.lastSelectionPrompt ?? '') && /Cons:/.test(dbgDia.lastSelectionPrompt ?? ''));
    // Per-member alignment: each member's defense prompt embeds ITS OWN thesis
    // (unique tokens: small-a=write-through, big-judge=write-back, small-b=stderr).
    // Catches a constant-index or off-by-one regression in queryMembersVarying.
    const dp = dbgDia.defensePrompts ?? {};
    check('dialectic: small-a defense embeds its own thesis (write-through, not write-back)', /write-through/.test(dp['small-a'] ?? '') && !/write-back/.test(dp['small-a'] ?? ''));
    check('dialectic: big-judge defense embeds its own thesis (write-back, not write-through)', /write-back/.test(dp['big-judge'] ?? '') && !/write-through/.test(dp['big-judge'] ?? ''));
    check('dialectic: small-b defense embeds its own thesis (stderr)', /stderr/.test(dp['small-b'] ?? ''));

    // verbose off → thesis responses omitted
    await resetMock();
    const diaQuiet = parseToolResult(await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'dialectic' },
    }));
    check('dialectic: non-verbose omits thesis responses', diaQuiet.initialResponses === undefined);

    // Graceful degradation: judge yields nothing → empty digest → empty pros/cons →
    // members re-asked the bare question (no crash, no dossier).
    await resetMock();
    const diaEmpty = parseToolResult(await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b', 'ollama:big-judge'], judge_model: 'ollama:empty-judge', response_mode: 'dialectic' },
    }));
    check('dialectic: empty-judge configured', diaEmpty.status === 'updated');
    const diaDeg = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'dialectic' },
    }));
    check('dialectic: empty judge → mode still dialectic (no crash)', diaDeg.mode === 'dialectic');
    check('dialectic: empty judge → no pros/cons', diaDeg.prosCons?.length === 0, `got ${diaDeg.prosCons?.length}`);
    check('dialectic: empty judge → members still re-selected', diaDeg.selections?.length === 3, `got ${diaDeg.selections?.length}`);
    const dbgDeg = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('dialectic: empty judge → selection falls back to bare question (no dossier)', dbgDeg.lastSelectionPrompt === null);

    // ── Test: configure_council + get_council_config ──────────────────────────
    console.log('\n▶ configure_council / get_council_config');
    const conf = parseToolResult(await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], response_mode: 'individual', max_deconflict_rounds: 5 },
    }));
    check('config updated', conf.status === 'updated');
    check('2 members set', conf.council?.members?.length === 2, `got ${conf.council?.members?.length}`);
    const gcfg = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('config persisted: mode', gcfg.council?.responseMode === 'individual', `got ${gcfg.council?.responseMode}`);
    check('config persisted: rounds', gcfg.council?.maxDeconflictRounds === 5, `got ${gcfg.council?.maxDeconflictRounds}`);
    check('providers reported', Array.isArray(gcfg.providers) && gcfg.providers.length >= 1);

    // ── Test: ZERO-CONFIG auto-council ────────────────────────────────────────
    console.log('\n▶ auto-council (empty config → discover Ollama models)');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: [], judge_model: 'auto', auto_council: true, response_mode: 'individual' },
    });
    const autoInd = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'auto test' },
    }));
    const autoLabels = autoInd.responses.map(r => r.label);
    check('auto-council: 4 chat members (5 models − 1 embedding)', autoInd.responses.length === 4, `got ${autoInd.responses.length}: ${autoLabels.join(',')}`);
    check('auto-council includes :cloud model', autoLabels.includes('ollama:kimi-k2:cloud'));
    check('auto-council EXCLUDES embedding model', !autoLabels.some(l => l.includes('bge-m3')));

    // get_council_config reflects auto membership
    const autoCfg = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('config reports auto source', /auto/i.test(autoCfg.council?.membershipSource ?? ''), autoCfg.council?.membershipSource);
    check('config auto members = 4', autoCfg.council?.members?.length === 4, `got ${autoCfg.council?.members?.length}`);

    // auto-council categorized → judge auto-picks the 1T cloud model (tests T→B parsing)
    await resetMock();
    const autoCat = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'auto cat', mode: 'categorized' },
    }));
    check('auto-council judge = largest (1T cloud)', autoCat.judgeModel === 'ollama:kimi-k2:cloud', `got ${autoCat.judgeModel}`);

    // ── Test: explicit judge override ─────────────────────────────────────────
    console.log('\n▶ explicit judge override');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b', 'ollama:big-judge'], judge_model: 'ollama:small-b', response_mode: 'categorized' },
    });
    const cat2 = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'test', mode: 'categorized' },
    }));
    check('explicit judge used', cat2.judgeModel === 'ollama:small-b', `got ${cat2.judgeModel}`);

    // ── Test: max_tokens default (16k) reaches the backend ────────────────────
    console.log('\n▶ max_tokens default');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a'], response_mode: 'individual' },
    });
    await client.callTool({ name: 'ask_council', arguments: { question: 'mt', mode: 'individual' } });
    const dbgMt = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('max_tokens default is 16000', dbgMt.lastNumPredict === 16000, `got ${dbgMt.lastNumPredict}`);

    // ── Test: empty-response retry ────────────────────────────────────────────
    console.log('\n▶ empty-response retry');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:flaky-empty'], response_mode: 'individual' },
    });
    const rr = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'retry?', mode: 'individual' },
    }));
    check('retry recovers empty response', /Recovered/.test(rr.responses?.[0]?.response ?? ''), `got "${rr.responses?.[0]?.response}" err=${rr.responses?.[0]?.error}`);
    check('recovered response has no error', !rr.responses?.[0]?.error);

    // ── Test: cloud concurrency limit (CLOUD_CONCURRENCY=2) ────────────────────
    console.log('\n▶ cloud concurrency limit');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:conc1:cloud', 'ollama:conc2:120b-cloud', 'ollama:conc3:cloud', 'ollama:conc4:480b-cloud'], response_mode: 'individual' },
    });
    const ccRes = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'cloud', mode: 'individual' },
    }));
    const dbgCloud = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('all 4 cloud members answered', ccRes.responses?.length === 4, `got ${ccRes.responses?.length}`);
    check('cloud concurrency capped at 2', dbgCloud.maxConcurrent === 2, `maxConcurrent=${dbgCloud.maxConcurrent}`);

    // ── Test: local concurrency limit (LOCAL_CONCURRENCY=1 → sequential) ───────
    console.log('\n▶ local concurrency limit');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:concL1', 'ollama:concL2', 'ollama:concL3'], response_mode: 'individual' },
    });
    const lcRes = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'local', mode: 'individual' },
    }));
    const dbgLocal = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('all 3 local members answered', lcRes.responses?.length === 3, `got ${lcRes.responses?.length}`);
    check('local concurrency is sequential (1)', dbgLocal.maxConcurrent === 1, `maxConcurrent=${dbgLocal.maxConcurrent}`);

    // ── Test: per-provider pools drain independently (cloud + local in parallel) ─
    console.log('\n▶ per-provider pools run in parallel');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:conc1:cloud', 'ollama:conc2:cloud', 'ollama:conc3:cloud', 'ollama:concLa', 'ollama:concLb'], response_mode: 'individual' },
    });
    const mixRes = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'mix', mode: 'individual' },
    }));
    const dbgMix = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('per-pool: 5 members answered', mixRes.responses?.length === 5, `got ${mixRes.responses?.length}`);
    // ollama-cloud pool (limit 2) + local pool (limit 1) drain concurrently → global max 3
    check('per-pool: cloud(2)+local(1) run concurrently → max 3', dbgMix.maxConcurrent === 3, `maxConcurrent=${dbgMix.maxConcurrent}`);

    // ── Test: deconflicted verbose ────────────────────────────────────────────
    console.log('\n▶ deconflicted verbose');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b', 'ollama:big-judge'], judge_model: 'auto', response_mode: 'deconflicted' },
    });
    const dv = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'deconflicted', max_deconflict_rounds: 3, verbose: true },
    }));
    check('verbose: initialCategorization present', dv.initialCategorization && Array.isArray(dv.initialCategorization.conflicting), Object.keys(dv).join(','));
    check('verbose: initial conflicts = 2', dv.initialCategorization?.conflicting?.length === 2, `got ${dv.initialCategorization?.conflicting?.length}`);
    check('verbose: initialResponses = 3', Array.isArray(dv.initialResponses) && dv.initialResponses.length === 3, `got ${dv.initialResponses?.length}`);
    check('verbose: rounds array present', Array.isArray(dv.rounds), `got ${typeof dv.rounds}`);
    check('verbose: rounds match roundsTaken', dv.rounds?.length === dv.roundsTaken, `rounds=${dv.rounds?.length} taken=${dv.roundsTaken}`);
    check('verbose: round detail has responses', dv.rounds?.[0]?.responses?.length === 3, `got ${dv.rounds?.[0]?.responses?.length}`);

    // ── Test: non-verbose deconflicted omits verbose detail ───────────────────
    console.log('\n▶ deconflicted non-verbose omits detail');
    await resetMock();
    const dnv = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'deconflicted', max_deconflict_rounds: 3 },
    }));
    check('non-verbose: no rounds field', dnv.rounds === undefined);
    check('non-verbose: no initialCategorization field', dnv.initialCategorization === undefined);

    // ── Test: empty judge degrades gracefully (retry, then no-conflict fallback) ─
    console.log('\n▶ empty judge graceful degradation');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], judge_model: 'ollama:empty-judge', response_mode: 'categorized' },
    });
    const ej = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'categorized' },
    }));
    check('empty judge → still returns a categorized result', ej.mode === 'categorized', `got mode=${ej.mode}`);
    check('empty judge → no-conflict fallback', Array.isArray(ej.conflicting) && ej.conflicting.length === 0, `conflicting=${JSON.stringify(ej.conflicting)}`);
    check('empty judge → member answers preserved', ej.rawResponses?.length === 2, `got ${ej.rawResponses?.length}`);

  } finally {
    await client.close();
    mock.kill();
  }

  // ── Test: claude-cli subscription provider (isolated server instance) ──────
  console.log('\n▶ claude-cli subscription provider (mocked claude binary)');
  chmodSync(MOCK_CLAUDE, 0o755);
  const cliTransport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    env: {
      ...process.env,
      OLLAMA_ADDRESS: 'http://127.0.0.1:1',                 // unused; harmless
      ANTHROPIC_API_KEY: 'sk-ant-test-should-be-stripped',  // must NOT reach the CLI
      CLAUDE_CLI: 'true',
      CLAUDE_CLI_PATH: MOCK_CLAUDE,
      CLAUDE_CLI_MODELS: 'opus,sonnet',
      COUNCIL_MODELS: 'claude-cli:opus,claude-cli:sonnet',
      RESPONSE_MODE: 'individual',
      CLOUD_CONCURRENCY: '2',
    },
  });
  const cliClient = new Client({ name: 'cli-e2e', version: '1.0.0' }, { capabilities: {} });
  await cliClient.connect(cliTransport);
  try {
    const cfg = parseToolResult(await cliClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('claude-cli: provider registered', (cfg.providers ?? []).some(p => p.type === 'claude-cli'), (cfg.providers ?? []).map(p => p.type).join(','));

    const cli = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual' },
    }));
    check('claude-cli: 2 members answered', cli.responses?.length === 2, `got ${cli.responses?.length}`);
    check('claude-cli: opus member invoked the CLI', cli.responses?.some(r => r.label === 'claude-cli:opus' && /model=opus/.test(r.response)), cli.responses?.map(r => r.label).join(','));
    check('claude-cli: sonnet member invoked the CLI', cli.responses?.some(r => r.label === 'claude-cli:sonnet' && /model=sonnet/.test(r.response)));
    check('claude-cli: ANTHROPIC_API_KEY stripped (subscription auth)', cli.responses?.every(r => /key=nokey/.test(r.response ?? '')), cli.responses?.map(r => r.response).join(' | '));
    check('claude-cli: tools disabled in nested call', cli.responses?.every(r => /tools=off/.test(r.response ?? '')));
    check('claude-cli: strict MCP config (no recursion)', cli.responses?.every(r => /mcp=strict/.test(r.response ?? '')));
    check('claude-cli: replaces Claude Code system prompt (neutral persona)', cli.responses?.every(r => /sys=replace/.test(r.response ?? '')));
    check('claude-cli: prompt reached the CLI via stdin', cli.responses?.every(r => /hello world/.test(r.response ?? '')));

    // is_error result (exit 0 + is_error:true) → surfaced as a member error
    await cliClient.callTool({ name: 'configure_council', arguments: { models: ['claude-cli:erroring'], response_mode: 'individual' } });
    const errRes = parseToolResult(await cliClient.callTool({ name: 'ask_council', arguments: { question: 'x', mode: 'individual' } }));
    check('claude-cli: is_error surfaced as member error', !!errRes.responses?.[0]?.error && !errRes.responses?.[0]?.response, JSON.stringify(errRes.responses?.[0]));
  } finally {
    await cliClient.close();
  }

  // ── Test: codex-cli subscription provider (isolated server instance) ───────
  console.log('\n▶ codex-cli subscription provider (mocked codex binary)');
  chmodSync(MOCK_CODEX, 0o755);
  const codexTransport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    env: {
      ...process.env,
      OLLAMA_ADDRESS: 'http://127.0.0.1:1',
      OPENAI_API_KEY: 'sk-openai-should-be-stripped',   // must NOT reach codex
      CODEX_API_KEY: 'ck-should-be-stripped',           // must NOT reach codex
      CODEX_CLI: 'true',
      CODEX_CLI_PATH: MOCK_CODEX,
      CODEX_CLI_MODELS: 'gpt-5-codex,default',
      COUNCIL_MODELS: 'codex-cli:gpt-5-codex,codex-cli:default',
      RESPONSE_MODE: 'individual',
      CLOUD_CONCURRENCY: '2',
    },
  });
  const codexClient = new Client({ name: 'codex-e2e', version: '1.0.0' }, { capabilities: {} });
  await codexClient.connect(codexTransport);
  try {
    const ccfg = parseToolResult(await codexClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('codex-cli: provider registered', (ccfg.providers ?? []).some(p => p.type === 'codex-cli'), (ccfg.providers ?? []).map(p => p.type).join(','));

    const cx = parseToolResult(await codexClient.callTool({
      name: 'ask_council', arguments: { question: 'hi codex', mode: 'individual' },
    }));
    check('codex-cli: 2 members answered', cx.responses?.length === 2, `got ${cx.responses?.length}`);
    check('codex-cli: model flag passed (gpt-5-codex)', cx.responses?.some(r => r.label === 'codex-cli:gpt-5-codex' && /model=gpt-5-codex/.test(r.response)), cx.responses?.map(r => r.label).join(','));
    check('codex-cli: default member omits -m', cx.responses?.some(r => r.label === 'codex-cli:default' && /model=default/.test(r.response)));
    check('codex-cli: OPENAI_API_KEY stripped (subscription auth)', cx.responses?.every(r => /okey=unset/.test(r.response ?? '')), cx.responses?.map(r => r.response).join(' | '));
    check('codex-cli: CODEX_API_KEY stripped', cx.responses?.every(r => /ckey=unset/.test(r.response ?? '')));
    check('codex-cli: read-only sandbox', cx.responses?.every(r => /sandbox=read-only/.test(r.response ?? '')));
    check('codex-cli: prompt reached the CLI via stdin', cx.responses?.every(r => /hi codex/.test(r.response ?? '')));
  } finally {
    await codexClient.close();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log('ALL PASSED ✅');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
