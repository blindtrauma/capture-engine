// Asks ChatGPT and Gemini through their own websites in real Chrome, doing the job Bright Data's
// ChatGPT and Gemini scrapers did for the AI answer collector: one row per answer with Bright
// Data's field names, plus a screenshot of the real conversation.
//
//   npm run ask -- --prompt "What are the best smartphones to buy in 2026?"
//   npm run ask -- --prompts prompts.txt --engines chatgpt,gemini --runs 3 --use-proxy
//   npm run ask -- --prompts prompts.jsonl --out output/answers/my-run      (running again resumes)
// In PowerShell type npm.cmd instead of npm (see ../cliArgs.ts).
//
// prompts.txt: one prompt per line. prompts.jsonl: {"id": "...", "prompt": "..."} per line.
// Each app runs in its own Chrome, one question at a time, with a pause between questions;
// the two apps run side by side. In --out:
//   rows/<engine>/<id>-r<run>.json          the full row (latest attempt)
//   screenshots/<engine>/<id>-r<run>.jpg    the conversation as it looked
//   index.jsonl                             one line per attempt; the latest line per job wins
//   summary.json                            totals when the run ends

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { keepAwake } from "../browser/keepAwake";
import { stopIfNpmTookFlags } from "../cliArgs";
import { PATHS } from "../config";
import { askChatGPT } from "./chatgpt";
import { collectorSources } from "./collector";
import { askGemini } from "./gemini";
import { newRow, type AskContext } from "./row";
import { firstLine, openEngine, rand, sleep, within, type EngineSession } from "./session";
import type { AnswerEngine, AnswerRow, AskJob, ErrorCode } from "./types";

