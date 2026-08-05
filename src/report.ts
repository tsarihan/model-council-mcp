/**
 * Server-side result file writing for ask_council's `output_file`.
 *
 * Members can write ONLY into their private scratch directories (see
 * CompletionOptions.scratchDir) — never to a caller-chosen path, and never to
 * the repo under review. So "save the results to a file" is the SERVER's job:
 * the parent process, which already owns state.json and the job store, writes
 * the finished report where the caller asked, inlining what members wrote to
 * scratch. Single final writer, full detail, no member trust required.
 *
 * The markdown renderer is loss-proof by construction: the sections it knows
 * about (responses, synthesis-like fields, sources, usage) render readable,
 * and every top-level field it does NOT recognize is appended verbatim as
 * pretty-printed JSON — a new response mode can add fields without silently
 * missing from saved reports.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

/** Extensions we will write. A narrow allowlist keeps a mistyped path from
 * clobbering dotfiles, scripts, or binaries — results are documents. */
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json']);

/** Top-level keys the renderer formats itself (everything else goes to the
 * verbatim-JSON tail). Order here is presentation order. */
const RENDERED_KEYS = new Set([
  'question', 'mode', 'responses', 'cache', 'usage', 'sources', 'memberFiles', 'outputFile',
]);

/** Per-file inline cap for member-written files in markdown reports, and the
 * cap on the total inlined across a report. Files past either cap are listed
 * by path instead — the report must stay openable, and the files remain on
 * disk in full. */
const INLINE_FILE_CAP = 256 * 1024;
const INLINE_TOTAL_CAP = 6 * 1024 * 1024;

export interface MemberFileEntry { member: string; path: string; bytes: number }
export interface InlinedMemberFile extends MemberFileEntry { text?: string }

/** Keys that read best directly after the responses when present — the
 * judge-produced payload of the non-individual modes. */
const SYNTHESIS_FIRST = [
  'synthesis', 'finalAnswer', 'categories', 'categorized', 'pooled',
  'dossier', 'rankings', 'deconflictionScore', 'rounds', 'assessment',
];

interface ResponseEntry {
  label?: string;
  response?: string;
  phase?: string;
  latencyMs?: number;
  timedOut?: boolean;
  error?: string;
}

