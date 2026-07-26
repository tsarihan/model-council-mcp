#!/usr/bin/env node
/**
 * model-council-mcp — MCP server
 *
 * Tools exposed:
 *   list_models        — discover available models across all configured providers
 *   configure_council  — set council members, judge, mode, and deconflict rounds
 *   ask_council        — query the council (individual | categorized | deconflicted | pooled | dialectic)
 *   ask_council_async  — start a council run in the background, return a job_id
 *   get_council_result — fetch / list background council runs
 *   get_council_config — inspect current council configuration
 *   council_status     — detected environment, members, tiers, quota
 *   setup_council      — set subscription tiers + auto-populate
 *
 * ask_council / ask_council_async also accept `context` (inline text), `files`
 * (local paths), and `git_ref` (auto-attaches a local `git diff` — see
 * src/git.ts) to attach as labelled context for every member; `full_repo_access`
 * (WARNING: read-only repo-wide browse access for claude-cli/codex-cli members
 * only — see CompletionOptions.fullRepoAccess in providers/base.ts); and
 * `images` (local image paths) which are routed only to council members
 * auto-detected as vision-capable (see src/images.ts, providers/*.supportsVision).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { KNOWN_PROVIDERS, loadConfig, modelIdLabel, parseModelId, redactUrlUserinfo } from './config.js';
import { ProviderRegistry } from './providers/registry.js';
import { CouncilOrchestrator } from './council/orchestrator.js';
import { ProgressReporter } from './council/query.js';
import { CouncilConfig, CouncilMember, ModelId, ResponseMode, SubscriptionTiers } from './types.js';
import { CouncilState, loadState, saveState } from './state.js';
import { loadSubscriptions, validTiers, tierAllowsCloud, SubProvider } from './subscriptions.js';
import { detectEnvironment, autoPopulatedMembers, quotaWarning } from './detect.js';
import { buildAugmentedQuestion } from './context.js';
import { assertGitRepo } from './git.js';
import { loadImages } from './images.js';
import { JobStore } from './jobs.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The server version, read from package.json at load so the MCP `version` never
// drifts from the shipped package (a hardcoded string went stale across releases
// — 0.2.47 while the package was already 0.2.49). package.json sits one level up
// from both dist/index.js and bundle/server.cjs. Resolved two ways so it works
// in BOTH builds: (1) via import.meta.url — correct in the native-ESM dist and
// symlink-proof for a global `bin` install; esbuild stubs import.meta to {} in
// the CJS bundle, so `new URL(..., undefined)` throws there and is skipped;
// (2) relative to the running entry script (process.argv[1]) — covers the CJS
// bundle, which is never itself a symlinked bin. Falls back to 0.0.0 only if a
// stripped deployment has neither.
const MC_VERSION: string = (() => {
  const readV = (p: string | URL): string | null => {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version;
      return typeof v === 'string' ? v : null;
    } catch { return null; }
  };
  try {
    const v = readV(new URL('../package.json', import.meta.url));
    if (v) return v;
  } catch { /* CJS bundle: import.meta.url is undefined → fall through */ }
  if (process.argv[1]) {
    const v = readV(join(dirname(process.argv[1]), '..', 'package.json'));
    if (v) return v;
  }
  return '0.0.0';
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Boot runs at top-level module evaluation, BEFORE main().catch() is installed,
// so a throw here would be an uncaught module-eval error (process exits with an
// opaque stack and no tools are served). Wrap it to fail with a clear stderr line.
function boot() {
  const appConfig = loadConfig();
  const registry = new ProviderRegistry(appConfig.servers);
  const orchestrator = new CouncilOrchestrator(registry, appConfig.council, appConfig.runtime);
  return { appConfig, registry, orchestrator };
}
let booted: ReturnType<typeof boot>;
try {
  booted = boot();
} catch (err) {
  process.stderr.write(`Fatal during model-council boot: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
const { appConfig, registry, orchestrator } = booted;
for (const w of appConfig.warnings) {
  process.stderr.write(`[model-council] warning: ${w}\n`);
}
const jobs = new JobStore();

// Set the instant EITHER configure_council or setup_council completes, even
// if the result is zero members — this closes a race with the background
// initCouncil() below. Without it: setup_council can legitimately conclude
// zero members (e.g. every tier set to free, no local Ollama), which per its
// own "don't persist an empty auto-populated list" fix leaves
// orchestrator.getConfig().members at length 0 AND state.json's `members`
// still absent — exactly the shape initCouncil()'s guards read as "not yet
// configured." If its own (slower, boot-snapshot-tiers-based) detection is
// still in flight at that moment, it would then clobber the user's
// just-completed, intentionally-empty setup_council result with its own,
// possibly stale, non-empty one.
let explicitlyConfigured = false;

// Persist resolved Ollama address / CLI paths so the SessionStart hook can read
// them — the plugin host doesn't propagate userConfig env to hook processes.
try {
  saveState({
    env: {
      ollamaAddress: appConfig.servers.find(s => s.type === 'ollama')?.baseUrl,
      claudeCliPath: appConfig.servers.find(s => s.type === 'claude-cli')?.command,
      codexCliPath: appConfig.servers.find(s => s.type === 'codex-cli')?.command,
      grokCliPath: appConfig.servers.find(s => s.type === 'grok-cli')?.command,
    },
  });
} catch {
  /* best-effort — a read-only state dir must not break boot */
}

/** Compose context/files into the prompt and load any attached images, then run
 *  the council. Shared by the synchronous ask_council and the background
 *  ask_council_async — `onProgress` only makes sense for the synchronous path
 *  (a caller is actually waiting), so callers pass it explicitly. */
async function runCouncil(
  input: {
    question: string;
    mode?: string;
    max_deconflict_rounds?: number;
    verbose?: boolean;
    context?: string;
    files?: string[];
    images?: string[];
    git_ref?: string;
    git_repo?: string;
    full_repo_access?: boolean;
  },
  onProgress?: ProgressReporter,
) {
  const question = await buildAugmentedQuestion(input.question, {
    context: input.context,
    files: input.files,
    gitRef: input.git_ref,
    gitRepo: input.git_repo,
  });
  const images = await loadImages(input.images);
  // Reuses git_repo as the granted root when both are set, so a git_ref review
  // and full_repo_access point at the same repo by default. Validated with the
  // same assertGitRepo() git_ref already gets — without this, any resolvable
  // path ("/", a home directory, a typo) would be accepted as a "repo root"
  // and granted to claude-cli/codex-cli (a real permission-review finding).
  let fullRepoAccessRepo: string | undefined;
  if (input.full_repo_access) {
    // Use assertGitRepo's returned REALPATH, not our own resolve() of the
    // input, as the value granted onward to claude-cli/codex-cli's
    // --add-dir. Passing the pre-realpath path would leave a TOCTOU window: a
    // symlink in the path could be retargeted after validation but before the
    // CLI invocation, granting access to a directory that was never checked.
    fullRepoAccessRepo = await assertGitRepo(input.git_repo?.trim() || process.cwd());
  }
  return orchestrator.ask(
    question,
    input.mode as ResponseMode | undefined,
    input.max_deconflict_rounds,
    input.verbose,
    images.length ? images : undefined,
    onProgress,
    fullRepoAccessRepo,
    // The ORIGINAL question drives every JUDGE prompt — `question` above may
    // embed untrusted context/files/git-diff content that the judge must not
    // receive in a trust-affirming position (see orchestrator.ask).
    input.question,
  );
}

const labelsToMembers = (labels: unknown[]): CouncilMember[] =>
  labels.flatMap(s => {
    if (typeof s !== 'string') return []; // tolerate a hand-corrupted state.json
    const id = parseModelId(s);
    return id ? [{ modelId: id }] : [];
  });

/**
 * Tiers actually in effect: boot tiers overlaid by persisted state, each
 * re-validated against subscriptions.json (so a tier a pulled config no longer
 * defines falls back to the boot-sanitised value rather than being resurrected).
 */
function effectiveTiers(subs = loadSubscriptions()): SubscriptionTiers {
  const stateTiers = loadState().tiers ?? {};
  const guard = (p: SubProvider): string => {
    const valid = validTiers(p, subs);
    // stateTiers[p] present-but-INVALID (hand-edited state.json, or a value
    // persisted before subscriptions.json dropped/renamed that tier) must
    // still fall through to the boot-sanitised value next, not skip straight
    // to the least-privileged tier — `??` only catches an ABSENT state
    // value, not a present-but-wrong one, so this has to be checked
    // explicitly rather than folded into the `v = stateTiers[p] ??
    // appConfig.tiers[p]` chain.
    const stateVal = stateTiers[p];
    if (stateVal !== undefined && valid.includes(stateVal)) return stateVal;
    if (valid.includes(appConfig.tiers[p])) return appConfig.tiers[p];
    // Even the boot-sanitised value is no longer valid (subscriptions.json
    // was pulled and dropped it) — fall back one step further, to the
    // provider's first (least-privileged / cloud-denying, "free") tier —
    // subscriptions.json always lists "free" first for every provider — so
    // this never returns a value validTiers() itself doesn't recognize.
    return valid[0] ?? appConfig.tiers[p];
  };
  return { chatgpt: guard('chatgpt'), claude: guard('claude'), grok: guard('grok'), ollama: guard('ollama') };
}

