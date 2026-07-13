/**
 * Static validation of the plugin manifest, .mcp.json, and marketplace.json.
 * Mirrors the checks `claude plugin validate` performs, plus a cross-check that
 * every ${user_config.KEY} used in .mcp.json is declared in plugin.json.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let errors = 0;
let warnings = 0;
const ok = m => console.log(`  ✅ ${m}`);
const err = m => { errors++; console.log(`  ❌ ${m}`); };
const warn = m => { warnings++; console.log(`  ⚠️  ${m}`); };

function readJson(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ── plugin.json ────────────────────────────────────────────────────────────
console.log('\n▶ .claude-plugin/plugin.json');
const plugin = readJson('.claude-plugin/plugin.json');
if (!plugin) { err('plugin.json missing or unparseable'); }
else {
  plugin.name ? ok(`name: ${plugin.name}`) : err('missing name');
  /^[a-z0-9-]+$/.test(plugin.name ?? '') ? ok('name is kebab-case') : err('name must be kebab-case');
  plugin.description ? ok('has description') : err('missing description');
  plugin.version ? ok(`version: ${plugin.version}`) : warn('no version (git SHA will be used)');
  plugin.license ? ok(`license: ${plugin.license}`) : warn('no license');

  const validTypes = ['string', 'number', 'boolean', 'directory', 'file'];
  const uc = plugin.userConfig ?? {};
  const ucKeys = Object.keys(uc);
  ok(`userConfig options: ${ucKeys.length}`);
  for (const [k, opt] of Object.entries(uc)) {
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || err(`userConfig key not a valid identifier: ${k}`);
    validTypes.includes(opt.type) || err(`userConfig ${k}: bad type "${opt.type}"`);
    opt.title || err(`userConfig ${k}: missing title`);
    opt.description || err(`userConfig ${k}: missing description`);
    if (opt.type === 'number' && opt.default !== undefined) {
      (typeof opt.default === 'number') || err(`userConfig ${k}: default must be number`);
      if (opt.min !== undefined && opt.default < opt.min) err(`userConfig ${k}: default < min`);
      if (opt.max !== undefined && opt.default > opt.max) err(`userConfig ${k}: default > max`);
    }
  }
}

// ── .mcp.json ────────────────────────────────────────────────────────────────
console.log('\n▶ .mcp.json');
const mcp = readJson('.mcp.json');
if (!mcp) { err('.mcp.json missing or unparseable'); }
else {
  const servers = mcp.mcpServers ?? {};
  const names = Object.keys(servers);
  names.length ? ok(`declares server(s): ${names.join(', ')}`) : err('no mcpServers');

  const raw = readFileSync(join(root, '.mcp.json'), 'utf8');

  // CLAUDE_PLUGIN_ROOT usage
  raw.includes('${CLAUDE_PLUGIN_ROOT}')
    ? ok('uses ${CLAUDE_PLUGIN_ROOT}')
    : err('server path should use ${CLAUDE_PLUGIN_ROOT}');

  // bundle exists
  const bundlePath = join(root, 'bundle/server.cjs');
  existsSync(bundlePath) ? ok('bundle/server.cjs exists') : err('bundle/server.cjs missing — run npm run bundle');

  // Cross-check: every ${user_config.KEY} maps to a declared userConfig key
  const used = [...raw.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]);
  const declared = new Set(Object.keys(plugin?.userConfig ?? {}));
  const uniqueUsed = [...new Set(used)];
  ok(`references ${uniqueUsed.length} user_config keys`);
  for (const key of uniqueUsed) {
    declared.has(key)
      ? null
      : err('.mcp.json references ${user_config.' + key + '} but plugin.json has no such userConfig key');
  }
  // Reverse: declared but unused (warning only)
  for (const key of declared) {
    uniqueUsed.includes(key) || warn(`userConfig "${key}" declared but not used in .mcp.json`);
  }
  if (uniqueUsed.every(k => declared.has(k))) ok('all user_config references resolve');
}

// ── marketplace.json ─────────────────────────────────────────────────────────
console.log('\n▶ .claude-plugin/marketplace.json');
const mkt = readJson('.claude-plugin/marketplace.json');
if (!mkt) { err('marketplace.json missing or unparseable'); }
else {
  mkt.name ? ok(`marketplace name: ${mkt.name}`) : err('missing name');
  mkt.owner?.name ? ok(`owner: ${mkt.owner.name}`) : err('missing owner.name');
  Array.isArray(mkt.plugins) && mkt.plugins.length ? ok(`lists ${mkt.plugins.length} plugin(s)`) : err('no plugins listed');
  for (const p of mkt.plugins ?? []) {
    p.name || err('plugin entry missing name');
    p.source || err(`plugin ${p.name}: missing source`);
    // If source is "./", the plugin.json must exist at root
    if (p.source === './') {
      existsSync(join(root, '.claude-plugin/plugin.json'))
        ? ok(`source "./" resolves to plugin.json`)
        : err('source "./" but no .claude-plugin/plugin.json at root');
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Validation: ${errors} errors, ${warnings} warnings`);
process.exit(errors > 0 ? 1 : 0);
