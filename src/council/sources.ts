/**
 * Consolidated source list for researched answers.
 *
 * Members cite dozens of URLs across an answer; without a merged view the only
 * way to audit a researched result — or see which claims are corroborated —
 * is to diff the member blocks by eye. This extracts every URL each member's
 * text cites, normalizes lightly, and reports who cited what, so "3 of 4
 * members cite AP for this" is a fact the caller can read rather than
 * reconstruct.
 *
 * Extraction is deliberately TEXTUAL: it reflects what members say they used.
 * The harness executes the fetches, but does not report them per-URL, so the
 * member's own citation is the best available record — and a member citing a
 * page it never read is a model-honesty failure this cannot detect, only
 * expose to checking (the URLs are right there to open).
 */
import { RawResponse } from '../types.js';

/** Markdown links and bare URLs; excludes trailing prose punctuation. */
// Parens are allowed IN the match (Wikipedia URLs contain them) — normalize()
// strips the unbalanced closers that belong to markdown links or prose.
const URL_RE = /https?:\/\/[^\s<>"'\]]+/g;

/** Cap so a pathological answer cannot balloon the result. */
const MAX_SOURCES = 100;

function normalize(raw: string): string {
  let u = raw
    // Angle-bracket wrapping (`<https://…>`) and HTML-escaped remnants.
    .replace(/^&lt;|&gt;$/g, '')
    // Trailing punctuation that belongs to the sentence, not the URL.
    .replace(/[.,;:!?]+$/, '');
  // A ")" is part of the URL only if the URL itself contains a "(" (Wikipedia
  // does this); otherwise it is the close of a markdown link or parenthetical.
  while (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) {
    u = u.slice(0, -1);
  }
  return u;
}

export function collectSources(
  responseArrays: (RawResponse[] | undefined)[],
): { url: string; citedBy: string[] }[] {
  const byUrl = new Map<string, Set<string>>();
  for (const arr of responseArrays) {
    if (!arr) continue;
    for (const r of arr) {
      if (!r?.response || r.error) continue;
      for (const m of r.response.match(URL_RE) ?? []) {
        const url = normalize(m);
        if (!url || url.length > 500) continue;
        let set = byUrl.get(url);
        if (!set) byUrl.set(url, (set = new Set()));
        set.add(r.label);
      }
    }
  }
  // Most-corroborated first — that ordering IS the point of the list.
  return [...byUrl.entries()]
    .map(([url, cited]) => ({ url, citedBy: [...cited].sort() }))
    .sort((a, b) => b.citedBy.length - a.citedBy.length || a.url.localeCompare(b.url))
    .slice(0, MAX_SOURCES);
}
