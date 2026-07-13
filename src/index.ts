#!/usr/bin/env node
/**
 * model-council-mcp — MCP server
 *
 * Tools exposed:
 *   list_models        — discover available models across all configured providers
 *   configure_council  — set council members, judge, mode, and deconflict rounds
 *   ask_council        — query the council (individual | categorized | deconflicted)
 *   get_council_config — inspect current council configuration
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
import { CouncilConfig, ModelId, ResponseMode } from './types.js';

// ─── Boot ─────────────────────────────────────────────────────────────────────

const appConfig = loadConfig();
const registry = new ProviderRegistry(appConfig.servers);
const orchestrator = new CouncilOrchestrator(registry, appConfig.council, appConfig.runtime);

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
    .enum(['individual', 'categorized', 'deconflicted'])
    .optional()
    .describe(
      'individual → each model responds independently. ' +
        'categorized → judge groups into agreement/complementary/conflicting. ' +
        'deconflicted → iterative loop until conflicts resolve or max_rounds reached.',
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
    .enum(['individual', 'categorized', 'deconflicted'])
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
      'Deconflicted mode only: include the initial categorization and per-round detail in the result.',
    ),
});

const GetCouncilConfigInput = z.object({});

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_models',
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
          enum: ['individual', 'categorized', 'deconflicted'],
          description:
            'individual: raw responses. categorized: agreement/complementary/conflicting. ' +
            'deconflicted: iterative loop with deconfliction score.',
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
    description:
      'Send a question to the model council and get a structured response. ' +
      'Mode: individual (each model answers separately), ' +
      'categorized (judge groups responses into agreement/complementary/conflicting), or ' +
      'deconflicted (iterative loop — judge orchestrates re-questioning until conflicts resolve, ' +
      'returns a deconfliction score 0–100%).',
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
          enum: ['individual', 'categorized', 'deconflicted'],
          description: 'Response mode override for this call only.',
        },
        max_deconflict_rounds: {
          type: 'number',
          description: 'Max deconfliction rounds override for this call only.',
        },
        verbose: {
          type: 'boolean',
          description:
            'Deconflicted mode only: include the initial categorization and per-round detail.',
        },
      },
    },
  },
  {
    name: 'get_council_config',
    description:
      'Return the current council configuration: member models, judge model, ' +
      'response mode, and max deconfliction rounds.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'model-council-mcp',
    version: '0.1.0',
  },
  {
    capabilities: { tools: {} },
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

        if (input.models !== undefined) {
          const members = input.models.flatMap(s => {
            const id = parseModelId(s);
            return id ? [{ modelId: id }] : [];
          });
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
        const result = await orchestrator.ask(
          input.question,
          input.mode as ResponseMode | undefined,
          input.max_deconflict_rounds,
          input.verbose,
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
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
                    RESPONSE_MODE: 'individual | categorized | deconflicted',
                    MAX_DECONFLICT_ROUNDS: 'Max deconfliction rounds (default: 3)',
                    CLAUDE_CLI: 'true → add a subscription-backed Claude member via the local `claude` CLI (no API key/billing)',
                    CLAUDE_CLI_MODELS: 'Comma-separated model aliases for the CLI member (default: opus,sonnet)',
                    CLAUDE_CLI_PATH: 'Path to the claude executable (default: claude)',
                    MAX_TOKENS: 'Max tokens per completion (default: 16000)',
                    CLOUD_CONCURRENCY: 'Max concurrent cloud requests (default: 3)',
                    LOCAL_CONCURRENCY: 'Max concurrent local requests (default: 1; 0 = unlimited)',
                    COMPLETION_RETRIES: 'Attempts per completion before giving up on empty/error (default: 3)',
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
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
