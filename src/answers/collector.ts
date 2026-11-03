// How the AI answer collector would take a row: the same steps as brightDataBatch() in
// ai-answer-collector/src/engines/brightdata.ts (feat/google-command-center @ 9380bdf), copied
// here so the summary shows what the dashboard would get. A row stands in for a Bright Data row
// unchanged: answer_text is the answer's text, and citations, links_attached and search_sources
// are merged into one source list, de-duplicated by URL.

import type { AnswerRow } from "./types";

export type CollectorSource = { url: string; title: string };

type SourceLike = string | { url?: string; link?: string; title?: string } | null;

export function collectorSources(row: AnswerRow): CollectorSource[] {
  const r = row as unknown as Record<string, unknown>;
  const seen = new Set<string>();
  const out: CollectorSource[] = [];
  for (const s of [r.citations, r.sources, r.links_attached, r.search_sources].filter(Array.isArray).flat() as SourceLike[]) {
    const url = typeof s === "string" ? s : s?.url || s?.link || "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof s === "string" ? "" : s?.title || "";
    out.push({ url, title: (title || url.split("/")[2]?.replace(/^www\./, "") || "").slice(0, 160) });
  }
  return out;
}

/** The collector's Answer for this row (text, markdown, html, sources, snapshotId, raw). */
export function collectorAnswer(row: AnswerRow) {
  const text = row.answer_text || row.answer_text_markdown || "";
  return { text, markdown: row.answer_text_markdown || null, html: row.answer_html, sources: collectorSources(row), snapshotId: null, raw: row };
}
