process.env.GROK_CLI_UNSAFE_ACCEPT_RCE = 'true';
/**
 * End-to-end test: spawn the built MCP server over stdio (pointed at the mock
 * backend) and drive all 4 tools + 3 response modes via the MCP protocol.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MOCK_PORT = 11499;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const MOCK_CLAUDE = fileURLToPath(new URL('./mock-claude.mjs', import.meta.url));
const MOCK_CODEX = fileURLToPath(new URL('./mock-codex.mjs', import.meta.url));
const MOCK_GROK = fileURLToPath(new URL('./mock-grok.mjs', import.meta.url));

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

// Parse the JSON text payload from a tool result. Completed council answers
// are wrapped in BEGINNING/END OF RESPONSE markers (a completion signal for
// the host); strip them before parsing.
function parseToolResult(result) {
  let text = result.content?.[0]?.text ?? '{}';
  text = text.replace(/^═══════ BEGINNING OF RESPONSE ═══════\n/, '').replace(/\n═══════ END OF RESPONSE ═══════$/, '');
  return JSON.parse(text);
}

async function main() {
  // ── 1. Start mock backend ──────────────────────────────────────────────────
  const mock = spawn('node', ['test/mock-backend.mjs'], {
    env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', MOCK_PORT: String(MOCK_PORT) },
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
      CLAUDE_TIER: 'free', // keep the main suite Ollama-only (CLI providers tested in isolation)
      CHATGPT_TIER: 'free',
      MODEL_COUNCIL_STATE: join(tmpdir(), `mc-e2e-main-${process.pid}.json`), // isolate from real ~/.config
    },
  });

  const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    // ── Test: server reports the package.json version (never stale) ───────────
    // A hardcoded MCP `version` string went stale across releases (0.2.47 while
    // the package was 0.2.49); it's now read from package.json at load. Assert
    // the running server (dist OR bundle, whichever SERVER_ENTRY points at)
    // reports exactly the package version so a regression can't reintroduce drift.
    console.log('\n▶ server version');
    {
      const { readFileSync } = await import('node:fs');
      const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      const reported = client.getServerVersion?.()?.version;
      check(`server reports package.json version (${pkgVersion}), not a stale hardcoded string`,
        reported === pkgVersion, `reported ${reported}, package ${pkgVersion}`);
    }

    // ── Test: tools are listed ────────────────────────────────────────────────
    console.log('\n▶ list tools');
    const tools = await client.listTools();
    const toolNames = tools.tools.map(t => t.name).sort();
    check('9 tools exposed', toolNames.length === 9, `got ${toolNames.join(',')}`);
    check('has ask_council', toolNames.includes('ask_council'));
    check('has ask_council_async', toolNames.includes('ask_council_async'));
    check('has get_council_result', toolNames.includes('get_council_result'));
    check('has configure_council', toolNames.includes('configure_council'));
    check('has list_models', toolNames.includes('list_models'));
    check('has council_status', toolNames.includes('council_status'));
    check('has setup_council', toolNames.includes('setup_council'));
    check('has get_council_config', toolNames.includes('get_council_config'));

    // ── Test: list_models ─────────────────────────────────────────────────────
    console.log('\n▶ list_models');
    const lm = parseToolResult(await client.callTool({ name: 'list_models', arguments: {} }));
    check('lists all 8 models (incl. cloud, embedding, vision, fake-vision)', lm.total === 8, `got ${lm.total}`);
    check('big-judge present', lm.models.some(m => m.model === 'big-judge'));
    check('cloud model present', lm.models.some(m => m.model === 'kimi-k2:cloud'));
    check('embedding model present in list', lm.models.some(m => m.model === 'bge-m3'));
    check('param size surfaced', lm.models.find(m => m.model === 'big-judge')?.paramSize === '70B');

    // ── Test: individual mode ─────────────────────────────────────────────────
    console.log('\n▶ ask_council (individual)');
    await resetMock();
    const indRaw = await client.callTool({
      name: 'ask_council',
      arguments: { question: 'How to handle errors?', mode: 'individual' },
    });
    const indText = indRaw.content?.[0]?.text ?? '';
    check('completed answers wrapped in BEGINNING/END OF RESPONSE markers',
      indText.startsWith('═══════ BEGINNING OF RESPONSE ═══════') && indText.endsWith('═══════ END OF RESPONSE ═══════'),
      `markers missing: ${indText.slice(0, 60)}…${indText.slice(-60)}`);
    const ind = parseToolResult(indRaw);
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
    check('a genuine full resolution is NOT flagged judgeDegraded', dec.judgeDegraded === undefined, `got ${dec.judgeDegraded}`);
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
    check('pooled: round-0 answers are tagged phase=thesis',
      pool.initialResponses?.every(r => r.phase === 'thesis'), JSON.stringify(pool.initialResponses?.map(r => r.phase)));
    check('pooled: post-pool answers are tagged phase=reconsidered (distinct from the thesis round)',
      pool.reconsidered?.every(r => r.phase === 'reconsidered'), JSON.stringify(pool.reconsidered?.map(r => r.phase)));
    check('pooled: genuine run not flagged judgeDegraded', pool.initialPool?.judgeDegraded === undefined && pool.finalPool?.judgeDegraded === undefined);
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

    // ── Test: pooled mode with a failed judge must flag judgeDegraded, not a fake empty pool ─
    console.log('\n▶ pooled: empty judge flags judgeDegraded on both digests');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], judge_model: 'ollama:empty-judge', response_mode: 'pooled' },
    });
    const poolEmpty = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'pooled' },
    }));
    check('pooled empty judge: initialPool flagged judgeDegraded', poolEmpty.initialPool?.judgeDegraded === true, `got ${JSON.stringify(poolEmpty.initialPool)}`);
    check('pooled empty judge: finalPool flagged judgeDegraded', poolEmpty.finalPool?.judgeDegraded === true, `got ${JSON.stringify(poolEmpty.finalPool)}`);
    check('pooled empty judge: members still reconsidered (re-poll falls back to bare question)', poolEmpty.reconsidered?.length === 2, `got ${poolEmpty.reconsidered?.length}`);
    // Restore the default 3-member council + auto judge (big-judge) before the
    // next block — configure_council's judge_model has no "unset" value, so a
    // real model id is passed to override empty-judge back to something real.
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b', 'ollama:big-judge'], judge_model: 'ollama:big-judge', response_mode: 'individual' },
    });

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
    // Round identity lives on the RECORD, not only in the container field —
    // so a refactor that merged/forwarded these arrays can't turn a thesis into
    // an antithesis, and a caller reading raw JSON can tell the rounds apart.
    const allPhase = (arr, ph) => Array.isArray(arr) && arr.length > 0 && arr.every(r => r.phase === ph);
    check('dialectic: thesis responses are tagged phase=thesis',
      allPhase(dia.initialResponses, 'thesis'), JSON.stringify(dia.initialResponses?.map(r => r.phase)));
    check('dialectic: defenses are tagged phase=antithesis',
      allPhase(dia.defenses, 'antithesis'), JSON.stringify(dia.defenses?.map(r => r.phase)));
    check('dialectic: selections are tagged phase=synthesis',
      allPhase(dia.selections, 'synthesis'), JSON.stringify(dia.selections?.map(r => r.phase)));
    // The three rounds must carry DISTINCT tags — a single shared tag would
    // label everything without actually distinguishing the rounds.
    check('dialectic: the three rounds carry three distinct phases',
      new Set([dia.initialResponses?.[0]?.phase, dia.defenses?.[0]?.phase, dia.selections?.[0]?.phase]).size === 3);
    // Structure: defense prompt is personalised; selection prompt carries the dossier.
    const dbgDia = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('dialectic: defense prompt asks to defend + shows own answer', /Defend your initial selection/.test(dbgDia.lastDefensePrompt ?? '') && /Your initial answer was/.test(dbgDia.lastDefensePrompt ?? ''));
    check('dialectic: selection prompt shows pros AND cons', /Pros:/.test(dbgDia.lastSelectionPrompt ?? '') && /Cons:/.test(dbgDia.lastSelectionPrompt ?? ''));
    // The dossier prompt shows both rounds together — the only place they meet —
    // so each entry there must name its own round.
    check('dialectic: dossier prompt labels each entry with its round',
      /\[thesis\]/.test(dbgDia.lastDossierPrompt ?? '') && /\[antithesis\]/.test(dbgDia.lastDossierPrompt ?? ''),
      (dbgDia.lastDossierPrompt ?? '').slice(0, 200));
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
    check('dialectic: empty judge → flagged judgeDegraded (not a genuine "nothing to debate")', diaDeg.judgeDegraded === true, `got ${diaDeg.judgeDegraded}`);
    check('dialectic: genuine run (dia, above) not flagged judgeDegraded', dia.judgeDegraded === undefined);
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

    // ── Test: malformed judge_model is rejected, not silently downgraded ───────
    // Set a real, explicit judge first...
    await client.callTool({
      name: 'configure_council',
      arguments: { judge_model: 'ollama:big-judge' },
    });
    const beforeBad = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('judge_model: explicit judge set', beforeBad.council?.judgeModel === 'ollama:big-judge', JSON.stringify(beforeBad.council));
    // ...then confirm a typo is rejected with a clear error, not silently
    // swapped to "auto" (which would clear the just-set judge with no visible
    // signal to the caller).
    let threwBadJudge = false, badJudgeMsg = '';
    try {
      await client.callTool({ name: 'configure_council', arguments: { judge_model: 'claud:opus' } });
    } catch (e) { threwBadJudge = true; badJudgeMsg = String(e?.message ?? e); }
    check('judge_model: malformed value throws a clear error', threwBadJudge && /not a valid model id/i.test(badJudgeMsg), badJudgeMsg);
    const afterBad = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('judge_model: the earlier explicit judge is UNCHANGED after the rejected call', afterBad.council?.judgeModel === 'ollama:big-judge', JSON.stringify(afterBad.council));
    // The literal string "auto" is still a recognized, explicit way to clear
    // back to auto-select — equivalent to omitting the field.
    await client.callTool({ name: 'configure_council', arguments: { judge_model: 'auto' } });
    const afterAuto = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('judge_model: "auto" explicitly clears back to auto-select', /auto/i.test(afterAuto.council?.judgeModel ?? ''), JSON.stringify(afterAuto.council));

    // ── Test: configure_council.models is capped (was previously unbounded) ───
    let threwTooManyModels = false, tooManyMsg = '';
    try {
      await client.callTool({
        name: 'configure_council',
        arguments: { models: Array.from({ length: 101 }, (_, i) => `ollama:fake-${i}`) },
      });
    } catch (e) { threwTooManyModels = true; tooManyMsg = String(e?.message ?? e); }
    check('configure_council: 101 models → rejected with a clear error', threwTooManyModels && /100/.test(tooManyMsg), tooManyMsg);
    // Exactly at the cap must still work.
    await client.callTool({
      name: 'configure_council',
      arguments: { models: Array.from({ length: 100 }, (_, i) => `ollama:fake-${i}`) },
    });
    const at100 = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('configure_council: exactly 100 models is accepted', at100.council?.members?.length === 100, `got ${at100.council?.members?.length}`);

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
    check('auto-council: 7 chat members (8 models − 1 embedding)', autoInd.responses.length === 7, `got ${autoInd.responses.length}: ${autoLabels.join(',')}`);
    check('auto-council includes :cloud model', autoLabels.includes('ollama:kimi-k2:cloud'));
    check('auto-council EXCLUDES embedding model', !autoLabels.some(l => l.includes('bge-m3')));

    // get_council_config reflects auto membership
    const autoCfg = parseToolResult(await client.callTool({ name: 'get_council_config', arguments: {} }));
    check('config reports auto source', /auto/i.test(autoCfg.council?.membershipSource ?? ''), autoCfg.council?.membershipSource);
    check('config auto members = 7', autoCfg.council?.members?.length === 7, `got ${autoCfg.council?.members?.length}`);

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

    // ── Test: max_tokens default (32k) reaches the backend ────────────────────
    console.log('\n▶ max_tokens default');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a'], response_mode: 'individual' },
    });
    await client.callTool({ name: 'ask_council', arguments: { question: 'mt', mode: 'individual' } });
    const dbgMt = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('max_tokens default is 32768', dbgMt.lastNumPredict === 32768, `got ${dbgMt.lastNumPredict}`);

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

    // ── Test: the per-provider concurrency ceiling is PROCESS-WIDE, not just
    // per-call — two separate ask_council calls sharing the ollama-cloud pool
    // (limit 2) must never together exceed 2 in flight. A per-call-only pool
    // (each call building its own independent worker pool) would let two
    // concurrent calls each admit up to 2, for a combined 4 — this is exactly
    // the gap a global semaphore closes.
    console.log('\n▶ concurrency ceiling holds across TWO concurrent ask_council calls');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:conc1:cloud', 'ollama:conc2:cloud'], response_mode: 'individual' },
    });
    const [crossA, crossB] = await Promise.all([
      client.callTool({ name: 'ask_council', arguments: { question: 'cross-call A', mode: 'individual' } }),
      client.callTool({ name: 'ask_council', arguments: { question: 'cross-call B', mode: 'individual' } }),
    ]);
    const crossARes = parseToolResult(crossA);
    const crossBRes = parseToolResult(crossB);
    check('cross-call: both calls completed all their members',
      crossARes.responses?.length === 2 && crossBRes.responses?.length === 2,
      `A=${crossARes.responses?.length} B=${crossBRes.responses?.length}`);
    const dbgCross = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('cross-call: combined in-flight across both calls never exceeded the pool limit (2)',
      dbgCross.maxConcurrent === 2, `maxConcurrent=${dbgCross.maxConcurrent} (4 would mean the cap is only per-call)`);

    // ── Test: JUDGE calls (categorize/pool/dossier/synthesize) share the SAME
    // pool as member fan-out, not just member calls — previously a judge call
    // went straight to completeWithRetry, bypassing the semaphore entirely.
    // With a single-member council under `local` (limit 1), EVERY /api/chat
    // request — member answer AND judge categorization alike — must be fully
    // serialized across 3 concurrent ask_council('categorized') calls; a
    // judge call that bypassed the pool could overlap with another call's
    // member phase and push maxConcurrent above 1.
    console.log('\n▶ judge calls share the process-wide semaphore with member fan-out');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:concL1'], response_mode: 'categorized' },
    });
    const [judgeA, judgeB, judgeC] = await Promise.all([
      client.callTool({ name: 'ask_council', arguments: { question: 'judge-sem A', mode: 'categorized' } }),
      client.callTool({ name: 'ask_council', arguments: { question: 'judge-sem B', mode: 'categorized' } }),
      client.callTool({ name: 'ask_council', arguments: { question: 'judge-sem C', mode: 'categorized' } }),
    ]);
    check('judge-semaphore: all 3 concurrent calls completed',
      [judgeA, judgeB, judgeC].every(r => parseToolResult(r)?.judgeModel));
    const dbgJudgeSem = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('judge-semaphore: member AND judge calls together never exceed the local pool limit (1)',
      dbgJudgeSem.maxConcurrent === 1, `maxConcurrent=${dbgJudgeSem.maxConcurrent} (>1 would mean a judge call bypassed the pool)`);

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
    check('empty judge → categorized result flagged judgeDegraded (not a genuine 0-conflict finding)', ej.judgeDegraded === true, `got ${ej.judgeDegraded}`);

    // ── Test: judge failure must not fabricate a false 100% deconfliction score ─
    // (a judge outage on the INITIAL categorization degrades conflicting[] to
    // empty — deconflict() must not read that as "0 conflicts, 100% resolved".)
    console.log('\n▶ empty judge: deconfliction score must be null, not a false 100%');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], judge_model: 'ollama:empty-judge', response_mode: 'deconflicted' },
    });
    const decEmpty = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'deconflicted' },
    }));
    check('empty judge (deconflicted): score is null, not a fabricated 100', decEmpty.deconflictionScore === null, `got ${decEmpty.deconflictionScore}`);
    check('empty judge (deconflicted): judgeDegraded true', decEmpty.judgeDegraded === true, `got ${decEmpty.judgeDegraded}`);
    check('empty judge (deconflicted): totalConflicts 0 (fallback, not a genuine count)', decEmpty.totalConflicts === 0);

    // ── Test: mid-loop judge failure must not fabricate a resolution ───────────
    // The judge answers round 1 validly (1 real conflict), then goes malformed
    // on round 2 — detectResolutions() must NOT read the malformed round's
    // empty conflicting[] as "the conflict is now resolved".
    console.log('\n▶ flaky judge: mid-loop failure must not fabricate a resolution');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], judge_model: 'ollama:flaky-judge', response_mode: 'deconflicted' },
    });
    const decFlaky = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'deconflicted', max_deconflict_rounds: 3 },
    }));
    check('flaky judge: total conflicts 1 (genuine, from the valid initial round)', decFlaky.totalConflicts === 1, `got ${decFlaky.totalConflicts}`);
    check('flaky judge: 0 resolved (round 2 failure must not fabricate a resolution)', decFlaky.resolved === 0, `got ${decFlaky.resolved}`);
    check('flaky judge: score 0, a real lower-bound measurement (not null — the initial count was real)', decFlaky.deconflictionScore === 0, `got ${decFlaky.deconflictionScore}`);
    check('flaky judge: judgeDegraded true (score is a pessimistic lower bound, judge outage cut the loop short)', decFlaky.judgeDegraded === true, `got ${decFlaky.judgeDegraded}`);
    check('flaky judge: 1 unresolved conflict remains open', decFlaky.unresolvedConflicts?.length === 1, `got ${decFlaky.unresolvedConflicts?.length}`);
    check('flaky judge: only 1 round ran (stopped at the malformed round, did not retry to maxRounds)', decFlaky.roundsTaken === 1, `got ${decFlaky.roundsTaken}`);

    // ── Test: file / context attachment ───────────────────────────────────────
    console.log('\n▶ ask_council with context + files');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], response_mode: 'individual' },
    });
    const ctxDir = mkdtempSync(join(tmpdir(), 'mc-ctx-'));
    const ctxFile = join(ctxDir, 'snippet.txt');
    writeFileSync(ctxFile, 'FILE_MARKER_42');
    try {
      await client.callTool({
        name: 'ask_council',
        arguments: {
          question: 'Review this.',
          mode: 'individual',
          context: 'INLINE_MARKER_7',
          files: [ctxFile],
        },
      });
      const dbgCtx = await (await fetch(`${MOCK_URL}/debug`)).json();
      const seen = JSON.stringify(dbgCtx);
      check('context: inline marker reached members', /INLINE_MARKER_7/.test(seen));
      check('context: file contents reached members', /FILE_MARKER_42/.test(seen));
      check('context: file path labelled', /FILE:[0-9a-f]+: /.test(seen) && /snippet\.txt/.test(seen), seen);
      // A missing file is a clear error, not a silent drop.
      let threw = false;
      try {
        await client.callTool({
          name: 'ask_council',
          arguments: { question: 'x', files: [join(ctxDir, 'nope.txt')] },
        });
      } catch (e) { threw = /not found|unreadable/i.test(String(e?.message ?? e)); }
      check('context: missing file → error surfaced', threw);
    } finally {
      rmSync(ctxDir, { recursive: true, force: true });
    }

    // ── Test: git_ref auto-attaches a local diff (repo review convenience) ─────
    console.log('\n▶ ask_council with git_ref (auto-attached diff)');
    {
      const gitDir = mkdtempSync(join(tmpdir(), 'mc-gitref-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: gitDir });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitDir });
        const filePath = join(gitDir, 'reviewme.txt');
        writeFileSync(filePath, 'GIT_BASELINE_LINE\n');
        execFileSync('git', ['add', '.'], { cwd: gitDir });
        execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: gitDir });
        writeFileSync(filePath, 'GIT_BASELINE_LINE\nGIT_DIFF_MARKER_88\n');

        await resetMock();
        await client.callTool({
          name: 'ask_council',
          arguments: { question: 'Review this diff.', mode: 'individual', git_ref: 'uncommitted', git_repo: gitDir },
        });
        const dbgGit = JSON.stringify(await (await fetch(`${MOCK_URL}/debug`)).json());
        check('git_ref: diff content reached members', /GIT_DIFF_MARKER_88/.test(dbgGit), dbgGit);
        check('git_ref: labelled with the requested ref', /GIT DIFF:[0-9a-f]+ \(uncommitted\)/.test(dbgGit), dbgGit);

        // A ref with no changes is a clear error, not a silent no-op.
        let threwEmpty = false;
        try {
          await client.callTool({
            name: 'ask_council',
            arguments: { question: 'x', git_ref: 'staged', git_repo: gitDir },
          });
        } catch (e) { threwEmpty = /no changes found/i.test(String(e?.message ?? e)); }
        check('git_ref: no changes → error surfaced', threwEmpty);

        // A path that isn't a git repo is a clear error.
        const notRepoDir = mkdtempSync(join(tmpdir(), 'mc-gitref-notrepo-'));
        let threwNotRepo = false;
        try {
          await client.callTool({
            name: 'ask_council',
            arguments: { question: 'x', git_ref: 'uncommitted', git_repo: notRepoDir },
          });
        } catch (e) { threwNotRepo = /not inside a git repository/i.test(String(e?.message ?? e)); }
        rmSync(notRepoDir, { recursive: true, force: true });
        check('git_ref: non-repo path → error surfaced', threwNotRepo);

        // Regression: a ref starting with '-' must never reach `git diff` as an
        // option — "--output=<file>" is an arbitrary file write primitive.
        const pwnTarget = join(gitDir, 'pwned.txt');
        let threwInjection = false;
        try {
          await client.callTool({
            name: 'ask_council',
            arguments: { question: 'x', git_ref: `--output=${pwnTarget}`, git_repo: gitDir },
          });
        } catch (e) { threwInjection = /looks like a git option/i.test(String(e?.message ?? e)); }
        check('git_ref: option-injection ref rejected', threwInjection);
        check('git_ref: option-injection ref did not write a file', !existsSync(pwnTarget));
      } finally {
        rmSync(gitDir, { recursive: true, force: true });
      }
    }

    // ── Test: ask_council with images (vision auto-detection + routing) ───────
    console.log('\n▶ ask_council with images (vision routing)');
    const imgDir = mkdtempSync(join(tmpdir(), 'mc-img-'));
    const imgFile = join(imgDir, 'photo.png');
    // loadImages only reads+base64-encodes bytes (it doesn't decode the image),
    // so arbitrary bytes with a .png extension are enough to exercise the path.
    writeFileSync(imgFile, Buffer.from('FAKE_IMAGE_BYTES_9911'));
    try {
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: { models: ['ollama:small-a', 'ollama:vision-a'], response_mode: 'individual' },
      });
      const visAsk = parseToolResult(await client.callTool({
        name: 'ask_council',
        arguments: { question: "What's in this picture?", mode: 'individual', images: [imgFile] },
      }));
      check('vision: only the vision-capable member answered', visAsk.responses?.length === 1, `got ${visAsk.responses?.length}`);
      check('vision: the vision member is the one queried', visAsk.responses?.[0]?.label === 'ollama:vision-a', visAsk.responses?.[0]?.label);
      check('vision: visionRouting reports 1 image attached', visAsk.visionRouting?.imagesAttached === 1);
      check('vision: visionRouting lists the queried vision model', visAsk.visionRouting?.queriedVisionModels?.includes('ollama:vision-a'));
      check('vision: visionRouting lists the skipped non-vision model', visAsk.visionRouting?.skippedNonVision?.includes('ollama:small-a'));

      // Progress notifications: when the caller requests them (MCP progressToken,
      // handled transparently by the SDK's `onprogress` client option), the
      // server reports per-member vision-detection AND per-member answer status
      // — this is what keeps a long vision-gated call, now correctly serialized
      // per provider, from reading as a hang.
      //
      // Only asserting "at least one arrives" here, deliberately: this exact
      // call (right after `visAsk` above already warmed the vision cache) hits
      // a real client-side limitation in the MCP TS SDK's stdio Client — when
      // several notifications for the same token fire in rapid, near-synchronous
      // succession (every check now resolves from cache with no real I/O), the
      // client's own progress-handler bookkeeping drops all but the first as
      // "unknown token" (confirmed by isolated repro; not something server code
      // can work around). That failure mode only shows up exactly when the call
      // is fast enough that progress tracking wasn't needed anyway — a genuinely
      // slow, uncached call (cold model loads, real OCR round trips) has natural
      // I/O gaps between steps and delivers reliably, per the SAME repro against
      // an uncached mock.
      const progressMessages = [];
      const visAskProgress = parseToolResult(await client.callTool(
        { name: 'ask_council', arguments: { question: "What's in this picture?", mode: 'individual', images: [imgFile] } },
        undefined,
        { onprogress: p => progressMessages.push(p.message) },
      ));
      check('vision progress: at least one notification arrived', progressMessages.length > 0, JSON.stringify(progressMessages));
      check('vision progress: final result unaffected', visAskProgress.responses?.length === 1 && visAskProgress.responses?.[0]?.label === 'ollama:vision-a');

      // Wire-shape proof: the non-vision member must NEVER receive the image
      // (a) it wasn't queried at all (asserted above via responses.length===1), and
      // (b) the vision member's request carried the image in Ollama's correct
      // shape — a sibling `images` array of bare base64 (no data: prefix).
      const dbgVision = await (await fetch(`${MOCK_URL}/debug`)).json();
      const expectedB64 = readFileSync(imgFile).toString('base64');
      check('vision: image reached the model as a bare base64 sibling array (Ollama shape)',
        Array.isArray(dbgVision.lastImages) && dbgVision.lastImages[0] === expectedB64 && !dbgVision.lastImages[0].startsWith('data:'));

      // No vision-capable member configured → a clear error, not a silent
      // text-only fallback that would misrepresent what the council actually saw.
      await client.callTool({
        name: 'configure_council',
        arguments: { models: ['ollama:small-a', 'ollama:small-b'], response_mode: 'individual' },
      });
      let visErr = null;
      try {
        await client.callTool({
          name: 'ask_council',
          arguments: { question: 'x', images: [imgFile] },
        });
      } catch (e) { visErr = String(e?.message ?? e); }
      check('vision: no vision-capable member → clear error (not a silent skip)', /vision-capable/i.test(visErr ?? ''), visErr);

      // ── The false-positive regression this whole feature exists to catch:
      // fake-vision-a reports "vision" in /api/show capabilities (stage 1 says
      // yes) but answers the OCR challenge with the wrong digits (stage 2 says
      // no) — same shape as the real SGLang bug found live. It must be excluded
      // exactly like a model with no vision claim at all.
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: { models: ['ollama:fake-vision-a'], response_mode: 'individual' },
      });
      let fakeVisErr = null;
      try {
        await client.callTool({
          name: 'ask_council',
          arguments: { question: 'x', images: [imgFile] },
        });
      } catch (e) { fakeVisErr = String(e?.message ?? e); }
      check('vision: metadata-claims-vision-but-fails-OCR member → excluded (clear error)',
        /vision-capable/i.test(fakeVisErr ?? ''), fakeVisErr);

      // Mixed council: the real vision model is queried, the false-positive is not.
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: { models: ['ollama:vision-a', 'ollama:fake-vision-a'], response_mode: 'individual' },
      });
      const mixedVisAsk = parseToolResult(await client.callTool({
        name: 'ask_council',
        arguments: { question: "What's in this picture?", mode: 'individual', images: [imgFile] },
      }));
      check('vision: mixed council queries only the genuinely vision-capable member',
        mixedVisAsk.responses?.length === 1 && mixedVisAsk.responses?.[0]?.label === 'ollama:vision-a',
        JSON.stringify(mixedVisAsk.responses?.map(r => r.label)));
      check('vision: mixed council reports the false-positive as skipped',
        mixedVisAsk.visionRouting?.skippedNonVision?.includes('ollama:fake-vision-a'),
        JSON.stringify(mixedVisAsk.visionRouting));

      // The vision-DETECTION phase itself (not just the real query round) must honour
      // the `local` concurrency pool (1 here) — probing 2+ local models' OCR challenges
      // concurrently is exactly what thrashes memory on hardware that can only hold one
      // large local model at a time (real failure mode: two genuinely vision-capable
      // Ollama models both got starved into false negatives when probed concurrently).
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: { models: ['ollama:vision-a', 'ollama:vision-b'], response_mode: 'individual' },
      });
      const concVisAsk = parseToolResult(await client.callTool({
        name: 'ask_council',
        arguments: { question: "What's in this picture?", mode: 'individual', images: [imgFile] },
      }));
      check('vision: both local vision models detected + queried',
        concVisAsk.responses?.length === 2, JSON.stringify(concVisAsk.responses?.map(r => r.label)));
      const dbgConcVis = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('vision: detection phase respects local concurrency (max 1 in flight)',
        dbgConcVis.maxConcurrent === 1, `maxConcurrent=${dbgConcVis.maxConcurrent}`);

      // ── Images must reach every round's MEMBER queries (reconsideration/
      // defense/selection/deconflict-round), but never a JUDGE call (pool
      // digest/dossier/categorize) — a judge distils members' text responses,
      // it never sees the attached image directly.
      console.log('\n▶ images threaded through pooled/dialectic/deconflict rounds');

      // Pooled: repoll (member) must carry images; pool-digest (judge) must not.
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: {
          models: ['ollama:vision-a', 'ollama:vision-b'],
          judge_model: 'ollama:vision-b',
          response_mode: 'pooled',
        },
      });
      await client.callTool({
        name: 'ask_council',
        arguments: { question: "What's in this picture?", mode: 'pooled', images: [imgFile] },
      });
      const dbgPoolImg = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('images/pooled: reconsideration (member) round carried the image',
        Array.isArray(dbgPoolImg.lastRepollImages) && dbgPoolImg.lastRepollImages[0] === expectedB64,
        JSON.stringify(dbgPoolImg.lastRepollImages));
      check('images/pooled: pool-digest (judge) call never received the image',
        !dbgPoolImg.lastPoolDigestImages, JSON.stringify(dbgPoolImg.lastPoolDigestImages));

      // Dialectic: defense + selection (member) must carry images; dossier (judge) must not.
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: {
          models: ['ollama:vision-a', 'ollama:vision-b'],
          judge_model: 'ollama:vision-b',
          response_mode: 'dialectic',
        },
      });
      await client.callTool({
        name: 'ask_council',
        arguments: { question: "What's in this picture?", mode: 'dialectic', images: [imgFile] },
      });
      const dbgDialecticImg = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('images/dialectic: defense (member) round carried the image',
        Array.isArray(dbgDialecticImg.lastDefenseImages) && dbgDialecticImg.lastDefenseImages[0] === expectedB64,
        JSON.stringify(dbgDialecticImg.lastDefenseImages));
      check('images/dialectic: selection (member) round carried the image',
        Array.isArray(dbgDialecticImg.lastSelectionImages) && dbgDialecticImg.lastSelectionImages[0] === expectedB64,
        JSON.stringify(dbgDialecticImg.lastSelectionImages));
      check('images/dialectic: dossier (judge) call never received the image',
        !dbgDialecticImg.lastDossierImages, JSON.stringify(dbgDialecticImg.lastDossierImages));

      // Deconflicted: round query (member) must carry images; categorize (judge) must not.
      await resetMock();
      await client.callTool({
        name: 'configure_council',
        arguments: {
          models: ['ollama:vision-a', 'ollama:vision-b'],
          judge_model: 'ollama:vision-b',
          response_mode: 'deconflicted',
        },
      });
      await client.callTool({
        name: 'ask_council',
        arguments: {
          question: "What's in this picture?", mode: 'deconflicted',
          max_deconflict_rounds: 1, images: [imgFile],
        },
      });
      const dbgDeconflictImg = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('images/deconflicted: round (member) query carried the image',
        Array.isArray(dbgDeconflictImg.lastDeconflictRoundImages) && dbgDeconflictImg.lastDeconflictRoundImages[0] === expectedB64,
        JSON.stringify(dbgDeconflictImg.lastDeconflictRoundImages));
      check('images/deconflicted: categorize (judge) call never received the image',
        !dbgDeconflictImg.lastCategorizeImages, JSON.stringify(dbgDeconflictImg.lastCategorizeImages));
    } finally {
      rmSync(imgDir, { recursive: true, force: true });
    }

    // ── Test: per-completion timeout cut surfaces a timeoutNotice ─────────────
    console.log('\n▶ timeout cut → timeoutNotice + set_council_timeouts');
    await resetMock();
    // Shrink the text-only per-completion timeout so the slow mock model
    // (sleeps 2s) is cut; then ask it. The result must carry the notice.
    const sto = parseToolResult(await client.callTool({
      name: 'set_council_timeouts',
      arguments: { run_timeout_ms: 1200 },
    }));
    check('set_council_timeouts returns updated run timeout', sto.run_timeout_ms === 1200, `got ${sto.run_timeout_ms}`);
    check('set_council_timeouts leaves repo timeout intact', typeof sto.repo_timeout_ms === 'number', `got ${sto.repo_timeout_ms}`);
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:slow-timeout', 'ollama:small-a'], response_mode: 'individual' },
    });
    const toRes = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'slow?', mode: 'individual' },
    }));
    check('timed-out member flagged with timeout error', /timed out|timeout/i.test(toRes.responses?.[0]?.error ?? ''), `err="${toRes.responses?.[0]?.error}"`);
    check('result carries timeoutNotice', toRes.timeoutNotice === 'RESPONSE TIMED OUT, INCREASE TIMEOUT IF MESSAGE IS CUT', `got "${toRes.timeoutNotice}"`);
    check('timedOutMembers lists the cut label', Array.isArray(toRes.timedOutMembers) && toRes.timedOutMembers.includes('ollama:slow-timeout'), `got ${JSON.stringify(toRes.timedOutMembers)}`);
    check('non-timed member still answered', toRes.responses?.[1]?.response && !toRes.responses?.[1]?.error);
    // A reconciliation mode (categorized) with NO verbose must still surface
    // timedOutMembers — the orchestrator attaches it from the raw responses it
    // has in hand, so a timeout is visible even when the per-round response
    // arrays that carry the error are omitted under verbose:false.
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:slow-timeout', 'ollama:small-a', 'ollama:small-b'], judge_model: 'ollama:big-judge', response_mode: 'categorized' },
    });
    const catTo = parseToolResult(await client.callTool({
      name: 'ask_council', arguments: { question: 'How to handle errors?', mode: 'categorized' },
    }));
    check('categorized (no verbose) surfaces timedOutMembers for the cut member',
      Array.isArray(catTo.timedOutMembers) && catTo.timedOutMembers.includes('ollama:slow-timeout'),
      `got ${JSON.stringify(catTo.timedOutMembers)}`);
    check('categorized (no verbose) carries timeoutNotice',
      catTo.timeoutNotice === 'RESPONSE TIMED OUT, INCREASE TIMEOUT IF MESSAGE IS CUT', `got "${catTo.timeoutNotice}"`);
    // council_status must surface the now-effective timeouts.
    const stStat = parseToolResult(await client.callTool({ name: 'council_status', arguments: {} }));
    check('council_status surfaces run timeout', stStat.timeouts?.run_ms === 1200, `got ${stStat.timeouts?.run_ms}`);
    check('council_status surfaces repo timeout', typeof stStat.timeouts?.repo_ms === 'number', `got ${stStat.timeouts?.repo_ms}`);
    // A misspelled/unknown key must be REJECTED, not silently stripped while
    // the tool reports success — otherwise the caller believes the timeout was
    // set when nothing changed.
    let strictRejected = false;
    try {
      await client.callTool({ name: 'set_council_timeouts', arguments: { repo_timout_ms: 30000 } });
    } catch {
      strictRejected = true;
    }
    check('set_council_timeouts rejects an unknown/misspelled key', strictRejected, 'expected a validation error for repo_timout_ms');
    // Restore the default-ish timeout so later tests aren't affected.
    await client.callTool({ name: 'set_council_timeouts', arguments: { run_timeout_ms: 300000 } });

    // ── Test: async / background job flow ─────────────────────────────────────
    console.log('\n▶ ask_council_async / get_council_result');
    await resetMock();
    await client.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:small-a', 'ollama:small-b'], response_mode: 'individual' },
    });
    const started = parseToolResult(await client.callTool({
      name: 'ask_council_async',
      arguments: { question: 'async test', mode: 'individual' },
    }));
    check('async: returns running + job_id', started.status === 'running' && typeof started.job_id === 'string');
    // Poll until done (bounded).
    let jobResult = null;
    for (let i = 0; i < 50 && !jobResult; i++) {
      const polled = parseToolResult(await client.callTool({
        name: 'get_council_result', arguments: { job_id: started.job_id },
      }));
      if (polled.status === 'done') jobResult = polled;
      else if (polled.status === 'error') { jobResult = polled; break; }
      else await new Promise(r => setTimeout(r, 40));
    }
    check('async: job completed', jobResult?.status === 'done', `got ${jobResult?.status}: ${jobResult?.error ?? ''}`);
    check('async: result carries individual responses', jobResult?.result?.responses?.length === 2, `got ${jobResult?.result?.responses?.length}`);
    check('async: elapsedMs recorded', typeof jobResult?.elapsedMs === 'number');
    const listed = parseToolResult(await client.callTool({ name: 'get_council_result', arguments: { list: true } }));
    check('async: job appears in listing', Array.isArray(listed.jobs) && listed.jobs.some(j => j.id === started.job_id));
    let badJob = false;
    try {
      await client.callTool({ name: 'get_council_result', arguments: { job_id: 'does-not-exist' } });
    } catch (e) { badJob = /No such job/i.test(String(e?.message ?? e)); }
    check('async: unknown job_id → error', badJob);

  } finally {
    await client.close();
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
      GROK_CLI_PATH: MOCK_GROK, // never let a real installed `grok` binary run during tests
      COUNCIL_MODELS: 'claude-cli:opus,claude-cli:sonnet',
      RESPONSE_MODE: 'individual',
      CLOUD_CONCURRENCY: '2',
      MODEL_COUNCIL_STATE: join(tmpdir(), `mc-e2e-cli-${process.pid}.json`), // isolate from real ~/.config
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
    // ── reasoning_effort ──────────────────────────────────────────────────
    // Absent by default: the feature must be invisible unless asked for, so an
    // existing council keeps behaving byte-for-byte as it did before.
    // A brand-new install (fresh state file) seeds `high` — a council is worth
    // more when its members actually think — so the flag IS present, at that
    // level, without the caller asking for one.
    check('reasoning_effort: a first run seeds high and passes it to the CLI',
      cli.responses?.every(r => /effort=high\b/.test(r.response ?? '')),
      cli.responses?.map(r => r.response).join(' | '));

    // ── web_access ────────────────────────────────────────────────────────
    check('web_access: off by default — no web tools granted',
      cli.responses?.every(r => /web=off/.test(r.response ?? '')),
      cli.responses?.map(r => r.response).join(' | '));
    const web = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual', web_access: true },
    }));
    // BOTH flags are required — --tools enables, --allowedTools permits. The
    // mock only reports web=on when it saw both, so this catches a regression
    // that grants the tool without the permission (verified live: that shape
    // returns permission_denials and runs no search at all).
    check('web_access: grants the tool AND the permission to use it',
      web.responses?.every(r => /web=on/.test(r.response ?? '')),
      web.responses?.map(r => r.response).join(' | '));
    check('web_access: reports every member as researched when all can',
      web.webRouting?.researched?.length === 2 && web.webRouting?.fromMemory?.length === 0,
      JSON.stringify(web.webRouting));
    check('web_access: no webRouting block at all when web access is off',
      cli.webRouting === undefined, JSON.stringify(cli.webRouting));

    const effortHigh = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual', reasoning_effort: 'high' },
    }));
    check('reasoning_effort: per-call level reaches the claude CLI argv',
      effortHigh.responses?.every(r => /effort=high\b/.test(r.response ?? '')),
      effortHigh.responses?.map(r => r.response).join(' | '));

    // claude-cli's scale starts at `low`, so a below-floor level must be
    // clamped UP rather than passed through (the CLI would reject it) or
    // dropped (the caller asked for a level and would silently get none).
    const effortNone = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual', reasoning_effort: 'none' },
    }));
    check('reasoning_effort: a level below the backend floor is clamped up, not dropped (none -> low)',
      effortNone.responses?.every(r => /effort=low\b/.test(r.response ?? '')),
      effortNone.responses?.map(r => r.response).join(' | '));

    // `effort` is the obvious shorthand, and the schema is strict — so the
    // rejection has to NAME the canonical parameter rather than just listing
    // every valid key, the same "did you mean" treatment `mode`/`members` get.
    let aliasThrew = false, aliasMsg = '';
    try {
      await cliClient.callTool({
        name: 'ask_council', arguments: { question: 'hello world', mode: 'individual', effort: 'max' },
      });
    } catch (e) { aliasThrew = true; aliasMsg = String(e?.message ?? e); }
    check('reasoning_effort: the `effort` shorthand is rejected with a did-you-mean pointing at reasoning_effort',
      aliasThrew && /did you mean "reasoning_effort"/.test(aliasMsg), aliasMsg);

    // An out-of-scale value must be REJECTED, not silently coerced — a typo'd
    // level that quietly ran at the default is exactly the invisible failure
    // the strict schema exists to prevent.
    let badEffortThrew = false, badEffortMsg = '';
    try {
      await cliClient.callTool({
        name: 'ask_council', arguments: { question: 'x', mode: 'individual', reasoning_effort: 'extreme' },
      });
    } catch (e) { badEffortThrew = true; badEffortMsg = String(e?.message ?? e); }
    check('reasoning_effort: an invalid level is rejected rather than silently ignored',
      badEffortThrew && /reasoning_effort/.test(badEffortMsg), badEffortMsg);

    // Persisted default via configure_council, applied to a later ask with no
    // per-call level of its own.
    await cliClient.callTool({ name: 'configure_council', arguments: { reasoning_effort: 'xhigh' } });
    const cfgEffort = parseToolResult(await cliClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('reasoning_effort: configure_council default is reported by get_council_config',
      cfgEffort.council?.reasoningEffort === 'xhigh' && cfgEffort.runtime?.reasoningEffort === 'xhigh',
      JSON.stringify({ c: cfgEffort.council?.reasoningEffort, r: cfgEffort.runtime?.reasoningEffort }));
    const defaulted = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual' },
    }));
    check('reasoning_effort: the configured default applies to a call that sets none',
      defaulted.responses?.every(r => /effort=xhigh\b/.test(r.response ?? '')),
      defaulted.responses?.map(r => r.response).join(' | '));
    const overridden = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual', reasoning_effort: 'low' },
    }));
    check('reasoning_effort: a per-call level overrides the configured default',
      overridden.responses?.every(r => /effort=low\b/.test(r.response ?? '')),
      overridden.responses?.map(r => r.response).join(' | '));
    // ...and the override must not have leaked into the shared runtime, or the
    // NEXT caller silently inherits a level they never asked for.
    const afterOverride = parseToolResult(await cliClient.callTool({
      name: 'ask_council', arguments: { question: 'hello world', mode: 'individual' },
    }));
    check('reasoning_effort: a per-call override does not leak into the server-wide default',
      afterOverride.responses?.every(r => /effort=xhigh\b/.test(r.response ?? '')),
      afterOverride.responses?.map(r => r.response).join(' | '));
    // Clear it again so the later assertions in this block see a clean council.
    await cliClient.callTool({ name: 'configure_council', arguments: { models: ['claude-cli:opus', 'claude-cli:sonnet'], response_mode: 'individual' } });

    // is_error result (exit 0 + is_error:true) → surfaced as a member error
    await cliClient.callTool({ name: 'configure_council', arguments: { models: ['claude-cli:erroring'], response_mode: 'individual' } });
    const errRes = parseToolResult(await cliClient.callTool({ name: 'ask_council', arguments: { question: 'x', mode: 'individual' } }));
    check('claude-cli: is_error surfaced as member error', !!errRes.responses?.[0]?.error && !errRes.responses?.[0]?.response, JSON.stringify(errRes.responses?.[0]));

    // Vision: image is written to a fresh temp dir and read back via the
    // Read-tool-workaround (see claude-cli.ts header) — asserts the tool was
    // narrowed to exactly "Read" (not left fully open) and the mock could
    // genuinely open the file at the path the provider named in the prompt.
    await cliClient.callTool({ name: 'configure_council', arguments: { models: ['claude-cli:opus'], response_mode: 'individual' } });
    const cliImgDir = mkdtempSync(join(tmpdir(), 'mc-cliimg-'));
    const cliImgPath = join(cliImgDir, 'shot.png');
    writeFileSync(cliImgPath, Buffer.from('CLAUDE_CLI_IMAGE_BYTES_557'));
    try {
      const cliVis = parseToolResult(await cliClient.callTool({
        name: 'ask_council', arguments: { question: 'describe this', mode: 'individual', images: [cliImgPath] },
      }));
      check('claude-cli vision: visionRouting queried opus', cliVis.visionRouting?.queriedVisionModels?.includes('claude-cli:opus'), JSON.stringify(cliVis.visionRouting));
      const visResp = cliVis.responses?.[0]?.response ?? '';
      check('claude-cli vision: tool narrowed to Read only (not fully open)', /tools=read\b/.test(visResp), visResp);
      check('claude-cli vision: mock genuinely read the image bytes at the given path', /read:OK\(/.test(visResp) && !/DENIED|MISSING/.test(visResp), visResp);
    } finally {
      rmSync(cliImgDir, { recursive: true, force: true });
    }

    // full_repo_access: tools widen to Read,Grep,Glob and --add-dir grants the
    // real repo root — the mock genuinely lists it, proving real access (not
    // just the flag reaching the CLI).
    await cliClient.callTool({ name: 'configure_council', arguments: { models: ['claude-cli:opus'], response_mode: 'individual' } });
    // Must be a real git repo — full_repo_access now validates the granted
    // root the same way git_ref does (a real permission-review finding: an
    // arbitrary resolvable path, including "/", was previously accepted).
    const repoDir = mkdtempSync(join(tmpdir(), 'mc-clirepo-'));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'alpha.txt'), 'a');
    writeFileSync(join(repoDir, 'beta.txt'), 'b');
    try {
      const repoAsk = parseToolResult(await cliClient.callTool({
        name: 'ask_council',
        arguments: { question: 'how many files?', mode: 'individual', full_repo_access: true, git_repo: repoDir },
      }));
      const repoResp = repoAsk.responses?.[0]?.response ?? '';
      check('claude-cli full_repo_access: tools widened to Read,Grep,Glob', /tools=repo\b/.test(repoResp), repoResp);
      check('claude-cli full_repo_access: mock genuinely listed the granted repo root', /repolist:\.git\|alpha\.txt\|beta\.txt/.test(repoResp), repoResp);
      check('claude-cli full_repo_access: still strict MCP (no recursion)', /mcp=strict\b/.test(repoResp), repoResp);
      // Regression: the child's own cwd must be pinned to the granted root, not
      // silently inherited from the server — verified live that an unset cwd
      // let claude-cli Read files in the server's own working directory with
      // NO --add-dir at all (an undocumented extra grant beyond --add-dir).
      // realpath both sides: macOS resolves /var -> /private/var, so the mock's
      // own process.cwd() (already realpath'd by the OS) won't string-match the
      // raw mkdtempSync path otherwise.
      check('claude-cli full_repo_access: child cwd pinned to the granted root (no server-cwd leak)', repoResp.includes(`cwd=${realpathSync(repoDir)}`), repoResp);

      // A path that resolves but isn't a real git repo must be rejected, not
      // silently granted — this is the actual fix for the "any arbitrary
      // directory, including /" gap.
      const notRepoDir = mkdtempSync(join(tmpdir(), 'mc-clinotrepo-'));
      let threwNotRepo = false;
      try {
        await cliClient.callTool({
          name: 'ask_council',
          arguments: { question: 'x', mode: 'individual', full_repo_access: true, git_repo: notRepoDir },
        });
      } catch (e) { threwNotRepo = /not inside a git repository/i.test(String(e?.message ?? e)); }
      rmSync(notRepoDir, { recursive: true, force: true });
      check('full_repo_access: non-repo git_repo rejected (no arbitrary-directory grant)', threwNotRepo);

      // Concurrency safety: a call WITHOUT full_repo_access run at the same time
      // must NOT see it — the per-call clone in orchestrator.ask() must never
      // leak into the shared server-wide runtime.
      const [withAccess, withoutAccess] = await Promise.all([
        cliClient.callTool({
          name: 'ask_council',
          arguments: { question: 'x', mode: 'individual', full_repo_access: true, git_repo: repoDir },
        }),
        cliClient.callTool({
          name: 'ask_council',
          arguments: { question: 'y', mode: 'individual' },
        }),
      ]);
      const withResp = parseToolResult(withAccess).responses?.[0]?.response ?? '';
      const withoutResp = parseToolResult(withoutAccess).responses?.[0]?.response ?? '';
      check('full_repo_access concurrency: the opted-in call got repo tools', /tools=repo\b/.test(withResp), withResp);
      check('full_repo_access concurrency: the concurrent non-opted-in call stayed locked down (no leak)', /tools=off\b/.test(withoutResp), withoutResp);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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
      GROK_CLI_PATH: MOCK_GROK, // never let a real installed `grok` binary run during tests
      COUNCIL_MODELS: 'codex-cli:gpt-5-codex,codex-cli:default',
      RESPONSE_MODE: 'individual',
      CLOUD_CONCURRENCY: '2',
      MODEL_COUNCIL_STATE: join(tmpdir(), `mc-e2e-codex-${process.pid}.json`), // isolate from real ~/.config
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
    check('codex-cli: the first-run default reaches the config key without the caller asking',
      cx.responses?.every(r => /effort=high\b/.test(r.response ?? '')),
      cx.responses?.map(r => r.response).join(' | '));
    // Codex takes a level nothing below it does (`xhigh`), so this proves the
    // value arrives verbatim rather than being clamped to a common denominator.
    const cxWeb = parseToolResult(await codexClient.callTool({
      name: 'ask_council', arguments: { question: 'hi codex', mode: 'individual', web_access: true },
    }));
    check('codex-cli: web_access arrives as the tools.web_search config key',
      cxWeb.responses?.every(r => /web=on/.test(r.response ?? '')),
      cxWeb.responses?.map(r => r.response).join(' | '));

    const cxEffort = parseToolResult(await codexClient.callTool({
      name: 'ask_council', arguments: { question: 'hi codex', mode: 'individual', reasoning_effort: 'xhigh' },
    }));
    check('codex-cli: reasoning_effort arrives as -c model_reasoning_effort, unclamped',
      cxEffort.responses?.every(r => /effort=xhigh\b/.test(r.response ?? '')),
      cxEffort.responses?.map(r => r.response).join(' | '));
    // `minimal` is advertised by codex's parameter enum but rejected by the
    // model itself (verified live), so it must be clamped here — passing it
    // through would 400 and drop the member.
    const cxMinimal = parseToolResult(await codexClient.callTool({
      name: 'ask_council', arguments: { question: 'hi codex', mode: 'individual', reasoning_effort: 'minimal' },
    }));
    check('codex-cli: minimal is clamped to none (the model rejects minimal despite the enum advertising it)',
      cxMinimal.responses?.every(r => /effort=none\b/.test(r.response ?? '')),
      cxMinimal.responses?.map(r => r.response).join(' | '));

    // Vision: codex has a first-party -i/--image flag (no workaround needed) —
    // asserts the provider actually wrote real image bytes at the path it
    // passed, and the mock (standing in for the real CLI) could read them back.
    await codexClient.callTool({ name: 'configure_council', arguments: { models: ['codex-cli:default'], response_mode: 'individual' } });
    const cxImgDir = mkdtempSync(join(tmpdir(), 'mc-codeximg-'));
    const cxImgPath = join(cxImgDir, 'shot.jpg');
    writeFileSync(cxImgPath, Buffer.from('CODEX_CLI_IMAGE_BYTES_991'));
    try {
      const cxVis = parseToolResult(await codexClient.callTool({
        name: 'ask_council', arguments: { question: 'describe this', mode: 'individual', images: [cxImgPath] },
      }));
      check('codex-cli vision: visionRouting queried default', cxVis.visionRouting?.queriedVisionModels?.includes('codex-cli:default'), JSON.stringify(cxVis.visionRouting));
      const cxVisResp = cxVis.responses?.[0]?.response ?? '';
      check('codex-cli vision: -i flag carried a real, readable image file', /images:OK\(/.test(cxVisResp) && !/MISSING/.test(cxVisResp), cxVisResp);
    } finally {
      rmSync(cxImgDir, { recursive: true, force: true });
    }

    // full_repo_access: -C points at the real repo root instead of the usual
    // empty ephemeral dir — the mock genuinely lists it, proving real access —
    // while --sandbox stays read-only regardless.
    const cxRepoDir = mkdtempSync(join(tmpdir(), 'mc-codexrepo-'));
    execFileSync('git', ['init', '-q'], { cwd: cxRepoDir }); // full_repo_access now requires a real git repo
    writeFileSync(join(cxRepoDir, 'gamma.txt'), 'g');
    writeFileSync(join(cxRepoDir, 'delta.txt'), 'd');
    try {
      const cxRepoAsk = parseToolResult(await codexClient.callTool({
        name: 'ask_council',
        arguments: { question: 'how many files?', mode: 'individual', full_repo_access: true, git_repo: cxRepoDir },
      }));
      const cxRepoResp = cxRepoAsk.responses?.[0]?.response ?? '';
      check('codex-cli full_repo_access: -C points at the real repo root', /cwdlist:\.git\|delta\.txt\|gamma\.txt/.test(cxRepoResp), cxRepoResp);
      check('codex-cli full_repo_access: sandbox still read-only', /sandbox=read-only\b/.test(cxRepoResp), cxRepoResp);
    } finally {
      rmSync(cxRepoDir, { recursive: true, force: true });
    }
  } finally {
    await codexClient.close();
  }

  // ── Test: grok-cli subscription provider (isolated server instance) ────────
  console.log('\n▶ grok-cli subscription provider (mocked grok binary)');
  chmodSync(MOCK_GROK, 0o755);
  const grokTransport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    env: {
      ...process.env,
      OLLAMA_ADDRESS: 'http://127.0.0.1:1',
      XAI_API_KEY: 'xai-test-should-be-stripped', // must NOT reach the CLI
      GROK_CLI: 'true',
      GROK_CLI_PATH: MOCK_GROK,
      GROK_CLI_MODELS: 'grok-4.5,grok-4.5-fast',
      COUNCIL_MODELS: 'grok-cli:grok-4.5,grok-cli:grok-4.5-fast',
      RESPONSE_MODE: 'individual',
      CLOUD_CONCURRENCY: '2',
      MODEL_COUNCIL_STATE: join(tmpdir(), `mc-e2e-grok-${process.pid}.json`), // isolate from real ~/.config
    },
  });
  const grokClient = new Client({ name: 'grok-e2e', version: '1.0.0' }, { capabilities: {} });
  await grokClient.connect(grokTransport);
  try {
    const gcfg = parseToolResult(await grokClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('grok-cli: provider registered', (gcfg.providers ?? []).some(p => p.type === 'grok-cli'), (gcfg.providers ?? []).map(p => p.type).join(','));

    const gx = parseToolResult(await grokClient.callTool({
      name: 'ask_council', arguments: { question: 'hi grok', mode: 'individual' },
    }));
    check('grok-cli: 2 members answered', gx.responses?.length === 2, `got ${gx.responses?.length}`);
    check('grok-cli: model flag passed (grok-4.5)', gx.responses?.some(r => r.label === 'grok-cli:grok-4.5' && /model=grok-4\.5\b/.test(r.response)), gx.responses?.map(r => r.label).join(','));
    check('grok-cli: second member model flag passed (grok-4.5-fast)', gx.responses?.some(r => r.label === 'grok-cli:grok-4.5-fast' && /model=grok-4\.5-fast/.test(r.response)));
    check('grok-cli: XAI_API_KEY stripped (subscription auth)', gx.responses?.every(r => /xkey=unset/.test(r.response ?? '')), gx.responses?.map(r => r.response).join(' | '));
    check('grok-cli: tools disabled in nested call', gx.responses?.every(r => /tools=off/.test(r.response ?? '')));
    check('grok-cli: permission-mode bypassPermissions passed', gx.responses?.every(r => /perm=bypassPermissions/.test(r.response ?? '')));
    check('grok-cli: system prompt overridden (neutral persona)', gx.responses?.every(r => /sys=override/.test(r.response ?? '')));
    check('grok-cli: prompt content reached the CLI', gx.responses?.every(r => /hi grok/.test(r.response ?? '')));
    // Text-only (no images) now goes through --prompt-file (a temp file), not
    // --prompt-json inline — this is the actual argv-length fix: a large
    // context/files/judge prompt no longer risks an OS argv-length limit.
    check('grok-cli: text-only prompt uses --prompt-file, not inline --prompt-json',
      gx.responses?.every(r => /via=file\b/.test(r.response ?? '')), gx.responses?.map(r => r.response).join(' | '));

    // CLI-reported error ({"type":"error",...} + exit 1) → surfaced as a member error
    await grokClient.callTool({ name: 'configure_council', arguments: { models: ['grok-cli:erroring'], response_mode: 'individual' } });
    const gErrRes = parseToolResult(await grokClient.callTool({ name: 'ask_council', arguments: { question: 'x', mode: 'individual' } }));
    check('grok-cli: CLI error surfaced as member error', !!gErrRes.responses?.[0]?.error && !gErrRes.responses?.[0]?.response, JSON.stringify(gErrRes.responses?.[0]));

    // Vision: grok-cli passes images as native --prompt-json "image" content
    // blocks (no Read-tool/-i-flag workaround needed) — asserts the mock
    // observed a real image block and no tool loosening was required.
    await grokClient.callTool({ name: 'configure_council', arguments: { models: ['grok-cli:grok-4.5'], response_mode: 'individual' } });
    const grokImgDir = mkdtempSync(join(tmpdir(), 'mc-grokimg-'));
    const grokImgPath = join(grokImgDir, 'shot.png');
    writeFileSync(grokImgPath, Buffer.from('GROK_CLI_IMAGE_BYTES_213'));
    try {
      const grokVis = parseToolResult(await grokClient.callTool({
        name: 'ask_council', arguments: { question: 'describe this', mode: 'individual', images: [grokImgPath] },
      }));
      check('grok-cli vision: visionRouting queried grok-4.5', grokVis.visionRouting?.queriedVisionModels?.includes('grok-cli:grok-4.5'), JSON.stringify(grokVis.visionRouting));
      const grokVisResp = grokVis.responses?.[0]?.response ?? '';
      check('grok-cli vision: native image block carried (no tool loosening)', /tools=off\b/.test(grokVisResp) && /images=1\b/.test(grokVisResp), grokVisResp);
      // Image-bearing calls still use --prompt-json inline (no documented
      // file-based channel for the content-block format — see file header).
      check('grok-cli vision: image-bearing call still uses --prompt-json, not --prompt-file', /via=json\b/.test(grokVisResp), grokVisResp);
    } finally {
      rmSync(grokImgDir, { recursive: true, force: true });
    }
  } finally {
    await grokClient.close();
  }

  // ── Test: Phase 2 — auto-population + environment detection (isolated) ──────
  console.log('\n▶ zero-config auto-population + environment detection');
  chmodSync(MOCK_CLAUDE, 0o755);
  chmodSync(MOCK_CODEX, 0o755);
  chmodSync(MOCK_GROK, 0o755);
  const stateDir = mkdtempSync(join(tmpdir(), 'mc-e2e-'));
  const stateFile = join(stateDir, 'state.json');
  const detectTransport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    env: {
      ...process.env,
      OLLAMA_ADDRESS: MOCK_URL,
      CLAUDE_CLI_PATH: MOCK_CLAUDE,
      CODEX_CLI_PATH: MOCK_CODEX,
      GROK_CLI_PATH: MOCK_GROK,
      MODEL_COUNCIL_STATE: stateFile, // fresh → boot auto-populates
      // default tiers (unset) → plus/pro/pro/free → cloud on for all but grok
      // (grok defaults to 'free' unlike claude/chatgpt, see config.ts)
    },
  });
  const detectClient = new Client({ name: 'detect-e2e', version: '1.0.0' }, { capabilities: {} });
  await detectClient.connect(detectTransport);
  let rebootClient, loggedOutClient, loDir, claudeFreeClient, cfDir, tierFallbackClient, tfDir;
  try {
    const st = parseToolResult(await detectClient.callTool({ name: 'council_status', arguments: {} }));
    check('status: ollama reachable', st.detected?.ollama?.reachable === true);
    check('status: local models detected', (st.detected?.ollama?.localModels ?? []).length >= 3, JSON.stringify(st.detected?.ollama?.localModels));
    check('status: ollama cloud probe ok', st.detected?.ollama?.cloud === 'ok', st.detected?.ollama?.cloud);
    check('status: claude CLI installed + usable', st.detected?.claude?.installed === true && st.detected?.claude?.usable === true);
    check('status: codex CLI installed + logged in', st.detected?.codex?.installed === true && st.detected?.codex?.usable === true);
    // At the default 'free' tier, detectGrok() must NOT spend a real (quota-metered)
    // login probe — usable stays false, unverified, until the tier opts in.
    check('status: grok CLI installed, but NOT probed at free tier (no quota spent)', st.detected?.grok?.installed === true && st.detected?.grok?.usable === false, JSON.stringify(st.detected?.grok));
    check('status: per-provider concurrency from tiers', st.concurrency?.chatgpt === 6 && st.concurrency?.['ollama-cloud'] === 3 && st.concurrency?.claude === 2, JSON.stringify(st.concurrency));
    check('status: quota warning present', typeof st.quotaWarning === 'string' && st.quotaWarning.length > 0);
    check('status: grok tier defaults to free (opt-in, unlike claude/chatgpt)', st.tiers?.grok === 'free', JSON.stringify(st.tiers));
    check('status: hint nudges toward GROK_TIER since tier gate not yet opted in', (st.hints ?? []).some(h => /GROK_TIER/.test(h)), (st.hints ?? []).join(' | '));

    const setup = parseToolResult(await detectClient.callTool({ name: 'setup_council', arguments: { ollama: 'max' } }));
    check('setup: ollama tier max applied', setup.tiers?.ollama === 'max' && setup.applied?.ollama === 'max');
    const labels = setup.council?.members ?? [];
    check('setup: auto-populated local + cloud + claude + codex',
      labels.includes('ollama:small-a') && labels.some(l => /cloud/.test(l)) && labels.some(l => l.startsWith('claude-cli:')) && labels.some(l => l.startsWith('codex-cli:')),
      labels.join(','));
    check('setup: grok excluded by default (free tier, opt-in)', !labels.some(l => l.startsWith('grok-cli:')), labels.join(','));

    // Regression: a mistyped/invalid tier value must be surfaced as `invalid`,
    // not silently dropped with no trace (round-3 finding) — and must NOT
    // clobber the currently-effective tier for that provider.
    const badTier = parseToolResult(await detectClient.callTool({ name: 'setup_council', arguments: { claude: 'premium' } }));
    check('setup: an invalid tier value is surfaced in `invalid`, not silently dropped',
      badTier.invalid?.claude === 'premium', JSON.stringify(badTier.invalid));
    check('setup: an invalid tier value is NOT applied', badTier.applied?.claude === undefined, JSON.stringify(badTier.applied));

    // Opting into a paid Grok tier pulls grok-cli members into the auto-council.
    const grokSetup = parseToolResult(await detectClient.callTool({ name: 'setup_council', arguments: { grok: 'supergrok' } }));
    check('setup: grok tier supergrok applied', grokSetup.tiers?.grok === 'supergrok' && grokSetup.applied?.grok === 'supergrok');
    check('setup: grok-cli members now included', (grokSetup.council?.members ?? []).some(l => l.startsWith('grok-cli:')), (grokSetup.council?.members ?? []).join(','));

    const labelsWithGrok = grokSetup.council?.members ?? [];
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    check('setup: council persisted to state file', Array.isArray(persisted.members) && persisted.members.length === labelsWithGrok.length);
    check('setup: tier persisted to state file', persisted.tiers?.ollama === 'max');
    // Regression: only the tier keys the caller ACTUALLY supplied across
    // these two setup_council calls (ollama, grok) should be in state.tiers —
    // chatgpt/claude were never touched by either call. Persisting them too
    // (the old bug) would pin them to whatever was effective at call time,
    // permanently shadowing any later env var change for those providers.
    check('setup: untouched tier keys (chatgpt/claude) are NOT persisted — no accidental pinning',
      !('chatgpt' in (persisted.tiers ?? {})) && !('claude' in (persisted.tiers ?? {})), JSON.stringify(persisted.tiers));

    // Delete a member via configure_council → the reduced set persists.
    const reduced = labels.filter(l => l !== 'ollama:small-a');
    await detectClient.callTool({ name: 'configure_council', arguments: { models: reduced } });
    const persisted2 = JSON.parse(readFileSync(stateFile, 'utf8'));
    check('configure_council: deletion persisted', persisted2.members?.length === reduced.length && !persisted2.members.includes('ollama:small-a'));

    // Vision-capability results persist to disk too, so a restart doesn't re-pay
    // the OCR-challenge round trip for a model already proven capable.
    const visImgDir = mkdtempSync(join(tmpdir(), 'mc-e2e-vis-'));
    const visImgFile = join(visImgDir, 'photo.png');
    writeFileSync(visImgFile, Buffer.from('FAKE_IMAGE_BYTES'));
    await resetMock();
    await detectClient.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:vision-a'], response_mode: 'individual' },
    });
    const visAsk1 = parseToolResult(await detectClient.callTool({
      name: 'ask_council', arguments: { question: 'x', images: [visImgFile] },
    }));
    check('vision persistence: first ask routes to the vision-capable member', visAsk1.responses?.length === 1, JSON.stringify(visAsk1.responses));
    const dbgVis1 = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('vision persistence: first ask actually ran the OCR challenge', dbgVis1.challengeCalls >= 1, `challengeCalls=${dbgVis1.challengeCalls}`);
    const persisted3 = JSON.parse(readFileSync(stateFile, 'utf8'));
    check('vision persistence: result written to state file', persisted3.visionCapability?.['ollama:vision-a']?.value === true, JSON.stringify(persisted3.visionCapability));
    check('vision persistence: entry carries a checkedAt timestamp (for TTL expiry)',
      Number.isFinite(persisted3.visionCapability?.['ollama:vision-a']?.checkedAt), JSON.stringify(persisted3.visionCapability));

    // Restore the `reduced` council (the vision test above reconfigured members
    // to just vision-a) so the reboot-persistence check below still sees it.
    await detectClient.callTool({ name: 'configure_council', arguments: { models: reduced } });

    await detectClient.close();

    // Round-17 (kimi): the detection probe uses grok's proven-RCE argv, so it
    // must NOT run unless the user opted in via GROK_CLI_UNSAFE_ACCEPT_RCE. A
    // PAID Grok tier is a quota opt-in, NOT an RCE opt-in — so a supergrok user
    // who never set the RCE flag must get grok usable:false (no probe, no RCE
    // surface), matching the disabled provider. If the gate failed, the mock
    // grok probe would return stopReason EndTurn → usable:true.
    const { GROK_CLI_UNSAFE_ACCEPT_RCE: _omit, ...noRceEnv } = process.env;
    const noRceStateDir = mkdtempSync(join(tmpdir(), 'mc-e2e-norce-'));
    const noRceTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...noRceEnv, GROK_TIER: 'supergrok', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: join(noRceStateDir, 'state.json') },
    });
    const noRceClient = new Client({ name: 'norce-e2e', version: '1.0.0' }, { capabilities: {} });
    await noRceClient.connect(noRceTransport);
    try {
      const noRceSt = parseToolResult(await noRceClient.callTool({ name: 'council_status', arguments: {} }));
      check('round-17: paid grok tier WITHOUT the RCE opt-in is NOT probed (usable:false, no RCE surface)',
        noRceSt.detected?.grok?.installed === true && noRceSt.detected?.grok?.usable === false,
        JSON.stringify(noRceSt.detected?.grok));
      check('round-17: paid grok tier without RCE opt-in adds no grok-cli members',
        !(noRceSt.council?.members ?? []).some(l => l.startsWith('grok-cli:')),
        (noRceSt.council?.members ?? []).join(','));
    } finally {
      await noRceClient.close();
    }

    // Reboot against the SAME state file → the reduced council must be honoured
    // (initCouncil applies persisted members, does NOT re-auto-populate the deletion).
    const rebootTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: stateFile },
    });
    rebootClient = new Client({ name: 'reboot-e2e', version: '1.0.0' }, { capabilities: {} });
    await rebootClient.connect(rebootTransport);
    let rebootMembers = [];
    for (let i = 0; i < 50; i++) { // initCouncil applies persisted members async after boot
      const gc = parseToolResult(await rebootClient.callTool({ name: 'get_council_config', arguments: {} }));
      rebootMembers = gc.council?.members ?? [];
      if (rebootMembers.length === reduced.length) break;
      await new Promise(r => setTimeout(r, 100));
    }
    check('reboot: persisted (reduced) council honoured — deletions stick', rebootMembers.length === reduced.length && !rebootMembers.includes('ollama:small-a'), `got ${rebootMembers.length}`);

    // Same reboot, same state file: a vision question against the SAME member
    // must skip the OCR-challenge round trip entirely — the seeded cache from
    // disk answers it — while still routing correctly.
    await resetMock();
    await rebootClient.callTool({
      name: 'configure_council',
      arguments: { models: ['ollama:vision-a'], response_mode: 'individual' },
    });
    const visAsk2 = parseToolResult(await rebootClient.callTool({
      name: 'ask_council', arguments: { question: 'x', images: [visImgFile] },
    }));
    check('vision persistence: reboot still routes to the vision-capable member', visAsk2.responses?.length === 1, JSON.stringify(visAsk2.responses));
    const dbgVis2 = await (await fetch(`${MOCK_URL}/debug`)).json();
    check('vision persistence: reboot skips re-running the OCR challenge (seeded from disk)', dbgVis2.challengeCalls === 0, `challengeCalls=${dbgVis2.challengeCalls}`);

    await rebootClient.close(); rebootClient = undefined;

    // TTL regression: an entry older than VISION_CACHE_TTL_MS (30 days) must
    // NOT be trusted — a stale "capable" (or "not capable") result from
    // before a later Ollama pull / provider fix would otherwise stick
    // forever with no way to clear it short of hand-editing state.json.
    {
      const stale = JSON.parse(readFileSync(stateFile, 'utf8'));
      stale.visionCapability['ollama:vision-a'] = { value: true, checkedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 };
      writeFileSync(stateFile, JSON.stringify(stale, null, 2));
      await resetMock();
      const ttlTransport = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: stateFile },
      });
      const ttlClient = new Client({ name: 'ttl-e2e', version: '1.0.0' }, { capabilities: {} });
      await ttlClient.connect(ttlTransport);
      await ttlClient.callTool({ name: 'configure_council', arguments: { models: ['ollama:vision-a'], response_mode: 'individual' } });
      const visAsk3 = parseToolResult(await ttlClient.callTool({ name: 'ask_council', arguments: { question: 'x', images: [visImgFile] } }));
      check('vision TTL: expired cache entry still routes correctly (re-probed, not just trusted)', visAsk3.responses?.length === 1, JSON.stringify(visAsk3.responses));
      const dbgVis3 = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('vision TTL: an expired entry triggers a genuine re-probe, not a stale trust', dbgVis3.challengeCalls >= 1, `challengeCalls=${dbgVis3.challengeCalls}`);
      const refreshed = JSON.parse(readFileSync(stateFile, 'utf8'));
      check('vision TTL: re-probe refreshes checkedAt (so it does not re-probe again every call)',
        refreshed.visionCapability?.['ollama:vision-a']?.checkedAt > stale.visionCapability['ollama:vision-a'].checkedAt,
        JSON.stringify(refreshed.visionCapability));
      await ttlClient.close();
    }

    // Clock-skew regression (round 4): a FUTURE-dated checkedAt must not be
    // trusted forever. Before the fix, `visionCheckedAt - entry.checkedAt`
    // went negative for a future timestamp, which satisfies `< TTL` (a large
    // positive number) permanently — the exact sticky-forever bug the TTL was
    // added to kill, reintroduced via clock skew (VM resume, NTP correction,
    // a hand-edited file) instead of simple staleness.
    {
      const future = JSON.parse(readFileSync(stateFile, 'utf8'));
      future.visionCapability['ollama:vision-a'] = { value: true, checkedAt: Date.now() + 10 * 24 * 60 * 60 * 1000 };
      writeFileSync(stateFile, JSON.stringify(future, null, 2));
      await resetMock();
      const skewTransport = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: stateFile },
      });
      const skewClient = new Client({ name: 'skew-e2e', version: '1.0.0' }, { capabilities: {} });
      await skewClient.connect(skewTransport);
      await skewClient.callTool({ name: 'configure_council', arguments: { models: ['ollama:vision-a'], response_mode: 'individual' } });
      await skewClient.callTool({ name: 'ask_council', arguments: { question: 'x', images: [visImgFile] } });
      const dbgSkew = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('vision clock-skew: a future-dated checkedAt is NOT trusted as fresh (genuine re-probe)', dbgSkew.challengeCalls >= 1, `challengeCalls=${dbgSkew.challengeCalls}`);
      const afterSkew = JSON.parse(readFileSync(stateFile, 'utf8'));
      check('vision clock-skew: re-probe corrects checkedAt back to a sane (non-future) value',
        afterSkew.visionCapability?.['ollama:vision-a']?.checkedAt <= Date.now(), JSON.stringify(afterSkew.visionCapability));
      await skewClient.close();
    }

    // Shape-validation regression (round 4): a non-boolean `value` (e.g. a
    // hand-corrupted state.json with the STRING "false") must not be trusted
    // — a truthy non-boolean would otherwise flow straight into
    // seedVisionCache and defeat "an image never reaches a non-vision model."
    {
      const corrupt = JSON.parse(readFileSync(stateFile, 'utf8'));
      corrupt.visionCapability['ollama:vision-a'] = { value: 'false', checkedAt: Date.now() };
      writeFileSync(stateFile, JSON.stringify(corrupt, null, 2));
      await resetMock();
      const shapeTransport = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: stateFile },
      });
      const shapeClient = new Client({ name: 'shape-e2e', version: '1.0.0' }, { capabilities: {} });
      await shapeClient.connect(shapeTransport);
      await shapeClient.callTool({ name: 'configure_council', arguments: { models: ['ollama:vision-a'], response_mode: 'individual' } });
      await shapeClient.callTool({ name: 'ask_council', arguments: { question: 'x', images: [visImgFile] } });
      const dbgShape = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('vision shape-validation: a non-boolean cached value is NOT trusted (genuine re-probe)', dbgShape.challengeCalls >= 1, `challengeCalls=${dbgShape.challengeCalls}`);
      await shapeClient.close();
    }

    // Laundering regression (round 5): a disk entry expiring mid-process must
    // NOT get its checkedAt silently refreshed from the provider's own
    // long-lived in-memory cache without a genuine live re-probe — that would
    // permanently disable the TTL's self-healing for the life of the process
    // AND leave a falsely-fresh lease on disk that survives a restart too.
    {
      const launderDir = mkdtempSync(join(tmpdir(), 'mc-e2e-launder-'));
      const launderStateFile = join(launderDir, 'state.json');
      await resetMock();
      const launderTransport = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: launderStateFile },
      });
      const launderClient = new Client({ name: 'launder-e2e', version: '1.0.0' }, { capabilities: {} });
      await launderClient.connect(launderTransport);
      await launderClient.callTool({ name: 'configure_council', arguments: { models: ['ollama:vision-a'], response_mode: 'individual' } });

      // First ask: genuine live probe, populates BOTH the provider's
      // in-memory cache and the on-disk entry.
      await launderClient.callTool({ name: 'ask_council', arguments: { question: 'x', images: [visImgFile] } });
      const dbgFirst = await (await fetch(`${MOCK_URL}/debug`)).json();
      const callsAfterFirst = dbgFirst.challengeCalls;

      // Force the ON-DISK entry to look expired, while the SAME process's
      // provider still holds the in-memory value from the ask above —
      // exactly the split state that exposes the laundering bug.
      const beforeSecond = JSON.parse(readFileSync(launderStateFile, 'utf8'));
      const expiredStamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      beforeSecond.visionCapability['ollama:vision-a'].checkedAt = expiredStamp;
      writeFileSync(launderStateFile, JSON.stringify(beforeSecond, null, 2));

      // Second ask, SAME process: the in-memory cache still short-circuits
      // supportsVision() (challengeCalls must NOT increase — that part of
      // the behavior is correct and expected), but the on-disk checkedAt
      // must NOT be refreshed either, since no live probe actually happened.
      await launderClient.callTool({ name: 'ask_council', arguments: { question: 'y', images: [visImgFile] } });
      const dbgSecond = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('vision laundering: in-memory cache still short-circuits the OCR challenge (unchanged behavior)',
        dbgSecond.challengeCalls === callsAfterFirst, `first=${callsAfterFirst} second=${dbgSecond.challengeCalls}`);
      const afterSecond = JSON.parse(readFileSync(launderStateFile, 'utf8'));
      check('vision laundering: an expired on-disk entry is NOT laundered into a fresh checkedAt without a genuine live probe',
        afterSecond.visionCapability?.['ollama:vision-a']?.checkedAt === expiredStamp,
        JSON.stringify(afterSecond.visionCapability));
      await launderClient.close();

      // Reboot (new process, same state file): the on-disk entry is still
      // genuinely expired (round-2 assertion proved it wasn't laundered), so
      // this MUST trigger a real re-probe now that the in-memory cache is gone.
      await resetMock();
      const launderRebootTransport = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: launderStateFile },
      });
      const launderRebootClient = new Client({ name: 'launder-reboot-e2e', version: '1.0.0' }, { capabilities: {} });
      await launderRebootClient.connect(launderRebootTransport);
      await launderRebootClient.callTool({ name: 'configure_council', arguments: { models: ['ollama:vision-a'], response_mode: 'individual' } });
      await launderRebootClient.callTool({ name: 'ask_council', arguments: { question: 'z', images: [visImgFile] } });
      const dbgReboot = await (await fetch(`${MOCK_URL}/debug`)).json();
      check('vision laundering: the un-laundered expired entry DOES trigger a genuine re-probe after restart',
        dbgReboot.challengeCalls >= 1, `challengeCalls=${dbgReboot.challengeCalls}`);
      await launderRebootClient.close();
      rmSync(launderDir, { recursive: true, force: true });
    }
    rmSync(visImgDir, { recursive: true, force: true });

    // configure_council settings (judge_model/response_mode/max_deconflict_rounds)
    // must persist across a restart, same as `members` already does — round-2
    // and round-3 reviewers both flagged the prior session-only behavior as an
    // inconsistency users would trip over.
    {
      const cfgDir = mkdtempSync(join(tmpdir(), 'mc-e2e-cfgpersist-'));
      const cfgStateFile = join(cfgDir, 'state.json');
      const cfgTransport1 = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: cfgStateFile },
      });
      const cfgClient1 = new Client({ name: 'cfgpersist-e2e-1', version: '1.0.0' }, { capabilities: {} });
      await cfgClient1.connect(cfgTransport1);
      await cfgClient1.callTool({
        name: 'configure_council',
        arguments: { judge_model: 'ollama:small-a', response_mode: 'deconflicted', max_deconflict_rounds: 5 },
      });
      const cfgPersisted = JSON.parse(readFileSync(cfgStateFile, 'utf8'));
      check('configure_council: judge_model persisted to state file', cfgPersisted.judgeModelId?.model === 'small-a' && cfgPersisted.judgeModelId?.provider === 'ollama', JSON.stringify(cfgPersisted.judgeModelId));
      check('configure_council: response_mode persisted to state file', cfgPersisted.responseMode === 'deconflicted');
      check('configure_council: max_deconflict_rounds persisted to state file', cfgPersisted.maxDeconflictRounds === 5);
      await cfgClient1.close();

      // Reboot against the SAME state file → all three settings must be
      // honoured WITHOUT re-supplying them (this is the actual bug fixed:
      // previously only `members` survived, these three silently reset).
      const cfgTransport2 = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: cfgStateFile },
      });
      const cfgClient2 = new Client({ name: 'cfgpersist-e2e-2', version: '1.0.0' }, { capabilities: {} });
      await cfgClient2.connect(cfgTransport2);
      const cfgAfterReboot = parseToolResult(await cfgClient2.callTool({ name: 'get_council_config', arguments: {} }));
      check('configure_council: judge_model survives reboot', cfgAfterReboot.council?.judgeModel === 'ollama:small-a', JSON.stringify(cfgAfterReboot.council));
      check('configure_council: response_mode survives reboot', cfgAfterReboot.council?.responseMode === 'deconflicted', JSON.stringify(cfgAfterReboot.council));
      check('configure_council: max_deconflict_rounds survives reboot', cfgAfterReboot.council?.maxDeconflictRounds === 5, JSON.stringify(cfgAfterReboot.council));

      // Clearing judge_model back to "auto" must persist as CLEARED (absent),
      // not just skip re-writing whatever was there.
      await cfgClient2.callTool({ name: 'configure_council', arguments: { judge_model: 'auto' } });
      const cfgAfterClear = JSON.parse(readFileSync(cfgStateFile, 'utf8'));
      check('configure_council: judge_model "auto" clears the persisted value (not left stale)', !('judgeModelId' in cfgAfterClear), JSON.stringify(cfgAfterClear.judgeModelId));

      // auto_council regression (round 4): it updates the live config but was
      // never added to the persistence patch — survived only until reload.
      await cfgClient2.callTool({ name: 'configure_council', arguments: { auto_council: false } });
      const cfgAutoCouncilPersisted = JSON.parse(readFileSync(cfgStateFile, 'utf8'));
      check('configure_council: auto_council persisted to state file', cfgAutoCouncilPersisted.autoCouncil === false, JSON.stringify(cfgAutoCouncilPersisted.autoCouncil));
      await cfgClient2.close();

      const cfgTransport3 = new StdioClientTransport({
        command: 'node', args: [serverEntry],
        env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: cfgStateFile },
      });
      const cfgClient3 = new Client({ name: 'cfgpersist-e2e-3', version: '1.0.0' }, { capabilities: {} });
      await cfgClient3.connect(cfgTransport3);
      const cfgAfterAutoCouncilReboot = parseToolResult(await cfgClient3.callTool({ name: 'get_council_config', arguments: {} }));
      check('configure_council: auto_council survives reboot', cfgAfterAutoCouncilReboot.council?.autoCouncil === false, JSON.stringify(cfgAfterAutoCouncilReboot.council));

      // All-rejected regression (round 4): every entry failing to parse must
      // throw and leave the council untouched, NOT silently wipe it to empty
      // and persist that — the sibling bug to the one round 3 fixed for
      // setup_council's auto-population path. An explicit `models: []` must
      // still work as the real "clear the council" gesture.
      await cfgClient3.callTool({ name: 'configure_council', arguments: { models: ['ollama:small-a'] } });
      let allRejectedThrew = false, allRejectedMsg = '';
      try {
        await cfgClient3.callTool({ name: 'configure_council', arguments: { models: ['not-a-real-id', 'also:not:valid:::'] } });
      } catch (e) { allRejectedThrew = true; allRejectedMsg = String(e?.message ?? e); }
      const cfgAfterAllRejected = parseToolResult(await cfgClient3.callTool({ name: 'get_council_config', arguments: {} }));
      check('configure_council: all-models-rejected throws instead of silently wiping', allRejectedThrew, allRejectedMsg);
      check('configure_council: council unchanged after an all-rejected call', (cfgAfterAllRejected.council?.members ?? []).includes('ollama:small-a'), JSON.stringify(cfgAfterAllRejected.council?.members));

      const clearRes = parseToolResult(await cfgClient3.callTool({ name: 'configure_council', arguments: { models: [] } }));
      check('configure_council: an explicit models:[] still clears the council (not treated as all-rejected)',
        Array.isArray(clearRes.council?.members) ? clearRes.council.members.length === 0 : /auto/.test(String(clearRes.council?.members)),
        JSON.stringify(clearRes.council));

      // ── Unknown parameters are REJECTED, not silently stripped (real-world report) ──
      // Zod's default strips unrecognized keys, so a caller passing `members:`
      // (what get_council_config REPORTS the council as) instead of `models:`,
      // or `ResponseMode:` instead of `response_mode:`, got a cheerful
      // status:"updated" while NOTHING was applied — a silent no-op reported as
      // success. Schemas are now .strict() with an instructive did-you-mean error.
      await cfgClient3.callTool({ name: 'configure_council', arguments: { models: ['ollama:small-a'] } });
      let badParamThrew = false, badParamMsg = '';
      try {
        await cfgClient3.callTool({ name: 'configure_council', arguments: { members: ['ollama:small-b'], ResponseMode: 'dialectic' } });
      } catch (e) { badParamThrew = true; badParamMsg = String(e?.message ?? e); }
      check('unknown params: rejected instead of silently succeeding', badParamThrew, badParamMsg);
      check('unknown params: names the offending key ("members")', /Unknown parameter "members"/.test(badParamMsg), badParamMsg);
      check('unknown params: suggests the right one (members → models)', /did you mean "models"/.test(badParamMsg), badParamMsg);
      check('unknown params: catches camelCase slip (ResponseMode → response_mode)', /did you mean "response_mode"/.test(badParamMsg), badParamMsg);
      check('unknown params: lists the valid parameters', /valid: models, judge_model, response_mode/.test(badParamMsg), badParamMsg);
      check('unknown params: points at the README', /github\.com\/tsarihan\/model-council-mcp/.test(badParamMsg), badParamMsg);
      const cfgAfterBadParam = parseToolResult(await cfgClient3.callTool({ name: 'get_council_config', arguments: {} }));
      check('unknown params: council genuinely unchanged (the no-op is now visible, not silent)',
        (cfgAfterBadParam.council?.members ?? []).includes('ollama:small-a'), JSON.stringify(cfgAfterBadParam.council?.members));
      // A correct call must still work — strictness must not break normal usage.
      const goodAfterBad = parseToolResult(await cfgClient3.callTool({ name: 'configure_council', arguments: { models: ['ollama:small-b'], response_mode: 'individual' } }));
      check('unknown params: a CORRECT call still succeeds after strictness', (goodAfterBad.council?.members ?? []).includes('ollama:small-b'), JSON.stringify(goodAfterBad.council));
      // ask_council rejects unknown params too (not just configure_council).
      let askBadThrew = false, askBadMsg = '';
      try {
        await cfgClient3.callTool({ name: 'ask_council', arguments: { question: 'hi', responseMode: 'individual' } });
      } catch (e) { askBadThrew = true; askBadMsg = String(e?.message ?? e); }
      check('unknown params: ask_council also rejects (suggests mode)', askBadThrew && /Unknown parameter "responseMode"/.test(askBadMsg), askBadMsg);
      await cfgClient3.close();
      rmSync(cfgDir, { recursive: true, force: true });
    }

    // Logged-out Codex → detected not-usable, excluded from the auto-council, hinted.
    loDir = mkdtempSync(join(tmpdir(), 'mc-e2e-lo-'));
    const loTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, CODEX_MOCK_LOGGED_OUT: '1', MODEL_COUNCIL_STATE: join(loDir, 'state.json') },
    });
    loggedOutClient = new Client({ name: 'lo-e2e', version: '1.0.0' }, { capabilities: {} });
    await loggedOutClient.connect(loTransport);
    const lo = parseToolResult(await loggedOutClient.callTool({ name: 'council_status', arguments: {} }));
    check('logged-out: codex installed but NOT usable', lo.detected?.codex?.installed === true && lo.detected?.codex?.usable === false, JSON.stringify(lo.detected?.codex));
    check('logged-out: hint tells user to run `codex login`', (lo.hints ?? []).some(h => /codex login/i.test(h)), (lo.hints ?? []).join(' | '));
    const loSetup = parseToolResult(await loggedOutClient.callTool({ name: 'setup_council', arguments: {} }));
    check('logged-out: codex members excluded from auto-council', !(loSetup.council?.members ?? []).some(l => l.startsWith('codex-cli:')), (loSetup.council?.members ?? []).join(','));
    await loggedOutClient.close(); loggedOutClient = undefined;

    // Claude at 'free' tier → detectClaude() must NOT spend a real (quota-metered)
    // completion probe, mirroring detectGrok's existing gate. Without the gate,
    // the mock would happily answer READY and usable would come back true even
    // at a tier that explicitly opted out of claude-cli members.
    cfDir = mkdtempSync(join(tmpdir(), 'mc-e2e-cf-'));
    const cfTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, CLAUDE_TIER: 'free', MODEL_COUNCIL_STATE: join(cfDir, 'state.json') },
    });
    claudeFreeClient = new Client({ name: 'cf-e2e', version: '1.0.0' }, { capabilities: {} });
    await claudeFreeClient.connect(cfTransport);
    const cf = parseToolResult(await claudeFreeClient.callTool({ name: 'council_status', arguments: {} }));
    check('claude free tier: installed detected (cheap --version check still runs)', cf.detected?.claude?.installed === true, JSON.stringify(cf.detected?.claude));
    check('claude free tier: usable stays false (real probe gated, not spent)', cf.detected?.claude?.usable === false, JSON.stringify(cf.detected?.claude));
    const cfSetup = parseToolResult(await claudeFreeClient.callTool({ name: 'setup_council', arguments: {} }));
    check('claude free tier: claude-cli members excluded from auto-council', !(cfSetup.council?.members ?? []).some(l => l.startsWith('claude-cli:')), (cfSetup.council?.members ?? []).join(','));
    await claudeFreeClient.close(); claudeFreeClient = undefined;

    // effectiveTiers/resolveTier fallback: if subscriptions.json ever renames
    // or removes the hardcoded literal default tier itself (here, claude's
    // "pro"), falling back to that literal unconditionally would return an
    // invalid tier just as readily as the invalid input it was guarding
    // against. Point a fresh boot at a custom subscriptions.json where
    // claude's tiers don't include "pro" at all — no env/state tier is set,
    // so resolution falls all the way through to the literal default, which
    // must itself be re-validated rather than trusted.
    tfDir = mkdtempSync(join(tmpdir(), 'mc-e2e-tf-'));
    const customSubsPath = join(tfDir, 'subscriptions.json');
    const realSubs = JSON.parse(readFileSync(join('config', 'subscriptions.json'), 'utf8'));
    writeFileSync(customSubsPath, JSON.stringify({
      ...realSubs,
      providers: {
        ...realSubs.providers,
        claude: { ...realSubs.providers.claude, tiers: { starter: { cloud: false }, elite: { cloud: true, concurrency: 2 } } },
      },
    }));
    const tfTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: {
        ...process.env, OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK,
        MODEL_COUNCIL_SUBSCRIPTIONS: customSubsPath, MODEL_COUNCIL_STATE: join(tfDir, 'state.json'),
      },
    });
    tierFallbackClient = new Client({ name: 'tf-e2e', version: '1.0.0' }, { capabilities: {} });
    await tierFallbackClient.connect(tfTransport);
    const tf = parseToolResult(await tierFallbackClient.callTool({ name: 'council_status', arguments: {} }));
    check('tier fallback: claude tier is NOT the stale hardcoded default ("pro", absent from this subscriptions.json)', tf.tiers?.claude !== 'pro', JSON.stringify(tf.tiers));
    check('tier fallback: claude tier is a value this subscriptions.json actually defines', ['starter', 'elite'].includes(tf.tiers?.claude), JSON.stringify(tf.tiers));
    await tierFallbackClient.close(); tierFallbackClient = undefined;

    // Fallback-CHAIN regression (round 5): a present-but-INVALID persisted
    // tier must fall through to a valid ENV var next, not skip straight past
    // it to the least-privileged "free" tier. Pre-seed a state file with a
    // corrupted claude tier, boot with a valid CLAUDE_TIER — the effective
    // tier must be the env value, proving both config.ts's resolveTier (boot)
    // and index.ts's effectiveTiers (council_status) honour the full chain.
    const chainDir = mkdtempSync(join(tmpdir(), 'mc-e2e-tierchain-'));
    writeFileSync(join(chainDir, 'state.json'), JSON.stringify({ version: 1, tiers: { claude: 'not-a-real-tier' } }));
    const chainTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, CLAUDE_TIER: 'max20x', MODEL_COUNCIL_STATE: join(chainDir, 'state.json') },
    });
    const chainClient = new Client({ name: 'tierchain-e2e', version: '1.0.0' }, { capabilities: {} });
    await chainClient.connect(chainTransport);
    const chainStatus = parseToolResult(await chainClient.callTool({ name: 'council_status', arguments: {} }));
    check('tier fallback CHAIN: an invalid persisted tier falls through to a valid env var, not straight to "free"',
      chainStatus.tiers?.claude === 'max20x', JSON.stringify(chainStatus.tiers));
    await chainClient.close();
    rmSync(chainDir, { recursive: true, force: true });

    // Malformed-override regression (round 5): CLOUD_CONCURRENCY=<garbage>
    // must resolve to "as if unset" (per-tier concurrency applies), NOT
    // silently collapse every cloud pool to the numeric default.
    const badConcDir = mkdtempSync(join(tmpdir(), 'mc-e2e-badconc-'));
    const badConcTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, CLOUD_CONCURRENCY: 'three', MODEL_COUNCIL_STATE: join(badConcDir, 'state.json') },
    });
    const badConcClient = new Client({ name: 'badconc-e2e', version: '1.0.0' }, { capabilities: {} });
    await badConcClient.connect(badConcTransport);
    const badConcStatus = parseToolResult(await badConcClient.callTool({ name: 'council_status', arguments: {} }));
    check('malformed CLOUD_CONCURRENCY: chatgpt keeps its own tier-derived concurrency (6), not collapsed to a single value',
      badConcStatus.concurrency?.chatgpt === 6, JSON.stringify(badConcStatus.concurrency));
    check('malformed CLOUD_CONCURRENCY: claude keeps its own tier-derived concurrency (2 at default pro tier), distinct from chatgpt',
      badConcStatus.concurrency?.claude === 2 && badConcStatus.concurrency?.claude !== badConcStatus.concurrency?.chatgpt,
      JSON.stringify(badConcStatus.concurrency));
    await badConcClient.close();
    rmSync(badConcDir, { recursive: true, force: true });

    // Prefix-truncation regression (round 6): parseInt("3oops", 10) === 3, so
    // an earlier "just check Number.isFinite" guard did NOT catch this —
    // CLOUD_CONCURRENCY=3oops must resolve the same as any other unparseable
    // value ("as if unset"), not silently become an active override of 3.
    const prefixDir = mkdtempSync(join(tmpdir(), 'mc-e2e-prefixconc-'));
    const prefixTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, CLOUD_CONCURRENCY: '3oops', MODEL_COUNCIL_STATE: join(prefixDir, 'state.json') },
    });
    const prefixClient = new Client({ name: 'prefixconc-e2e', version: '1.0.0' }, { capabilities: {} });
    await prefixClient.connect(prefixTransport);
    const prefixStatus = parseToolResult(await prefixClient.callTool({ name: 'council_status', arguments: {} }));
    check('prefix-truncated CLOUD_CONCURRENCY ("3oops"): chatgpt keeps its own tier-derived concurrency (6), not collapsed to 3',
      prefixStatus.concurrency?.chatgpt === 6, JSON.stringify(prefixStatus.concurrency));
    check('prefix-truncated CLOUD_CONCURRENCY ("3oops"): claude keeps its own tier-derived concurrency (2), distinct from chatgpt',
      prefixStatus.concurrency?.claude === 2 && prefixStatus.concurrency?.claude !== prefixStatus.concurrency?.chatgpt,
      JSON.stringify(prefixStatus.concurrency));
    await prefixClient.close();
    rmSync(prefixDir, { recursive: true, force: true });

    // Boot-race regression (round 5): setup_council concluding zero members
    // (e.g. every tier free, no local Ollama reachable) must not be
    // overwritten by a slower background initCouncil() detection landing
    // afterward — both must agree the council was explicitly, intentionally
    // configured, even to empty.
    const raceDir = mkdtempSync(join(tmpdir(), 'mc-e2e-race-'));
    const raceTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: 'http://127.0.0.1:1', CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: join(raceDir, 'state.json') },
    });
    const raceClient = new Client({ name: 'race-e2e', version: '1.0.0' }, { capabilities: {} });
    await raceClient.connect(raceTransport);
    // Call setup_council with every tier at 'free' immediately on connect —
    // racing against initCouncil()'s own background detection, which (given
    // an unreachable Ollama address above) will also conclude zero members,
    // but on the BOOT-time tiers snapshot rather than this explicit call.
    const raceSetup = parseToolResult(await raceClient.callTool({
      name: 'setup_council', arguments: { chatgpt: 'free', claude: 'free', grok: 'free', ollama: 'free' },
    }));
    check('boot-race: setup_council with all-free tiers concludes zero members', (raceSetup.council?.members ?? []).length === 0, JSON.stringify(raceSetup.council));
    // Give the background initCouncil() detection plenty of time to land, if
    // it hasn't already — then confirm it did NOT silently repopulate the
    // council behind setup_council's back.
    await new Promise(r => setTimeout(r, 3000));
    const raceAfter = parseToolResult(await raceClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('boot-race: a slower background initCouncil() does not clobber the explicit zero-member setup_council result',
      (raceAfter.council?.members ?? []).length === 0, JSON.stringify(raceAfter.council));
    await raceClient.close();
    rmSync(raceDir, { recursive: true, force: true });

    // Settings-only configure_council regression (round 7): a call that only
    // changes response_mode (no `models` field — no membership intent at
    // all) must NOT set explicitlyConfigured and must NOT block a racing
    // background initCouncil() from auto-populating a fresh install — that
    // flag exists to protect an explicit MEMBERSHIP decision, not any
    // settings tweak.
    const settingsOnlyDir = mkdtempSync(join(tmpdir(), 'mc-e2e-settingsonly-'));
    const settingsOnlyTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: join(settingsOnlyDir, 'state.json') },
    });
    const settingsOnlyClient = new Client({ name: 'settingsonly-e2e', version: '1.0.0' }, { capabilities: {} });
    await settingsOnlyClient.connect(settingsOnlyTransport);
    // Call immediately on connect, racing against boot's background
    // initCouncil() detection — settings-only, no `models` field.
    await settingsOnlyClient.callTool({ name: 'configure_council', arguments: { response_mode: 'deconflicted' } });
    // Give initCouncil()'s background detection plenty of time to land.
    await new Promise(r => setTimeout(r, 3000));
    const settingsOnlyAfter = parseToolResult(await settingsOnlyClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('settings-only configure_council: response_mode change applied', settingsOnlyAfter.council?.responseMode === 'deconflicted', JSON.stringify(settingsOnlyAfter.council));
    // get_council_config's OWN live "auto (Ollama-only)" fallback would show
    // a non-empty member list even if initCouncil() were WRONGLY blocked —
    // that fallback runs independently of whatever initCouncil() did. Check
    // specifically for claude-cli/codex-cli members, which only
    // initCouncil()'s real detectEnvironment()+autoPopulatedMembers() path
    // adds, to actually prove auto-population wasn't blocked.
    check('settings-only configure_council: does NOT block background auto-population (claude-cli/codex-cli members present, not just Ollama)',
      (settingsOnlyAfter.council?.members ?? []).some(l => l.startsWith('claude-cli:')) &&
      (settingsOnlyAfter.council?.members ?? []).some(l => l.startsWith('codex-cli:')),
      JSON.stringify(settingsOnlyAfter.council?.members));
    await settingsOnlyClient.close();
    rmSync(settingsOnlyDir, { recursive: true, force: true });

    // Persisted-judge validation regression (round 8): a hand-edited/legacy
    // state.json with a garbage `judgeModelId.provider` must be rejected by
    // persistedConfigOverrides(), same as parseModelId rejects it for the
    // tool-input path — otherwise it's accepted here, then fails
    // registry.resolve() at ask time with no clear signal, silently
    // degrading every categorized/deconflicted/pooled/dialectic call to
    // individual mode.
    const badJudgeDir = mkdtempSync(join(tmpdir(), 'mc-e2e-badjudge-'));
    const badJudgeStateFile = join(badJudgeDir, 'state.json');
    writeFileSync(badJudgeStateFile, JSON.stringify({ version: 1, judgeModelId: { provider: 'not-a-real-provider', model: 'x' } }));
    const badJudgeTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: badJudgeStateFile },
    });
    const badJudgeClient = new Client({ name: 'badjudge-e2e', version: '1.0.0' }, { capabilities: {} });
    await badJudgeClient.connect(badJudgeTransport);
    const badJudgeCfg = parseToolResult(await badJudgeClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('persisted judge with an unknown provider is rejected, not silently accepted',
      /auto/i.test(badJudgeCfg.council?.judgeModel ?? ''), JSON.stringify(badJudgeCfg.council));
    await badJudgeClient.close();
    rmSync(badJudgeDir, { recursive: true, force: true });

    // ── web_access routing: who could actually research ───────────────────
    // A bare `ollama:*` member cannot search on its own, but the claude-CLI
    // harness drives any Anthropic-Messages endpoint and Ollama serves one —
    // so it is re-pointed for the call rather than silently answering from
    // memory alongside members that did research.
    const wrDir = mkdtempSync(join(tmpdir(), 'mc-e2e-webroute-'));
    const wrTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: join(wrDir, 'state.json') },
    });
    const wrClient = new Client({ name: 'webroute-e2e', version: '1.0.0' }, { capabilities: {} });
    await wrClient.connect(wrTransport);
    await wrClient.callTool({ name: 'configure_council', arguments: {
      models: ['ollama:small-a'], response_mode: 'individual',
    }});
    const wr = parseToolResult(await wrClient.callTool({
      name: 'ask_council', arguments: { question: 'hi', mode: 'individual', web_access: true },
    }));
    check('web_access: a bare ollama member is re-pointed through the claude-CLI harness so it CAN research',
      (wr.webRouting?.routedViaHarness ?? []).some(x => /ollama:small-a → claude-cli\/claude-cli-ollama:small-a/.test(x)),
      JSON.stringify(wr.webRouting));
    check('web_access: the re-pointed member is counted as researched, not as answering from memory',
      wr.webRouting?.researched?.includes('claude-cli/claude-cli-ollama:small-a') &&
        wr.webRouting?.fromMemory?.length === 0,
      JSON.stringify(wr.webRouting));
    // ── capability memory: probed once, then reused ───────────────────────
    // The probe writes what it MEASURED to state.json, keyed like
    // visionCapability, so the cost is paid once per model rather than per ask
    // — and it survives restarts and plugin updates because state.json lives
    // outside the plugin directory.
    const wrState = JSON.parse(readFileSync(join(wrDir, 'state.json'), 'utf8'));
    const capEntry = (wrState.harnessCapability ?? {})['ollama:small-a'];
    check('probe: a measured capability is persisted for the member it probed',
      !!capEntry && typeof capEntry.checkedAt === 'number',
      JSON.stringify(wrState.harnessCapability));
    check('probe: it records the harness AND tool-calling separately (they fail independently)',
      !!capEntry && typeof capEntry.harness === 'string' &&
        ['ok', 'leaks', 'unsupported', 'untested'].includes(capEntry.tools),
      JSON.stringify(capEntry));
    // Re-asking must NOT re-probe: a stable checkedAt is the evidence.
    const firstCheckedAt = capEntry?.checkedAt;
    await wrClient.callTool({
      name: 'ask_council', arguments: { question: 'again', mode: 'individual', web_access: true },
    });
    const wrState2 = JSON.parse(readFileSync(join(wrDir, 'state.json'), 'utf8'));
    check('probe: a remembered member is not re-probed on the next ask',
      (wrState2.harnessCapability ?? {})['ollama:small-a']?.checkedAt === firstCheckedAt,
      `${firstCheckedAt} → ${(wrState2.harnessCapability ?? {})['ollama:small-a']?.checkedAt}`);

    // The persisted default must also apply, and a per-call false must win.
    await wrClient.callTool({ name: 'configure_council', arguments: { web_access: true } });
    const wrCfg = parseToolResult(await wrClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('web_access: configure_council default is reported', wrCfg.council?.webAccess === true,
      JSON.stringify(wrCfg.council?.webAccess));
    const wrOff = parseToolResult(await wrClient.callTool({
      name: 'ask_council', arguments: { question: 'hi', mode: 'individual', web_access: false },
    }));
    check('web_access: an explicit false turns OFF a configured default (not just "unset")',
      wrOff.webRouting === undefined, JSON.stringify(wrOff.webRouting));
    await wrClient.close();
    rmSync(wrDir, { recursive: true, force: true });

    // ── first-run effort seed: new installs only ───────────────────────────
    // `high` is seeded ONLY when no state file existed. An install that has
    // been used before but never set an effort must keep running at each
    // model's own default — an update that silently made every council think
    // harder would change answers, latency, and quota burn with no signal.
    const upgDir = mkdtempSync(join(tmpdir(), 'mc-e2e-upgrade-'));
    const upgStateFile = join(upgDir, 'state.json');
    // An existing install: has state (tiers/mode), but no reasoningEffort key.
    writeFileSync(upgStateFile, JSON.stringify({ version: 1, responseMode: 'individual', tiers: { claude: 'pro' } }));
    const upgTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: upgStateFile },
    });
    const upgClient = new Client({ name: 'upgrade-e2e', version: '1.0.0' }, { capabilities: {} });
    await upgClient.connect(upgTransport);
    const upgCfg = parseToolResult(await upgClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('first-run effort seed does NOT apply to an existing install that never set one',
      upgCfg.council?.reasoningEffort === null && upgCfg.runtime?.reasoningEffort === null,
      JSON.stringify({ c: upgCfg.council?.reasoningEffort, r: upgCfg.runtime?.reasoningEffort }));
    check('first-run effort seed does not write reasoningEffort into an existing state file',
      JSON.parse(readFileSync(upgStateFile, 'utf8')).reasoningEffort === undefined,
      readFileSync(upgStateFile, 'utf8').slice(0, 200));
    await upgClient.close();
    rmSync(upgDir, { recursive: true, force: true });

    // A FRESH install (no state file at all) does seed it — and persists it, so
    // it behaves like any other configured setting from then on.
    const freshDir = mkdtempSync(join(tmpdir(), 'mc-e2e-fresh-'));
    const freshStateFile = join(freshDir, 'state.json'); // deliberately NOT created
    const freshTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: freshStateFile },
    });
    const freshClient = new Client({ name: 'fresh-e2e', version: '1.0.0' }, { capabilities: {} });
    await freshClient.connect(freshTransport);
    const freshCfg = parseToolResult(await freshClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('a first run seeds reasoningEffort=high',
      freshCfg.council?.reasoningEffort === 'high' && freshCfg.runtime?.reasoningEffort === 'high',
      JSON.stringify({ c: freshCfg.council?.reasoningEffort, r: freshCfg.runtime?.reasoningEffort }));
    check('the seeded effort is persisted, so it survives as a normal setting',
      JSON.parse(readFileSync(freshStateFile, 'utf8')).reasoningEffort === 'high',
      readFileSync(freshStateFile, 'utf8').slice(0, 200));
    // ...and the user still owns it: changing it must stick, not be re-seeded.
    await freshClient.callTool({ name: 'configure_council', arguments: { reasoning_effort: 'auto' } });
    check('clearing the seeded default with "auto" is respected, not re-seeded',
      JSON.parse(readFileSync(freshStateFile, 'utf8')).reasoningEffort === undefined,
      readFileSync(freshStateFile, 'utf8').slice(0, 200));
    await freshClient.close();
    rmSync(freshDir, { recursive: true, force: true });

    // An explicit REASONING_EFFORT outranks the seed even on a first run.
    const envDir = mkdtempSync(join(tmpdir(), 'mc-e2e-effortenv-'));
    const envTransport = new StdioClientTransport({
      command: 'node', args: [serverEntry],
      env: { ...process.env, GROK_CLI_UNSAFE_ACCEPT_RCE: 'true', OLLAMA_ADDRESS: MOCK_URL, CLAUDE_CLI_PATH: MOCK_CLAUDE, CODEX_CLI_PATH: MOCK_CODEX, GROK_CLI_PATH: MOCK_GROK, MODEL_COUNCIL_STATE: join(envDir, 'state.json'), REASONING_EFFORT: 'low' },
    });
    const envClient = new Client({ name: 'effortenv-e2e', version: '1.0.0' }, { capabilities: {} });
    await envClient.connect(envTransport);
    const envCfg = parseToolResult(await envClient.callTool({ name: 'get_council_config', arguments: {} }));
    check('an explicit REASONING_EFFORT outranks the first-run seed',
      envCfg.runtime?.reasoningEffort === 'low', JSON.stringify(envCfg.runtime?.reasoningEffort));
    await envClient.close();
    rmSync(envDir, { recursive: true, force: true });
  } finally {
    try { await detectClient.close(); } catch { /* already closed */ }
    try { if (rebootClient) await rebootClient.close(); } catch { /* noop */ }
    try { if (loggedOutClient) await loggedOutClient.close(); } catch { /* noop */ }
    try { if (claudeFreeClient) await claudeFreeClient.close(); } catch { /* noop */ }
    try { if (tierFallbackClient) await tierFallbackClient.close(); } catch { /* noop */ }
    rmSync(stateDir, { recursive: true, force: true });
    if (loDir) rmSync(loDir, { recursive: true, force: true });
    if (cfDir) rmSync(cfDir, { recursive: true, force: true });
    if (tfDir) rmSync(tfDir, { recursive: true, force: true });
  }

  mock.kill();

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
