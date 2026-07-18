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
 * ask_council / ask_council_async also accept `context` (inline text) and
 * `files` (local paths) to attach as labelled context for every member.
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

import { loadConfig, modelIdLabel, parseModelId } from './config.js';
import { ProviderRegistry } from './providers/registry.js';
import { CouncilOrchestrator } from './council/orchestrator.js';
import { CouncilConfig, CouncilMember, ModelId, ResponseMode, SubscriptionTiers } from './types.js';
import { loadState, saveState } from './state.js';
import { loadSubscriptions, validTiers, SubProvider } from './subscriptions.js';
import { detectEnvironment, autoPopulatedMembers, quotaWarning } from './detect.js';
import { buildAugmentedQuestion } from './context.js';
import { JobStore } from './jobs.js';

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
const jobs = new JobStore();

// Persist resolved Ollama address / CLI paths so the SessionStart hook can read
// them — the plugin host doesn't propagate userConfig env to hook processes.
try {
  saveState({
    env: {
      ollamaAddress: appConfig.servers.find(s => s.type === 'ollama')?.baseUrl,
      claudeCliPath: appConfig.servers.find(s => s.type === 'claude-cli')?.command,
      codexCliPath: appConfig.servers.find(s => s.type === 'codex-cli')?.command,
    },
  });
} catch {
  /* best-effort — a read-only state dir must not break boot */
}

/** Compose context/files into the prompt, then run the council. Shared by the
 *  synchronous ask_council and the background ask_council_async. */
async function runCouncil(input: {
  question: string;
  mode?: string;
  max_deconflict_rounds?: number;
  verbose?: boolean;
  context?: string;
  files?: string[];
}) {
  const question = await buildAugmentedQuestion(input.question, {
    context: input.context,
    files: input.files,
  });
  return orchestrator.ask(
    question,
    input.mode as ResponseMode | undefined,
    input.max_deconflict_rounds,
    input.verbose,
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
    const v = stateTiers[p] ?? appConfig.tiers[p];
    return validTiers(p, subs).includes(v) ? v : appConfig.tiers[p];
  };
  return { chatgpt: guard('chatgpt'), claude: guard('claude'), ollama: guard('ollama') };
}

/**
 * On boot: honour a persisted council (survives reloads), or — on a fresh
 * install — detect the environment and auto-populate the council with
 * everything usable ("everything on"). Runs in the background; never blocks the
 * server, and falls back to zero-config Ollama auto-discovery on any failure.
 */
async function initCouncil(): Promise<void> {
  // Explicit COUNCIL_MODELS (or a prior configure_council in this process) wins —
  // don't override an already-configured council with persisted/auto state.
  if (orchestrator.getConfig().members.length > 0) return;
  const persisted = loadState();
  if (Array.isArray(persisted.members)) {
    orchestrator.updateConfig({ members: labelsToMembers(persisted.members) });
    return;
  }
  try {
    const subs = loadSubscriptions();
    const report = await detectEnvironment(registry, appConfig.tiers, subs);
    // Detection is slow (subprocess probes); an explicit configure_council or
    // setup_council may have landed while we awaited — it MUST win. Re-check both
    // guards before clobbering.
    if (orchestrator.getConfig().members.length > 0) return;
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
      'Optional provider to filter by (ollama, openai, anthropic, groq, vllm, trtllm, sglang)',
    ),
});

