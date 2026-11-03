// Prints what a row holds, field by field, so a run can be checked by eye.
//   npm run inspect -- <row.json> [more rows...]

import { readFileSync } from "node:fs";
import { collectorSources } from "./collector";
import type { AnswerRow } from "./types";

const cut = (s: string | null | undefined, n: number) => (s == null ? "null" : JSON.stringify(s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s));

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, "utf8")) as AnswerRow;
  const c = r.capture;
  console.log(`\n=== ${c.engine} · ${file}`);
  console.log(`status       ${r.error_code ? `${r.error_code}: ${r.error}` : "ok"} · attempt ${c.attempt} · ${Math.round(c.timings.ms / 1000)}s (first text ${c.timings.first_text_at ? Math.round((Date.parse(c.timings.first_text_at) - Date.parse(c.timings.sent_at)) / 1000) + "s" : "-"})`);
  console.log(`url          ${r.url} · answer_url ${r.answer_url} · input ${cut(r.input.url, 90)}`);
  console.log(`country      ${r.country} · ip_location ${c.ip_location} · proxy ${c.proxy ? `${c.proxy.country}/${c.proxy.session}` : "none"}`);
  console.log(`model        ${r.model} · detail ${c.model_detail ? JSON.stringify(c.model_detail) : "null"}`);
  console.log(`ids          conversation ${c.conversation_id} · message ${c.message_id}`);
  console.log(`web search   ${r.web_search_triggered} · reasoning ${JSON.stringify(c.reasoning)}`);
  console.log(`text         ${r.answer_text.length} chars · head ${cut(r.answer_text, 160)}`);
  console.log(`             tail ${cut(r.answer_text.slice(-160), 160)}`);
  console.log(`markdown     ${r.answer_text_markdown?.length ?? 0} chars from ${c.markdown_from} · head ${cut(r.answer_text_markdown, 200)}`);
  console.log(`html         page ${r.answer_html?.length ?? 0} · section ${r.answer_section_html?.length ?? 0} · stream ${r.response_raw?.length ?? 0} chars`);
  console.log(`citations    ${r.citations.length}`);
  for (const x of r.citations.slice(0, 12)) console.log(`   - ${x.source ?? "?"} | ${cut(x.title, 70)} | ${x.url.slice(0, 100)}${x.date ? ` | ${x.date}` : ""}${x.cited_text.length ? ` | spans ${x.cited_text.length}` : ""}`);
  console.log(`search       ${r.search_sources?.length ?? "null"}`);
  for (const x of (r.search_sources ?? []).slice(0, 12)) console.log(`   - ${cut(x.title, 70)} | ${x.url.slice(0, 100)}`);
  console.log(`links        ${r.links_attached.length}`);
  for (const x of r.links_attached.slice(0, 8)) console.log(`   - ${cut(x.text, 60)} | ${x.url.slice(0, 100)}`);
  console.log(`shopping     ${r.shopping.length} · visible ${r.shopping_visible}`);
  for (const x of r.shopping.slice(0, 12)) console.log(`   - ${x.title} | ${x.price} | ${x.merchant ?? "-"} | ${x.label ?? "-"} | rating ${x.rating ?? "-"} (${x.reviews ?? "-"}) | ${x.url ? x.url.slice(0, 70) : "-"} | img ${x.image ? "yes" : "no"}`);
  console.log(`entities     ${JSON.stringify(c.entities)}`);
  console.log(`ads          ${r.ads ? JSON.stringify(r.ads).slice(0, 300) : "null"}`);
  console.log(`footnotes    ${c.footnotes}`);
  console.log(`screenshot   ${c.screenshot}`);
  console.log(`collector    ${collectorSources(r).length} sources would reach the dashboard`);
  console.log(`warnings     ${c.warnings.length ? c.warnings.join(" | ") : "none"}`);
}