const RESPONSE_MODES = new Set<string>(['individual', 'categorized', 'deconflicted', 'pooled', 'dialectic']);

/**
 * Build a CouncilConfig patch from whatever configure_council settings were
 * persisted to state.json, lightly validated (the file is server-owned but
 * could be hand-edited or left over from an older version). Independent of
 * `members` — applied regardless of whether the council's membership came
 * from COUNCIL_MODELS, persisted state, or auto-population, since a judge/
 * mode/rounds choice is orthogonal to who's actually on the council.
 */
function persistedConfigOverrides(persisted: CouncilState): Partial<CouncilConfig> {
  const update: Partial<CouncilConfig> = {};
  if (persisted.responseMode && RESPONSE_MODES.has(persisted.responseMode)) {
    update.responseMode = persisted.responseMode;
  }
  const rounds = persisted.maxDeconflictRounds;
  if (typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 1 && rounds <= 10) {
    update.maxDeconflictRounds = rounds;
  }
  const judge = persisted.judgeModelId;
  // Also check `provider` is a KNOWN provider type, matching parseModelId's
  // own validation for the tool-input path — a hand-edited or legacy
  // state.json with a garbage/renamed provider string would otherwise pass
  // this check, then fail registry.resolve() at ask time with no clear
  // signal, silently degrading every categorized/deconflicted/pooled/
  // dialectic request to individual mode (round 3's degrade-safely fix means
  // this never crashes, but the persisted judge was held to a weaker
  // validation standard than one supplied directly through configure_council).
  if (judge && typeof judge.provider === 'string' && KNOWN_PROVIDERS.has(judge.provider) && typeof judge.model === 'string') {
    update.judgeModelId = judge;
  }
  if (typeof persisted.autoCouncil === 'boolean') {
    update.autoCouncil = persisted.autoCouncil;
  }
  return update;
}

/**
 * On boot: honour a persisted council (survives reloads), or — on a fresh
 * install — detect the environment and auto-populate the council with
 * everything usable ("everything on"). Runs in the background; never blocks the
 * server, and falls back to zero-config Ollama auto-discovery on any failure.
 */
async function initCouncil(): Promise<void> {
  const persisted = loadState();
  // Independent of the members guard below — see persistedConfigOverrides().
  const settingsUpdate = persistedConfigOverrides(persisted);
  if (Object.keys(settingsUpdate).length > 0) {
    orchestrator.updateConfig(settingsUpdate);
  }
  // Explicit COUNCIL_MODELS (or a prior configure_council/setup_council call
  // in this process, even one that resulted in zero members) wins — don't
  // override an already-configured council with persisted/auto state.
  if (orchestrator.getConfig().members.length > 0 || explicitlyConfigured) return;
  if (Array.isArray(persisted.members)) {
    orchestrator.updateConfig({ members: labelsToMembers(persisted.members) });
    return;
  }
  try {
    const subs = loadSubscriptions();
    const report = await detectEnvironment(registry, appConfig.tiers, subs);
    // Detection is slow (subprocess probes); an explicit configure_council or
    // setup_council may have landed while we awaited — it MUST win. Re-check
    // all three guards before clobbering.
    if (orchestrator.getConfig().members.length > 0 || explicitlyConfigured) return;
    if (Array.isArray(loadState().members)) return;
    const labels = autoPopulatedMembers(report, appConfig.tiers, subs);
    if (labels.length) {
      orchestrator.updateConfig({ members: labelsToMembers(labels) });
      // Persist only members here — never overwrite the user's tier choices.
      saveState({ members: labels, welcomedVersion: subs.version });
    }
  } catch {
    /* detection failed → keep zero-config Ollama auto-discovery */
  }
}

