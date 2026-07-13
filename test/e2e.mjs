/**
 * End-to-end test: spawn the built MCP server over stdio (pointed at the mock
 * backend) and drive all 4 tools + 3 response modes via the MCP protocol.
 */
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MOCK_PORT = 11499;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;

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

  } finally {
    await client.close();
    mock.kill();
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