const ConfigureCouncilInput = z.object({
  models: z
    .array(z.string())
    .optional()
    .describe(
      'Model IDs for council members. Format: "provider:model" or ' +
        '"provider/serverId:model". Examples: "ollama:llama3", ' +
        '"vllm/vllm-gpu1:meta-llama/Llama-3-8B", "openai:gpt-4o"',
    ),
  judge_model: z
    .string()
    .optional()
    .describe(
      'Model to act as judge for categorisation/deconfliction. ' +
        'Same format as models. Omit for "auto" (picks largest council member).',
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
        'labelled). Caps: 256 KB/file, 768 KB total, 20 files.',
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
  ollama: z.string().optional().describe('Ollama tier: free | pro | max'),
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_models',
    annotations: { title: 'List models', readOnlyHint: true },
    description:
      'List all AI models available across every configured provider ' +
      '(Ollama, OpenAI, Anthropic, Groq, vLLM, TRT-LLM, SGLang). ' +
      'Use the returned model IDs when calling configure_council.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter_provider: {
          type: 'string',
          description:
            'Optional provider filter: ollama | openai | anthropic | groq | vllm | trtllm | sglang',
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
      'and set the maximum deconfliction rounds.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        models: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Council member model IDs. Format: "provider:model" or "provider/serverId:model". ' +
            'Examples: "ollama:llama3", "openai:gpt-4o", "vllm/server1:meta-llama/Llama-3-8B"',
        },
        judge_model: {
          type: 'string',
          description:
            'Judge model ID. Same format. Omit for auto (largest council member).',
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
      'the judge compiles a pros/cons dossier per option, then members re-select a ranked top-3).',
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
            '(caps: 256 KB/file, 768 KB total, 20 files).',
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
      'whether Ollama cloud is reachable on this plan, whether the Claude and Codex ' +
      'CLIs are installed AND logged in, the current council members, resolved ' +
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
      'chatgpt (free|plus|pro5x|pro20x), claude (free|pro|max5x|max20x), ollama ' +
      '(free|pro|max). Choices persist across reloads. Note: registering a NEW ' +
      'subscription provider or changing concurrency takes full effect after a reload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chatgpt: { type: 'string', enum: ['free', 'plus', 'pro5x', 'pro20x'], description: 'ChatGPT subscription tier.' },
        claude: { type: 'string', enum: ['free', 'pro', 'max5x', 'max20x'], description: 'Claude subscription tier.' },
        ollama: { type: 'string', enum: ['free', 'pro', 'max'], description: 'Ollama subscription tier.' },
      },
    },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'model-council-mcp',
    version: '0.2.10',
  },
  {
    capabilities: { tools: {} },
    instructions:
      'model-council fans a question out to a council of local (Ollama) and ' +
      'subscription models — Claude via the local `claude` CLI and ChatGPT via the ' +
      'local `codex` CLI — and reconciles the answers (individual / categorized / ' +
      'deconflicted / pooled / dialectic). It auto-configures on first use. On a ' +
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
server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;

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
          update.members = members;
        }

        if (input.judge_model !== undefined) {
          update.judgeModelId = parseModelId(input.judge_model) ?? undefined;
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
        const cfg = orchestrator.getConfig();

        // Persist member edits so deletions/selections survive plugin reloads.
        if (input.models !== undefined) {
          saveState({ members: cfg.members.map(m => modelIdLabel(m.modelId)) });
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
        const result = await runCouncil(input);

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
            ? s.baseUrl
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
                    GROQ_API_KEY: 'Enables Groq models',
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
                    CLAUDE_CLI: 'true → add a subscription-backed Claude member via the local `claude` CLI (no API key/billing)',
                    CLAUDE_CLI_MODELS: 'Comma-separated model aliases for the CLI member (default: opus,sonnet)',
                    CLAUDE_CLI_PATH: 'Path to the claude executable (default: claude)',
                    CODEX_CLI: 'true → add a ChatGPT-subscription member via the local `codex exec` CLI (coding-agent; no API key)',
                    CODEX_CLI_MODELS: 'Comma-separated model names for the Codex member ("default" = codex default)',
                    CODEX_CLI_PATH: 'Path to the codex executable (default: codex)',
                    MAX_TOKENS: 'Max tokens per completion (default: 16000)',
                    CLOUD_CONCURRENCY: 'Optional override: caps ALL cloud pools (overrides per-tier limits). Unset = tiers drive it.',
                    LOCAL_CONCURRENCY: 'Max concurrent local requests (default: 1; 0 = unlimited)',
                    COMPLETION_RETRIES: 'Attempts per completion before giving up on empty/error (default: 3)',
                    REQUEST_TIMEOUT_MS: 'Per-completion wall-clock timeout in ms (default: 120000). Raise for slow local models; CLI providers keep a 300s floor.',
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
        const ollamaUrl = appConfig.servers.find(s => s.type === 'ollama')?.baseUrl ?? '';
        const hints: string[] = [];
        if (!report.claude.installed) hints.push('Claude CLI not found — install the Claude Code CLI and log in to add Claude subscription members.');
        else if (!report.claude.usable) hints.push('Claude CLI is installed but not usable — run `claude` then `/login` (or `claude setup-token`).');
        if (!report.codex.installed) hints.push('Codex CLI not found — `npm i -g @openai/codex` then `codex login` to add ChatGPT members.');
        else if (!report.codex.usable) hints.push('Codex CLI is installed but not signed in — run `codex login`.');
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
        const subs = loadSubscriptions();
        const tiers = effectiveTiers(subs); // re-validated base (drops tiers a pulled config removed)
        const applied: Record<string, string> = {};
        const applyTier = (provider: SubProvider, value: string | undefined): void => {
          if (value !== undefined && validTiers(provider, subs).includes(value)) {
            tiers[provider] = value;
            applied[provider] = value;
          }
        };
        applyTier('chatgpt', input.chatgpt);
        applyTier('claude', input.claude);
        applyTier('ollama', input.ollama);
        saveState({ tiers });

        // Re-detect + re-populate from currently-registered providers.
        const report = await detectEnvironment(registry, tiers, subs);
        const labels = autoPopulatedMembers(report, tiers, subs);
        orchestrator.updateConfig({ members: labelsToMembers(labels) });
        saveState({ members: labels });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'updated',
                  tiers,
                  applied,
                  council: { members: labels, count: labels.length },
                  quotaWarning: quotaWarning(report, tiers, subs),
                  note:
                    'Tiers saved. Concurrency changes and newly-enabled subscription ' +
                    'providers take full effect after `/reload-plugins` (or restarting the server).',
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