// ─── Tool schemas (zod) ───────────────────────────────────────────────────────

const ListModelsInput = z.object({
  filter_provider: z
    .string()
    .optional()
    .describe(
      'Optional provider to filter by (ollama, openai, anthropic, xai, vllm, trtllm, sglang, claude-cli, codex-cli, grok-cli)',
    ),
});

const ConfigureCouncilInput = z.object({
  models: z
    .array(z.string())
    .max(100, 'At most 100 council members are supported per call.')
    .optional()
    .describe(
      'Model IDs for council members. Format: "provider:model" or ' +
        '"provider/serverId:model". Examples: "ollama:llama3", ' +
        '"vllm/vllm-gpu1:meta-llama/Llama-3-8B", "openai:gpt-4o". Max 100.',
    ),
  judge_model: z
    .string()
    .optional()
    .describe(
      'Model to act as judge for categorisation/deconfliction. ' +
        'Same format as models. Omit, or pass "auto", to auto-select (picks largest council member). ' +
        'Any other unparseable value is rejected with an error rather than silently falling back to auto.',
    ),
  response_mode: z
    .enum(['individual', 'categorized', 'deconflicted', 'pooled', 'dialectic'])
    .optional()
    .describe(
      'individual → each model responds independently. ' +
        'categorized → judge groups into agreement/complementary/conflicting. ' +
        'deconflicted → iterative loop until conflicts resolve or max_rounds reached. ' +
        'pooled → Delphi-style: members reconsider against a neutral, attribution-free pool of answers. ' +
        'dialectic → thesis/antithesis/synthesis: members defend their pick, judge builds pros/cons, members re-select.',
    ),
  max_deconflict_rounds: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum deconfliction rounds (1–10, default 3).'),
  auto_council: z
    .boolean()
    .optional()
    .describe(
      'When true (default) and no models are set, the council is auto-populated ' +
        'from all available Ollama chat models (local + :cloud).',
    ),
});

const AskCouncilInput = z.object({
  question: z.string().describe('The question or prompt to send to the council.'),
  mode: z
    .enum(['individual', 'categorized', 'deconflicted', 'pooled', 'dialectic'])
    .optional()
    .describe('Override the default response mode for this call only.'),
  max_deconflict_rounds: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Override max deconfliction rounds for this call only.'),
  verbose: z
    .boolean()
    .optional()
    .describe(
      'deconflicted → include the initial categorization and per-round detail; ' +
        'pooled/dialectic → include the initial (round-0/thesis) raw member responses.',
    ),
  context: z
    .string()
    .optional()
    .describe('Optional background text prepended to the question for every member.'),
  files: z
    .array(z.string())
    .optional()
    .describe(
      'Optional local file paths to read and attach as context (each fenced and ' +
        'labelled). Caps: 256 KB/file, 768 KB total, 20 files. Text files only — ' +
        'use "images" for pictures.',
    ),
  git_ref: z
    .string()
    .optional()
    .describe(
      'Auto-attach a local `git diff` as context — for repo reviews, instead of hand-listing ' +
        'every changed file via "files". One of "uncommitted" (staged + unstaged vs HEAD), ' +
        '"staged", "unstaged", or any git revision/range (e.g. "main..HEAD", "HEAD~3..HEAD"). ' +
        'Errors clearly if the ref/repo is invalid, there are no changes, or the diff is too ' +
        'large (> 512 KB — narrow the range or use "files" instead).',
    ),
  git_repo: z
    .string()
    .optional()
    .describe('Repo directory to run git_ref in. Defaults to the server\'s working directory.'),
  full_repo_access: z
    .boolean()
    .optional()
    .describe(
      'WARNING: grants claude-cli/codex-cli council members repo exploration for a repo-wide ' +
        'review, instead of their normal fully locked-down mode — enforced DIFFERENTLY per ' +
        'provider. claude-cli gets Read/Grep/Glob CONFINED to the repo root (--add-dir is a real ' +
        'enforced boundary). codex-cli points its cwd at the real repo but its read-only sandbox ' +
        'does NOT confine reads to it — it can read any file the OS user can read, anywhere on ' +
        'the machine (this is pre-existing codex-cli behavior, not added by this flag; writes ' +
        'stay blocked everywhere). Defaults to false; never set true without the user\'s consent ' +
        'for an interactive call (safe to set autonomously for an unattended review step you ' +
        'already control, e.g. an end-of-workflow review). Other council members ' +
        '(openai/anthropic/xai/ollama/self-hosted, and grok-cli) are unaffected — they have no ' +
        'filesystem access to grant. Repo root is git_repo if set, else the server\'s working ' +
        'directory.',
    ),
  images: z
    .array(z.string())
    .optional()
    .describe(
      'Optional local image paths (png/jpg/jpeg/gif/webp). Auto-detected ' +
        'vision-capable council members are queried with the image(s); members ' +
        'without vision support are automatically skipped for this call (see ' +
        'visionRouting in the result). Caps: 8 MB/image, 24 MB total, 6 images.',
    ),
});

// Async variant takes the same inputs as ask_council.
const AskCouncilAsyncInput = AskCouncilInput;

const GetCouncilResultInput = z.object({
  job_id: z
    .string()
    .optional()
    .describe('Job id returned by ask_council_async. Omit (or set list=true) to list recent jobs.'),
  list: z
    .boolean()
    .optional()
    .describe('List recent background jobs (metadata only) instead of fetching one.'),
});

const GetCouncilConfigInput = z.object({});