function fence(v: unknown): string {
  return '```json\n' + JSON.stringify(v, null, 2) + '\n```';
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`;
}

/** Render a council result as a standalone markdown report. Pure (no I/O). */
export function renderCouncilReport(
  result: Record<string, unknown>,
  writtenAt: Date,
  memberFileBodies?: InlinedMemberFile[],
): string {
  const parts: string[] = [];
  const mode = typeof result.mode === 'string' ? result.mode : 'unknown';
  parts.push('# Council result\n');

  const metaBits = [`mode: ${mode}`, `written: ${writtenAt.toISOString()}`];
  const cache = result.cache as { hit?: boolean; ageMs?: number } | undefined;
  if (cache?.hit) metaBits.push(`served from cache (${Math.round((cache.ageMs ?? 0) / 1000)}s old)`);
  parts.push(`_${metaBits.join(' · ')}_\n`);

  if (typeof result.question === 'string') {
    parts.push(section('Question', result.question));
  }

  const responses = Array.isArray(result.responses) ? (result.responses as ResponseEntry[]) : [];
  if (responses.length) {
    const rendered = responses.map((r) => {
      const label = r.label ?? 'unknown member';
      const tags = [
        r.phase ? `phase: ${r.phase}` : undefined,
        typeof r.latencyMs === 'number' ? `${(r.latencyMs / 1000).toFixed(1)}s` : undefined,
        r.timedOut ? 'TIMED OUT' : undefined,
      ].filter(Boolean).join(' · ');
      const body = r.error
        ? `_errored: ${r.error}_`
        : (r.response ?? '_(empty response)_');
      return `### ${label}${tags ? ` — ${tags}` : ''}\n\n${body}`;
    }).join('\n\n');
    parts.push(section('Responses', rendered));
  }

  // Judge output and mode-specific payload, then anything unrecognized —
  // strings render as prose sections, everything else as verbatim JSON so no
  // field can silently vanish from a saved report.
  const rest = Object.keys(result).filter((k) => !RENDERED_KEYS.has(k));
  rest.sort((a, b) => {
    const ia = SYNTHESIS_FIRST.indexOf(a); const ib = SYNTHESIS_FIRST.indexOf(b);
    return (ia < 0 ? SYNTHESIS_FIRST.length : ia) - (ib < 0 ? SYNTHESIS_FIRST.length : ib)
      || a.localeCompare(b);
  });
  for (const k of rest) {
    const v = result[k];
    if (v === undefined || v === null) continue;
    parts.push(section(k, typeof v === 'string' ? v : fence(v)));
  }

  if (memberFileBodies?.length) {
    const rendered = memberFileBodies.map((f) => {
      const head = `### ${f.member} — \`${f.path}\` (${f.bytes} bytes)`;
      return f.text !== undefined
        ? `${head}\n\n${f.text.trim()}`
        : `${head}\n\n_not inlined (binary or over the ${Math.round(INLINE_FILE_CAP / 1024)} KB inline cap) — read it at the path above_`;
    }).join('\n\n');
    parts.push(section('Member files', rendered));
  }

  const sources = Array.isArray(result.sources) ? (result.sources as unknown[]) : [];
  if (sources.length) {
    parts.push(section('Sources', sources.map((s) => `- ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n')));
  }
  if (result.usage !== undefined) {
    parts.push(section('Usage', fence(result.usage)));
  }

  return parts.join('\n') + '\n';
}

/**
 * Validate the requested path. Exported separately so the checks are
 * unit-testable without touching disk. Returns the resolved absolute path.
 */
export function resolveOutputPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('output_file is empty.');
  const expanded = trimmed === '~' || trimmed.startsWith('~/')
    ? resolve(homedir(), trimmed.slice(2))
    : trimmed;
  if (!isAbsolute(expanded)) {
    throw new Error(
      `output_file must be an absolute path (got "${raw}") — the council server's ` +
      'working directory is not your shell\'s, so a relative path would land somewhere surprising.',
    );
  }
  const ext = extname(expanded).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `output_file must end in .md, .markdown, .txt, or .json (got "${ext || 'no extension'}") — ` +
      'results are documents, and the allowlist keeps a mistyped path from overwriting something that is not one.',
    );
  }
  return resolve(expanded);
}

export interface OutputFileReceipt {
  path: string;
  bytes: number;
  format: 'markdown' | 'json';
}

/** Write the result to `raw` (creating parent directories), returning a receipt. */
export function writeCouncilOutput(raw: string, result: Record<string, unknown>): OutputFileReceipt {
  const path = resolveOutputPath(raw);
  const format: OutputFileReceipt['format'] = extname(path).toLowerCase() === '.json' ? 'json' : 'markdown';
  const body = format === 'json'
    ? JSON.stringify(result, null, 2) + '\n'
    : renderCouncilReport(result, new Date(), readMemberFileBodies(result));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return { path, bytes: Buffer.byteLength(body, 'utf8'), format };
}

/**
 * Read member-written scratch files for inlining into a markdown report — the
 * whole point of member file output is that the FULL findings end up in the
 * artifact. Text files up to the caps are inlined verbatim; binary files
 * (NUL-byte sniff) and oversized ones are listed by path. Read failures list
 * the path too: the report must render even if a file vanished.
 */
function readMemberFileBodies(result: Record<string, unknown>): InlinedMemberFile[] | undefined {
  const mf = result.memberFiles as { files?: MemberFileEntry[] } | undefined;
  const files = Array.isArray(mf?.files) ? mf.files : [];
  if (!files.length) return undefined;
  let budget = INLINE_TOTAL_CAP;
  return files.map((f) => {
    if (f.bytes > INLINE_FILE_CAP || f.bytes > budget) return { ...f };
    try {
      const buf = readFileSync(f.path);
      if (buf.includes(0)) return { ...f };
      budget -= buf.length;
      return { ...f, text: buf.toString('utf8') };
    } catch {
      return { ...f };
    }
  });
}