const OPTIONS = {
  prompt: { type: "string", multiple: true },
  prompts: { type: "string" },
  engines: { type: "string", default: "chatgpt,gemini" },
  runs: { type: "string", default: "1" },
  "use-proxy": { type: "boolean", default: false },
  window: { type: "string", default: "visible" },
  gap: { type: "string", default: "20-40" },
  retries: { type: "string", default: "2" },
  timeout: { type: "string", default: "240" },
  limit: { type: "string" },
  out: { type: "string" },
  label: { type: "string" },
} as const;
const { values: a, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
stopIfNpmTookFlags("ask", "src/answers/cli.ts", Object.keys(OPTIONS), positionals);
const USE_PROXY = a["use-proxy"];

const ENGINES = a.engines.split(",").map((e) => e.trim()).filter(Boolean) as AnswerEngine[];
for (const e of ENGINES) if (e !== "chatgpt" && e !== "gemini") throw new Error(`unknown engine "${e}" (chatgpt, gemini)`);
const RUNS = Number(a.runs);
const RETRIES = Number(a.retries);
const TIMEOUT_MS = Number(a.timeout) * 1000;
const [GAP_MIN, GAP_MAX] = ((): [number, number] => {
  const [x, y] = a.gap.split("-").map(Number);
  return [x * 1000, (Number.isFinite(y) ? y : x) * 1000];
})();
const STOP_AFTER = 3; // consecutive blocked / rate-limited questions before an app is left alone
const HARD: ErrorCode[] = ["blocked", "rate_limited", "login_required"];

type Prompt = { id: string; prompt: string };

function readPrompts(): Prompt[] {
  const list: Prompt[] = [];
  for (const p of a.prompt ?? []) list.push({ id: "", prompt: p });
  if (a.prompts) {
    const text = readFileSync(a.prompts, "utf8");
    for (const [i, ln] of text.split(/\r?\n/).entries()) {
      const t = ln.trim();
      if (!t || t.startsWith("#")) continue;
      if (a.prompts.endsWith(".jsonl")) {
        const o = JSON.parse(t) as { id?: string | number; prompt?: string };
        if (!o.prompt) throw new Error(`${a.prompts}:${i + 1} has no "prompt"`);
        list.push({ id: o.id === undefined ? "" : String(o.id), prompt: o.prompt });
      } else list.push({ id: "", prompt: t });
    }
  }
  list.forEach((p, i) => (p.id ||= `p${String(i + 1).padStart(3, "0")}`));
  const ids = new Set<string>();
  for (const p of list) {
    if (ids.has(p.id)) throw new Error(`prompt id "${p.id}" appears twice`);
    ids.add(p.id);
  }
  return a.limit ? list.slice(0, Number(a.limit)) : list;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
const fileId = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_");
const keyOf = (j: AskJob) => `${j.engine}|${j.index}|r${j.run}`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

type IndexLine = {
  key: string; engine: AnswerEngine; id: string; run: number; attempt: number; status: "ok" | "error";
  error_code: ErrorCode | null; error: string | null; chars: number; citations: number; search_sources: number | null;
  sources_for_collector: number; shopping: number; web_search: boolean | null; model: string | null; location: string | null;
  screenshot: string | null; row: string; sent_at: string; ms: number; warnings: string[];
};

async function main(): Promise<number> {
  const prompts = readPrompts();
  if (!prompts.length) throw new Error("no prompts: use --prompt \"...\" or --prompts <file>");
  const out = resolve(a.out ?? join(PATHS.output, "answers", `${stamp()}-${a.label ?? (USE_PROXY ? "proxy" : "direct")}`));
  mkdirSync(out, { recursive: true });
  const indexFile = join(out, "index.jsonl");
  const done = new Map<string, IndexLine>();
  if (existsSync(indexFile)) {
    for (const ln of readFileSync(indexFile, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      const e = JSON.parse(ln) as IndexLine;
      done.set(e.key, e);
    }
  }

  const jobs: AskJob[] = [];
  for (let run = 1; run <= RUNS; run++) for (const p of prompts) for (const engine of ENGINES) jobs.push({ engine, prompt: p.prompt, index: p.id, run });
  const pending = jobs.filter((j) => done.get(keyOf(j))?.status !== "ok");
  console.log(`[ask] ${prompts.length} prompts × ${ENGINES.join(", ")} × ${RUNS} run(s) = ${jobs.length} answers, ${pending.length} to ask · ${USE_PROXY ? "through the proxy" : "direct, this PC's own IP"} · ${out}`);

  const awake = await keepAwake();
  const results = await Promise.all(ENGINES.map((engine) => worker(engine, pending.filter((j) => j.engine === engine), out, indexFile)));
  awake.release();

  const final = new Map<string, IndexLine>();
  for (const ln of readFileSync(indexFile, "utf8").split("\n")) if (ln.trim()) { const e = JSON.parse(ln) as IndexLine; final.set(e.key, e); }
  const summary = ENGINES.map((engine) => {
    const lines = jobs.map((j) => final.get(keyOf(j))).filter((e): e is IndexLine => !!e && e.engine === engine);
    const ok = lines.filter((e) => e.status === "ok");
    const r = results.find((x) => x.engine === engine)!;
    const codes: Record<string, number> = {};
    for (const e of lines) if (e.error_code) codes[e.error_code] = (codes[e.error_code] ?? 0) + 1;
    const median = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0);
    return {
      engine,
      asked: jobs.filter((j) => j.engine === engine).length,
      ok: ok.length,
      failed: lines.length - ok.length,
      not_asked: jobs.filter((j) => j.engine === engine).length - lines.length,
      errors: codes,
      median_seconds: Math.round(median(ok.map((e) => e.ms)) / 1000),
      web_search: ok.filter((e) => e.web_search).length,
      with_citations: ok.filter((e) => e.citations > 0).length,
      with_shopping: ok.filter((e) => e.shopping > 0).length,
      with_warnings: ok.filter((e) => e.warnings.length).length,
      models: [...new Set(ok.map((e) => e.model).filter(Boolean))],
      locations: [...new Set(ok.map((e) => e.location).filter(Boolean))],
      proxy_mb: r.proxyBytes ? +(r.proxyBytes / 1e6).toFixed(1) : null,
      proxy_mb_per_answer: r.proxyBytes && r.asked ? +(r.proxyBytes / 1e6 / r.asked).toFixed(2) : null,
      stopped: r.stopped,
    };
  });
  writeFileSync(join(out, "summary.json"), JSON.stringify({ finishedAt: new Date().toISOString(), proxy: USE_PROXY, summary }, null, 2));
  console.log("\n[ask] done");
  for (const s of summary) {
    console.log(`  ${s.engine.padEnd(8)} ${s.ok}/${s.asked} ok${s.failed ? `, ${s.failed} failed ${JSON.stringify(s.errors)}` : ""}${s.not_asked ? `, ${s.not_asked} not asked` : ""} · median ${s.median_seconds}s · web search ${s.web_search} · citations ${s.with_citations} · shopping ${s.with_shopping} · warnings ${s.with_warnings}${s.models.length ? ` · model ${s.models.join("/")}` : ""}${s.locations.length ? ` · placed in ${s.locations.join(" / ")}` : ""}${s.proxy_mb !== null ? ` · proxy ${s.proxy_mb} MB (${s.proxy_mb_per_answer} MB/answer)` : ""}${s.stopped ? ` · STOPPED: ${s.stopped}` : ""}`);
  }
  console.log(`  → ${out}`);
  return summary.some((s) => s.ok < s.asked) ? 1 : 0;
}

async function worker(engine: AnswerEngine, jobs: AskJob[], out: string, indexFile: string): Promise<{ engine: AnswerEngine; asked: number; proxyBytes: number; stopped: string | null }> {
  if (!jobs.length) return { engine, asked: 0, proxyBytes: 0, stopped: null };
  let s: EngineSession;
  try {
    s = await openEngine(engine, { proxy: USE_PROXY, window: a.window as "offscreen" | "visible" });
  } catch (e) {
    console.error(`[${engine}] could not start: ${firstLine(e)}`);
    return { engine, asked: 0, proxyBytes: 0, stopped: `could not start: ${firstLine(e)}` };
  }
  const ask = engine === "chatgpt" ? askChatGPT : askGemini;
  let asked = 0, hardInARow = 0, stopped: string | null = null;
  try {
    for (const [n, job] of jobs.entries()) {
      const base = `${fileId(job.index ?? "")}-r${job.run}`;
      const rowRel = `rows/${engine}/${base}.json`;
      for (let attempt = 1; attempt <= 1 + RETRIES; attempt++) {
        const ctx: AskContext = {
          attempt,
          country: s.proxy?.country ?? null,
          shot: { rel: `screenshots/${engine}/${base}.jpg`, abs: join(out, "screenshots", engine, `${base}.jpg`) },
          timeoutMs: TIMEOUT_MS,
        };
        mkdirSync(dirname(ctx.shot.abs), { recursive: true });
        let row: AnswerRow;
        try {
          // The drivers bound every wait; this bounds the attempt as a whole.
          row = await within(ask(s, job, ctx), TIMEOUT_MS + 180_000, `the ${engine} attempt`);
        } catch (e) {
          row = newRow(s, job, ctx, "", new Date());
          row.error_code = "internal";
          row.error = firstLine(e).slice(0, 500);
          await s.renew().catch((e2) => console.error(`[${engine}] could not open a fresh tab: ${firstLine(e2)}`));
        }
        asked++;
        mkdirSync(dirname(join(out, rowRel)), { recursive: true });
        writeFileSync(join(out, rowRel), JSON.stringify(row, null, 2));
        const line: IndexLine = {
          key: keyOf(job), engine, id: job.index ?? "", run: job.run, attempt, status: row.error_code ? "error" : "ok",
          error_code: row.error_code, error: row.error, chars: row.answer_text.length, citations: row.citations.length,
          search_sources: row.search_sources?.length ?? null, sources_for_collector: collectorSources(row).length,
          shopping: row.shopping.length, web_search: row.web_search_triggered, model: row.model, location: row.capture.ip_location,
          screenshot: row.capture.screenshot, row: rowRel, sent_at: row.prompt_sent_at, ms: row.capture.timings.ms, warnings: row.capture.warnings,
        };
        appendFileSync(indexFile, JSON.stringify(line) + "\n");
        console.log(
          row.error_code
            ? `[${engine}] ${job.index} r${job.run} attempt ${attempt}: ${row.error_code} · ${row.error}`
            : `[${engine}] ${job.index} r${job.run} ok ${secs(line.ms)} · ${line.chars} chars · ${line.citations} citations · ${line.search_sources ?? "?"} searched · ${line.shopping} products · web search ${row.web_search_triggered ?? "?"}${row.model ? ` · ${row.model}` : ""}${line.location ? ` · ${line.location}` : ""}${line.warnings.length ? ` · ⚠ ${line.warnings.join("; ")}` : ""}`,
        );
        if (!row.error_code) {
          hardInARow = 0;
          break;
        }
        if (HARD.includes(row.error_code)) hardInARow++;
        if (hardInARow >= STOP_AFTER) break;
        if (attempt <= RETRIES) {
          const wait = HARD.includes(row.error_code) ? rand(180, 360) * 1000 * attempt : rand(30, 60) * 1000;
          console.log(`[${engine}] waiting ${secs(wait)} before trying again`);
          await sleep(wait);
        }
      }
      if (hardInARow >= STOP_AFTER) {
        stopped = `${STOP_AFTER} attempts in a row were blocked, rate-limited or asked to sign in`;
        console.log(`[${engine}] stopping: ${stopped}`);
        break;
      }
      if (n < jobs.length - 1) await sleep(rand(GAP_MIN, GAP_MAX));
    }
  } finally {
    await s.close();
  }
  // The relay counts a connection's bytes when it closes, so read the total after closing.
  return { engine, asked, proxyBytes: s.relay?.bytes() ?? 0, stopped };
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