const SetupCouncilInput = z.object({
  chatgpt: z.string().optional().describe('ChatGPT tier: free | plus | pro5x | pro20x'),
  claude: z.string().optional().describe('Claude tier: free | pro | max5x | max20x'),
  grok: z.string().optional().describe('Grok (X.AI subscription CLI) tier: free | supergrok | premiumplus | heavy'),
  ollama: z.string().optional().describe('Ollama tier: free | pro | max'),
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_models',
    annotations: { title: 'List models', readOnlyHint: true },
    description:
      'List all AI models available across every configured provider ' +
      '(Ollama, OpenAI, Anthropic, X.AI Grok (API key), vLLM, TRT-LLM, SGLang, plus ' +
      'subscription-CLI providers: Claude, ChatGPT/Codex, Grok). ' +
      'Use the returned model IDs when calling configure_council.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter_provider: {
          type: 'string',
          description:
            'Optional provider filter: ollama | openai | anthropic | xai | vllm | trtllm | sglang | claude-cli | codex-cli | grok-cli',
        },
      },
    },
  },
  {
    name: 'configure_council',
    annotations: { title: 'Configure council', readOnlyHint: false },
    description:
      'Update the council configuration: select which models form the council, ' +
      'choose a judge model, set the response mode (individual / categorized / deconflicted), ' +
      'and set the maximum deconfliction rounds. Each field supplied is persisted and survives ' +
      'restarts/reloads, same as setup_council\'s tier choices; a field left unset is untouched.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        models: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 100,
          description:
            'Council member model IDs. Format: "provider:model" or "provider/serverId:model". ' +
            'Examples: "ollama:llama3", "openai:gpt-4o", "vllm/server1:meta-llama/Llama-3-8B". Max 100.',
        },
        judge_model: {
          type: 'string',
          description:
            'Judge model ID. Same format. Omit, or pass "auto", for auto-select (largest council member). ' +
            'Any other unparseable value is rejected, not silently treated as auto.',
        },
        response_mode: {
          type: 'string',
          enum: ['individual', 'categorized', 'deconflicted', 'pooled', 'dialectic'],
          description:
            'individual: raw responses. categorized: agreement/complementary/conflicting. ' +
            'deconflicted: iterative loop with deconfliction score. ' +
            'pooled: Delphi-style neutral reconsideration (no attribution or ranking shown to members). ' +
            'dialectic: thesis/antithesis/synthesis — defend, build pros/cons, re-select.',
        },
        max_deconflict_rounds: {
          type: 'number',
          description: 'Max deconfliction rounds (1–10, default 3).',
        },
        auto_council: {
          type: 'boolean',
          description:
            'Default true. When true and no models are set, auto-populate the council ' +
            'from all available Ollama chat models (local + :cloud).',
        },
      },
    },
  },
  {
    name: 'ask_council',
    annotations: { title: 'Ask the council', readOnlyHint: false },
    description:
      'Send a question to the model council and get a structured response. ' +
      'Mode: individual (each model answers separately), ' +
      'categorized (judge groups responses into agreement/complementary/conflicting), ' +
      'deconflicted (iterative loop — judge orchestrates re-questioning until conflicts resolve, ' +
      'returns a deconfliction score 0–100%), ' +
      'pooled (Delphi-style — members reconsider against a neutral, deduplicated, attribution-free ' +
      'pool of answers; no winner is forced, so genuine divergence is preserved), or ' +
      'dialectic (thesis/antithesis/synthesis — members defend their pick and critique the rest, ' +
      'the judge compiles a pros/cons dossier per option, then members re-select a ranked top-3). ' +
      'Attach images to ask a vision question — only auto-detected vision-capable members are ' +
      'queried; the rest are skipped and reported in visionRouting. For a repo review, pass ' +
      'git_ref (e.g. "uncommitted", "main..HEAD") instead of hand-listing files — the server ' +
      'runs `git diff` locally and attaches it as context. For a full repo-wide review (not just ' +
      'a diff), full_repo_access (default false, WARNING: read access to the whole repo — see ' +
      'its param description) grants claude-cli/codex-cli members read-only browse/read access.',
    inputSchema: {
      type: 'object' as const,
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          description: 'The question or prompt to send to all council members.',
        },
        mode: {
          type: 'string',
          enum: ['individual', 'categorized', 'deconflicted', 'pooled', 'dialectic'],
          description: 'Response mode override for this call only.',
        },
        max_deconflict_rounds: {
          type: 'number',
          description: 'Max deconfliction rounds override for this call only.',
        },
        verbose: {
          type: 'boolean',
          description:
            'deconflicted → include the initial categorization and per-round detail; ' +
            'pooled/dialectic → include the initial (round-0/thesis) raw member responses.',
        },
        context: {
          type: 'string',
          description: 'Optional background text prepended to the question for every member.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional local file paths to read and attach as labelled context ' +
            '(caps: 256 KB/file, 768 KB total, 20 files). Text only — use "images" for pictures.',
        },
        git_ref: {
          type: 'string',
          description:
            'Auto-attach a local `git diff` as context for a repo review, instead of hand-listing ' +
            'every changed file via "files". One of "uncommitted" (staged+unstaged vs HEAD), ' +
            '"staged", "unstaged", or a git revision/range (e.g. "main..HEAD"). Errors clearly on ' +
            'a bad ref, no changes, or a diff too large to attach (> 512 KB).',
        },
        git_repo: {
          type: 'string',
          description: 'Repo directory to run git_ref in. Defaults to the working directory.',
        },
        full_repo_access: {
          type: 'boolean',
          description:
            'WARNING: grants claude-cli/codex-cli repo exploration for a repo-wide review — ' +
            'ENFORCED DIFFERENTLY per provider. claude-cli: Read/Grep/Glob CONFINED to the repo ' +
            'root (real enforced boundary). codex-cli: cwd points at the repo, but its read-only ' +
            'sandbox does NOT confine reads to it — can read anywhere the OS user can (pre-' +
            'existing behavior, not added by this flag; writes stay blocked everywhere). Defaults ' +
            'false; confirm with the user before setting true for an interactive call (an ' +
            'unattended review step you already control, e.g. end-of-workflow, may set it ' +
            'autonomously). Other members are unaffected. Repo root: git_repo, else cwd.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional local image paths (png/jpg/jpeg/gif/webp). Auto-detected ' +
            'vision-capable council members are queried with the image(s); members without ' +
            'vision support are automatically skipped for this call (see visionRouting in ' +
            'the result). Caps: 8 MB/image, 24 MB total, 6 images.',
        },
      },
    },
  },
  {
    name: 'ask_council_async',
    annotations: { title: 'Ask the council (background)', readOnlyHint: false },
    description:
      'Start a council run in the background and return a job_id immediately, so a ' +
      'long deconfliction/dialectic run (or a slow local model) does not block. Same ' +
      'inputs as ask_council (mode, context, files, etc.). Poll get_council_result ' +
      'with the job_id to fetch the answer when ready. Jobs are in-memory and do not ' +
      'survive a server reload.',
    inputSchema: {
      type: 'object' as const,
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          description: 'The question or prompt to send to all council members.',
        },
        mode: {
          type: 'string',
          enum: ['individual', 'categorized', 'deconflicted', 'pooled', 'dialectic'],
          description: 'Response mode override for this call only.',
        },
        max_deconflict_rounds: {
          type: 'number',
          description: 'Max deconfliction rounds override for this call only.',
        },
        verbose: { type: 'boolean', description: 'Include per-round / raw member detail.' },
        context: {
          type: 'string',
          description: 'Optional background text prepended to the question for every member.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local file paths to read and attach as labelled context.',
        },
        git_ref: {
          type: 'string',
          description: 'Auto-attach a local git diff as context — same behavior as ask_council.',
        },
        git_repo: {
          type: 'string',
          description: 'Repo directory to run git_ref in. Defaults to the working directory.',
        },
        full_repo_access: {
          type: 'boolean',
          description: 'WARNING: grants repo-wide read access to claude-cli/codex-cli members — same behavior as ask_council.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local image paths — same vision-routing behavior as ask_council.',
        },
      },
    },
  },
  {
    name: 'get_council_result',
    annotations: { title: 'Get background council result', readOnlyHint: true },
    description:
      'Fetch a background council run started with ask_council_async. Pass job_id to ' +
      'get its status (running | done | error) and, when done, the full result. Omit ' +
      'job_id (or set list=true) to list recent jobs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: {
          type: 'string',
          description: 'Job id from ask_council_async. Omit to list recent jobs.',
        },
        list: {
          type: 'boolean',
          description: 'List recent jobs (metadata only) instead of fetching one.',
        },
      },
    },
  },
  {
    name: 'get_council_config',
    annotations: { title: 'Get council config', readOnlyHint: true },
    description:
      'Return the current council configuration: member models, judge model, ' +
      'response mode, and max deconfliction rounds.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'council_status',
    annotations: { title: 'Council status', readOnlyHint: true },
    description:
      'Report the detected environment and current setup: local Ollama models, ' +
      'whether Ollama cloud is reachable on this plan, whether the Claude, Codex, and ' +
      'Grok CLIs are installed AND logged in, the current council members, resolved ' +
      'subscription tiers, per-provider concurrency, and a quota warning. Use this ' +
      'as the welcome/status readout — it works in every client and install method.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'setup_council',
    annotations: { title: 'Set up council (tiers + auto-populate)', readOnlyHint: false },
    description:
      'Set subscription tiers, then re-detect and auto-populate the council with ' +
      'everything usable. Tiers gate cloud availability and per-provider concurrency: ' +
      'chatgpt (free|plus|pro5x|pro20x), claude (free|pro|max5x|max20x), grok ' +
      '(free|supergrok|premiumplus|heavy), ollama (free|pro|max). Choices persist ' +
      'across reloads. Note: registering a NEW subscription provider or changing ' +
      'concurrency takes full effect after a reload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatgpt: { type: 'string', enum: ['free', 'plus', 'pro5x', 'pro20x'], description: 'ChatGPT subscription tier.' },
        claude: { type: 'string', enum: ['free', 'pro', 'max5x', 'max20x'], description: 'Claude subscription tier.' },
        grok: { type: 'string', enum: ['free', 'supergrok', 'premiumplus', 'heavy'], description: 'Grok (X.AI subscription CLI) tier.' },
        ollama: { type: 'string', enum: ['free', 'pro', 'max'], description: 'Ollama subscription tier.' },
      },
    },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'model-council-mcp',
    version: MC_VERSION,
  },
  {
    capabilities: { tools: {} },
    instructions:
      'model-council fans a question out to a council of local (Ollama) and ' +
      'subscription models — Claude via the local `claude` CLI, ChatGPT via the ' +
      'local `codex` CLI, and Grok via the local `grok` CLI — and reconciles the ' +
      'answers (individual / categorized / deconflicted / pooled / dialectic). ' +
      'It auto-configures on first use. On a ' +
      'new session or when the user asks about setup, call `council_status` to show ' +
      'detected models, subscription login state, per-provider concurrency, and quota ' +
      'usage; use `setup_council` to pick subscription tiers, `configure_council` to ' +
      'edit members, and `ask_council` to ask. Council members run under the user\'s ' +
      'own subscription quotas.',
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Call tools
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;

  // If the caller requested progress notifications (MCP progressToken), build
  // a reporter that forwards status lines that way. Vision detection now runs
  // strictly one local model at a time (see checkVisionPooled) — correct, but
  // on a machine with several large local models that can take minutes with
  // no other feedback, which reads as a hang. Best-effort: a notification
  // failure must never break the tool call itself.
  //
  // Known client-side limitation (observed against the TS SDK's stdio Client,
  // not something server code can work around): when several notifications
  // for the same token fire in rapid, near-synchronous succession — e.g. every
  // member's vision result is already cached and every check resolves without
  // real I/O — the client's progress-handler bookkeeping can drop all but the
  // first as "unknown token". In practice this self-resolves: that failure
  // mode only shows up exactly when the call is fast enough that progress
  // tracking wasn't needed anyway. When work is genuinely slow (cold model
  // loads, real OCR round trips), the natural I/O gaps between steps keep
  // delivery reliable.
  const progressToken = extra._meta?.progressToken;
  let progressCount = 0;
  const onProgress: ProgressReporter | undefined =
    progressToken === undefined
      ? undefined
      : async message => {
          progressCount++;
          // Awaited so notifications flush over the transport in order, before
          // the next step of the call proceeds — a fire-and-forget send here
          // raced with the final tool response and could arrive out of order
          // or get dropped.
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: progressCount, message },
            });
          } catch {
            /* best-effort — a notification failure must never break the tool call */
          }
        };

  try {
    switch (name) {
      // ── list_models ──────────────────────────────────────────────────────
      case 'list_models': {
        const input = ListModelsInput.parse(args ?? {});
        const models = await orchestrator.listAllModels();
        const filtered = input.filter_provider
          ? models.filter(m => m.provider === input.filter_provider)
          : models;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total: filtered.length,
                  models: filtered.map(m => ({
                    id: modelIdLabel(m),
                    provider: m.provider,
                    server: m.serverId ?? m.provider,
                    model: m.model,
                    label: m.label,
                    paramSize: m.paramSize,
                    family: m.family,
                    contextLength: m.contextLength,
                    diskBytes: m.diskBytes,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ── configure_council ────────────────────────────────────────────────
      case 'configure_council': {
        const input = ConfigureCouncilInput.parse(args ?? {});
        const update: Partial<CouncilConfig> = {};

        // Track IDs we couldn't parse (typo / missing "provider:" prefix) or that
        // parse but have no registered provider, so drops are visible — not silent.
        const rejected: string[] = [];
        const unavailable: string[] = [];
        if (input.models !== undefined) {
          const seen = new Set<string>();
          const members: CouncilMember[] = [];
          for (const s of input.models) {
            const id = parseModelId(s);
            if (!id) {
              rejected.push(s);
              continue;
            }
            const label = modelIdLabel(id);
            if (seen.has(label)) continue; // de-dupe: a member listed twice is queried once
            seen.add(label);
            if (!registry.resolve(id)) unavailable.push(label);
            members.push({ modelId: id });
          }
          // A non-empty `models` list where EVERY entry failed to parse (all
          // typos, e.g. missing "provider:" prefixes) must not silently wipe
          // the council to empty and then persist that empty result — the
          // same failure mode round 3 closed for setup_council's
          // auto-population path, reopened here on configure_council's
          // explicit path. An intentional `models: []` (a real "clear the
          // council" gesture) is unaffected — it never reaches this branch.
          if (input.models.length > 0 && members.length === 0) {
            throw new Error(
              `None of the supplied models parsed: ${rejected.join(', ')}. Expected ` +
                `"provider:model" (e.g. "ollama:llama3", "openai:gpt-4o") — the council was left unchanged.`,
            );
          }
          update.members = members;
        }

        if (input.judge_model !== undefined) {
          // "auto" is a recognized, explicit sentinel for "clear back to
          // auto-select the largest member" — equivalent to omitting the
          // field (the documented way), just spelled out. Anything else that
          // fails to parse is a genuine mistake, not a synonym for "auto":
          // unlike "models" (a list, where one bad entry can be dropped and
          // reported alongside the rest that still apply), judge_model is a
          // single value — silently substituting "auto" for an unparseable
          // one would clear any previously configured judge with no visible
          // signal, leaving the caller believing their explicit choice is in
          // effect while a different model actually adjudicates every
          // categorized/deconflicted/pooled/dialectic run. Reject outright.
          if (input.judge_model.trim().toLowerCase() === 'auto') {
            update.judgeModelId = undefined;
          } else {
            const parsed = parseModelId(input.judge_model);
            if (!parsed) {
              throw new Error(
                `judge_model "${input.judge_model}" is not a valid model id (expected "provider:model", ` +
                  `e.g. "openai:gpt-4o", or "auto" to clear it back to automatic selection).`,
              );
            }
            update.judgeModelId = parsed;
          }
        }

        if (input.response_mode !== undefined) {
          update.responseMode = input.response_mode as ResponseMode;
        }

        if (input.max_deconflict_rounds !== undefined) {
          update.maxDeconflictRounds = input.max_deconflict_rounds;
        }

        if (input.auto_council !== undefined) {
          update.autoCouncil = input.auto_council;
        }

        orchestrator.updateConfig(update);
        // Only a call that actually expresses MEMBERSHIP intent (touches
        // `models`, even to an empty/intentional-clear list) should block
        // initCouncil()'s background auto-population — that flag exists to
        // protect an explicit membership decision (including a deliberate
        // zero-member one), not any settings change. A settings-only call
        // (e.g. just `response_mode`) setting it unconditionally could
        // silently discard a racing initCouncil() detection on a fresh
        // install with no membership decision actually made, losing
        // claude-cli/codex-cli/grok-cli auto-members down to Ollama-only
        // with no visible signal.
        if (input.models !== undefined) {
          explicitlyConfigured = true;
        }
        const cfg = orchestrator.getConfig();

        // Persist ONLY the settings this call actually touched — matching
        // setup_council's "only what was supplied" discipline (see its
        // comment): an untouched field must never get pinned to its current
        // snapshot value, which would then permanently shadow a later env
        // var change or a different caller's edit for that field.
        const persistPatch: Partial<CouncilState> = {};
        if (input.models !== undefined) {
          persistPatch.members = cfg.members.map(m => modelIdLabel(m.modelId));
        }
        if (input.judge_model !== undefined) {
          persistPatch.judgeModelId = cfg.judgeModelId; // undefined ("auto") is written as absent — JSON.stringify drops it
        }
        if (input.response_mode !== undefined) {
          persistPatch.responseMode = cfg.responseMode;
        }
        if (input.max_deconflict_rounds !== undefined) {
          persistPatch.maxDeconflictRounds = cfg.maxDeconflictRounds;
        }
        if (input.auto_council !== undefined) {
          persistPatch.autoCouncil = cfg.autoCouncil;
        }
        if (Object.keys(persistPatch).length > 0) {
          saveState(persistPatch);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'updated',
                  council: {
                    members: cfg.members.length
                      ? cfg.members.map(m => modelIdLabel(m.modelId))
                      : `(auto: all Ollama chat models${cfg.autoCouncil ? '' : ' — DISABLED'})`,
                    judgeModel: cfg.judgeModelId
                      ? modelIdLabel(cfg.judgeModelId)
                      : 'auto (largest member)',
                    responseMode: cfg.responseMode,
                    maxDeconflictRounds: cfg.maxDeconflictRounds,
                    autoCouncil: cfg.autoCouncil,
                  },
                  // Surfaced so a mistyped or keyless member isn't silently ignored.
                  ...(rejected.length
                    ? { rejected: { note: 'Unrecognized model IDs (need "provider:model") — ignored.', ids: rejected } }
                    : {}),
                  ...(unavailable.length
                    ? { unavailable: { note: 'Parsed but no provider is registered (check API key / server config / tier). Added but will not answer until available.', ids: unavailable } }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ── ask_council ──────────────────────────────────────────────────────
      case 'ask_council': {
        const input = AskCouncilInput.parse(args ?? {});
        const result = await runCouncil(input, onProgress);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ── ask_council_async ────────────────────────────────────────────────
      case 'ask_council_async': {
        const input = AskCouncilAsyncInput.parse(args ?? {});
        const job = jobs.start(input.question, {
          mode: (input.mode as string | undefined) ?? orchestrator.getConfig().responseMode,
          memberCount: orchestrator.getConfig().members.length || undefined,
        });
        // Fire-and-forget: run in the background, record the outcome. Never let a
        // rejection escape (it would be an unhandled promise rejection).
        runCouncil(input)
          .then(result => jobs.finish(job.id, result))
          .catch(err => jobs.fail(job.id, err instanceof Error ? err.message : String(err)));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'running',
                  job_id: job.id,
                  mode: job.mode,
                  members: job.memberCount ?? '(auto)',
                  note: 'Poll get_council_result with this job_id to fetch the answer.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ── get_council_result ───────────────────────────────────────────────
      case 'get_council_result': {
        const input = GetCouncilResultInput.parse(args ?? {});
        if (!input.job_id || input.list) {
          return {
            content: [
              { type: 'text', text: JSON.stringify({ jobs: jobs.list() }, null, 2) },
            ],
          };
        }
        const job = jobs.get(input.job_id);
        if (!job) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No such job: ${input.job_id}. Jobs are dropped on server reload; list with get_council_result (no job_id).`,
          );
        }
        const payload =
          job.status === 'done'
            ? { status: job.status, job_id: job.id, elapsedMs: (job.finishedAt ?? 0) - job.startedAt, result: job.result }
            : job.status === 'error'
              ? { status: job.status, job_id: job.id, error: job.error }
              : { status: job.status, job_id: job.id, note: 'Still running — poll again shortly.' };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      }

      // ── get_council_config ───────────────────────────────────────────────
      case 'get_council_config': {
        const cfg = orchestrator.getConfig();
        const runtime = orchestrator.getRuntime();
        const providers = appConfig.servers.map(s => ({
          id: s.id,
          type: s.type,
          label: s.label,
          baseUrl: s.type === 'ollama' || s.type === 'vllm' || s.type === 'trtllm' || s.type === 'sglang'
            ? redactUrlUserinfo(s.baseUrl) // strip any embedded basic-auth creds from output
            : '(cloud)',
          hasApiKey: !!s.apiKey,
        }));

        // If no explicit members, show what auto-council would pick right now
        const explicit = cfg.members.map(m => modelIdLabel(m.modelId));
        let effectiveMembers = explicit;
        let membershipSource = 'configured';
        if (explicit.length === 0 && cfg.autoCouncil) {
          try {
            const auto = await orchestrator.autoDiscoverCouncil();
            effectiveMembers = auto.map(modelIdLabel);
            membershipSource = 'auto (all Ollama chat models, local + :cloud)';
          } catch {
            membershipSource = 'auto (unable to reach Ollama)';
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  council: {
                    members: effectiveMembers,
                    membershipSource,
                    autoCouncil: cfg.autoCouncil,
                    judgeModel: cfg.judgeModelId
                      ? modelIdLabel(cfg.judgeModelId)
                      : 'auto (largest member)',
                    responseMode: cfg.responseMode,
                    maxDeconflictRounds: cfg.maxDeconflictRounds,
                  },
                  providers,
                  runtime: {
                    maxTokens: runtime.maxTokens,
                    cloudConcurrency: runtime.cloudConcurrency,
                    localConcurrency: runtime.localConcurrency,
                    retries: runtime.retries,
                    verbose: runtime.verbose,
                  },
                  env_reference: {
                    OLLAMA_ADDRESS: 'Ollama server URL (default: http://localhost:11434)',
                    OPENAI_API_KEY: 'Enables OpenAI models',
                    ANTHROPIC_API_KEY: 'Enables Anthropic Claude models',
                    XAI_API_KEY: 'Enables X.AI Grok models',
                    VLLM_SERVERS: 'Comma-separated "name:host:port" entries for vLLM',
                    TRTLLM_SERVERS: 'Comma-separated "name:host:port" entries for TRT-LLM',
                    SGLANG_SERVERS: 'Comma-separated "name:host:port" entries for SGLang',
                    COUNCIL_MODELS: 'Default council members, e.g. "ollama:llama3,openai:gpt-4o". Empty = auto.',
                    AUTO_COUNCIL: 'true (default) auto-fills council from all Ollama chat models when COUNCIL_MODELS is empty',
                    JUDGE_MODEL: 'Judge model (default: auto)',
                    RESPONSE_MODE: 'individual | categorized | deconflicted | pooled | dialectic',
                    MAX_DECONFLICT_ROUNDS: 'Max deconfliction rounds (default: 3)',
                    CLAUDE_TIER: 'Claude plan: free | pro | max5x | max20x (drives Claude concurrency + membership)',
                    CHATGPT_TIER: 'ChatGPT plan: free | plus | pro5x | pro20x (drives Codex concurrency + membership)',
                    OLLAMA_TIER: 'Ollama plan: free | pro | max (free = local only; pro/max = cloud + 3/10 concurrency)',
                    GROK_TIER: 'Grok (X.AI subscription CLI) plan: free | supergrok | premiumplus | heavy (default free — opt in explicitly)',
                    CLAUDE_CLI: 'true → add a subscription-backed Claude member via the local `claude` CLI (no API key/billing)',
                    CLAUDE_CLI_MODELS: 'Comma-separated model aliases for the CLI member (default: opus,sonnet)',
                    CLAUDE_CLI_PATH: 'Path to the claude executable (default: claude)',
                    CODEX_CLI: 'true → add a ChatGPT-subscription member via the local `codex exec` CLI (coding-agent; no API key)',
                    CODEX_CLI_MODELS: 'Comma-separated model names for the Codex member ("default" = codex default)',
                    CODEX_CLI_PATH: 'Path to the codex executable (default: codex)',
                    GROK_CLI: 'true → add a Grok-subscription member via the local `grok` CLI (no API key/billing)',
                    GROK_CLI_MODELS: 'Comma-separated model names for the Grok CLI member (default: grok-4.5)',
                    GROK_CLI_PATH: 'Path to the grok executable (default: grok)',
                    MAX_TOKENS: 'Max output tokens per completion (default: 32768), clamped per-model to fit context',
                    CLOUD_CONCURRENCY: 'Optional override: caps ALL cloud pools (overrides per-tier limits). Unset = tiers drive it.',
                    LOCAL_CONCURRENCY: 'Max concurrent local requests (default: 1; 0 = unlimited)',
                    COMPLETION_RETRIES: 'Attempts per completion before giving up on empty/error (default: 3)',
                    REQUEST_TIMEOUT_MS: 'Per-completion wall-clock timeout in ms (default: 120000). Raise for slow local models or full-repo-access reviews — this is honoured verbatim by every provider, including claude-cli/codex-cli/grok-cli (no 300s floor).',
                    DECONFLICT_VERBOSE: 'true → deconflicted results include per-round detail by default',
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ── council_status ───────────────────────────────────────────────────
      case 'council_status': {
        const subs = loadSubscriptions();
        const tiers = effectiveTiers(subs); // persisted tiers win, re-validated
        // Detect fresh (concurrently) so a login/logout since boot is reflected.
        const report = await detectEnvironment(registry, tiers, subs);
        const cfg = orchestrator.getConfig();
        const members = cfg.members.map(m => modelIdLabel(m.modelId));
        // Redacted: surfaced in a user-facing "not reachable at <url>" hint below.
        const ollamaUrl = redactUrlUserinfo(appConfig.servers.find(s => s.type === 'ollama')?.baseUrl ?? '');
        const hints: string[] = [];
        if (!report.claude.installed) hints.push('Claude CLI not found — install the Claude Code CLI and log in to add Claude subscription members.');
        else if (!report.claude.usable) hints.push('Claude CLI is installed but not usable — run `claude` then `/login` (or `claude setup-token`).');
        if (!report.codex.installed) hints.push('Codex CLI not found — `npm i -g @openai/codex` then `codex login` to add ChatGPT members.');
        else if (!report.codex.usable) hints.push('Codex CLI is installed but not signed in — run `codex login`.');
        if (!report.grok.installed) hints.push('Grok CLI not found — install it (curl -fsSL https://x.ai/cli/install.sh | bash) and log in to add Grok members.');
        // Grok defaults to the 'free' tier (opt-in, unlike claude/chatgpt) so a
        // real (quota-metered) login probe never runs until this gate passes —
        // check it BEFORE report.grok.usable, which is unverified (left false)
        // below this gate. See detectGrok() in detect.ts.
        else if (!tierAllowsCloud('grok', tiers.grok, subs)) hints.push('Grok CLI is installed — set GROK_TIER (supergrok | premiumplus | heavy) or run setup_council to add Grok members (defaults to free/opt-in).');
        else if (!report.grok.usable) hints.push('Grok CLI is installed but not usable — run `grok login`.');
        if (report.ollama.cloud === 'failed') hints.push('Ollama cloud models did not respond — your plan may not include cloud (needs Ollama Pro/Max).');
        if (!report.ollama.reachable) hints.push(`Ollama not reachable at ${ollamaUrl}.`);
        // Concurrency/registration are fixed at boot; a tier changed since then needs a reload.
        const reloadPending = JSON.stringify(tiers) !== JSON.stringify(appConfig.tiers);
        if (reloadPending) hints.push('Subscription tier changed since boot — run /reload-plugins (or restart) to apply new concurrency and provider registration.');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  tiers,
                  detected: report,
                  council: { members, count: members.length },
                  concurrency: appConfig.runtime.poolLimits, // currently in effect (boot-time)
                  reloadPending,
                  quotaWarning: quotaWarning(report, tiers, subs),
                  hints,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ── setup_council ────────────────────────────────────────────────────
      case 'setup_council': {
        const input = SetupCouncilInput.parse(args ?? {});
        // Set this BEFORE the await below (round 6 finding), not after this
        // call's own updateConfig — setup_council's `detectEnvironment` call
        // is genuinely slow (real subprocess probes). Setting the flag only
        // after it resolves left a window where a concurrently-running
        // background initCouncil() (racing on its own, stale, boot-time-tiers
        // detection) could see `explicitlyConfigured` still false, run to
        // completion, and PERSIST its own member list to state.json before
        // this call ever gets a chance to set the flag. The round-5 fix only
        // protected the live in-memory config (last write wins there
        // regardless of flag timing) — the persisted side-channel was still
        // exposed. Setting it immediately, synchronously, closes the window
        // for both: nothing async happens between this call being received
        // and this line, so no interleaving is possible.
        explicitlyConfigured = true;
        const subs = loadSubscriptions();
        const tiers = effectiveTiers(subs); // re-validated base (drops tiers a pulled config removed)
        const applied: Record<string, string> = {};
        // A mistyped/invalid tier (e.g. "premium" instead of "plus") must be
        // surfaced, not silently dropped with no trace — matching
        // configure_council's established pattern of reporting rejected input
        // alongside whatever DID apply, rather than pretending the call fully
        // succeeded when part of it was ignored.
        const invalid: Record<string, string> = {};
        const applyTier = (provider: SubProvider, value: string | undefined): void => {
          if (value === undefined) return;
          if (validTiers(provider, subs).includes(value)) {
            tiers[provider] = value;
            applied[provider] = value;
          } else {
            invalid[provider] = value;
          }
        };
        applyTier('chatgpt', input.chatgpt);
        applyTier('claude', input.claude);
        applyTier('grok', input.grok);
        applyTier('ollama', input.ollama);
        // Persist ONLY the keys the caller actually supplied (`applied`), not
        // the full `tiers` object — `tiers` also carries providers the caller
        // never touched (their currently-effective value, itself derived
        // from state ?? env ?? default). Writing all four would pin the
        // untouched ones to that snapshot in state.json, where they'd then
        // permanently shadow any later env var change for that provider
        // (resolveTier/effectiveTiers always prefer a persisted state.tiers
        // entry over the env var) — the caller never asked for that provider
        // to become "sticky."
        if (Object.keys(applied).length > 0) {
          saveState(current => ({ tiers: { ...(current.tiers ?? {}), ...applied } }));
        }

        // Re-detect + re-populate from currently-registered providers.
        const report = await detectEnvironment(registry, tiers, subs);
        const labels = autoPopulatedMembers(report, tiers, subs);
        orchestrator.updateConfig({ members: labelsToMembers(labels) });
        // (explicitlyConfigured was already set at the top of this handler.)
        // Only PERSIST a non-empty result — matching initCouncil()'s own
        // `if (labels.length)` guard. A transient detection hiccup (Ollama
        // momentarily unreachable, a CLI probe timing out) can make a genuine
        // council look empty for one call; persisting that empty array would
        // permanently lock boot auto-population out (initCouncil() treats any
        // *present* `members` array, even `[]`, as "already configured, don't
        // auto-populate" and returns early) — surviving only until the next
        // manual setup_council/configure_council call. The live session still
        // reflects whatever was actually just detected via updateConfig above.
        if (labels.length > 0) {
          saveState({ members: labels });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'updated',
                  tiers,
                  applied,
                  ...(Object.keys(invalid).length > 0 ? { invalid } : {}),
                  council: { members: labels, count: labels.length },
                  quotaWarning: quotaWarning(report, tiers, subs),
                  note:
                    'Tiers saved. Concurrency changes and newly-enabled subscription ' +
                    'providers take full effect after `/reload-plugins` (or restarting the server).' +
                    (Object.keys(invalid).length > 0
                      ? ` Ignored invalid tier value(s): ${JSON.stringify(invalid)} — see \`invalid\` above for valid options.`
                      : ''),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${err.message}`,
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    );
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('model-council-mcp running on stdio\n');
  // Auto-configure in the background — never blocks serving requests.
  initCouncil().catch(() => {});
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
