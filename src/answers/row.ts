// Shared by both drivers: the row skeleton, the failure row (with a screenshot of what the page
// showed), and the checks every answer gets before it is written.

import type { Page } from "patchright";
import { BLOCKERS_JS, type BlockerState } from "./page-scripts";
import { captureConversation } from "./screenshot";
import { evalIn, firstLine, within, type EngineSession } from "./session";
import type { AnswerRow, AskJob, ErrorCode } from "./types";

export type AskContext = {
  attempt: number;
  /** the market asked from: the proxy's country, null without a proxy */
  country: string | null;
  shot: { abs: string; rel: string };
  timeoutMs: number;
};

export function newRow(s: EngineSession, job: AskJob, ctx: AskContext, inputUrl: string, sentAt: Date): AnswerRow {
  return {
    url: null,
    answer_url: null,
    prompt: job.prompt,
    index: job.index,
    country: ctx.country,
    input: { url: inputUrl, prompt: job.prompt, country: ctx.country, ...(job.engine === "chatgpt" ? { web_search: true } : {}) },
    prompt_sent_at: sentAt.toISOString(),
    timestamp: new Date().toISOString(),
    answer_text: "",
    answer_text_markdown: null,
    answer_html: null,
    answer_section_html: null,
    citations: [],
    links_attached: [],
    search_sources: null,
    shopping: [],
    shopping_visible: false,
    web_search_triggered: null,
    model: null,
    ads: null,
    response_raw: null,
    error: null,
    error_code: null,
    capture: {
      tool: "capture-engine",
      engine: job.engine,
      versions: s.versions,
      profile: s.profile,
      proxy: s.proxy,
      ip_location: null,
      conversation_id: null,
      message_id: null,
      model_detail: null,
      entities: [],
      markdown_from: null,
      reasoning: [],
      footnotes: null,
      screenshot: null,
      timings: { sent_at: sentAt.toISOString(), first_text_at: null, complete_at: null, ms: 0 },
      attempt: ctx.attempt,
      warnings: [],
    },
  };
}

export async function blockers(page: Page): Promise<BlockerState | null> {
  return evalIn<BlockerState>(page, BLOCKERS_JS).catch(() => null);
}

/** What a page that never produced an answer was showing, as an error code. */
export function blockerCode(b: BlockerState | null): ErrorCode | null {
  if (!b) return null;
  if (b.challenge || b.captcha) return "blocked";
  if (b.limit) return "rate_limited";
  if (b.signIn) return "login_required";
  return null;
}

/** Ends a row as a failure, keeping the page and a screenshot of it as evidence. */
export async function fail(s: EngineSession, row: AnswerRow, ctx: AskContext, code: ErrorCode, message: string): Promise<AnswerRow> {
  const b = await blockers(s.page);
  row.error_code = code;
  row.error = [message, b?.notices.length ? `page said: ${b.notices.join(" | ")}` : ""].filter(Boolean).join(" · ").slice(0, 1000);
  row.url = s.page.url();
  row.timestamp = new Date().toISOString();
  row.capture.timings.ms = Date.now() - Date.parse(row.prompt_sent_at);
  row.answer_html = await within(s.page.content(), 30_000, "the page").catch(() => null);
  try {
    await captureConversation(s.page, ctx.shot.abs, { maxHeight: 6000 });
    row.capture.screenshot = ctx.shot.rel;
  } catch (e) {
    row.capture.warnings.push(`screenshot failed: ${firstLine(e)}`);
  }
  return row;
}

const CHROME_TEXT = /(^|\n)(ChatGPT said:?|Gemini said|You said)\b|Worked for \d+\s?s\b|Stop generating|Stop response/;

/** Checks every answer gets; problems go into capture.warnings. */
export function check(row: AnswerRow): void {
  const w = row.capture.warnings;
  if (row.answer_text.length < 120) w.push(`short answer (${row.answer_text.length} chars)`);
  if (CHROME_TEXT.test(row.answer_text)) w.push("answer text contains app interface text");
  if (row.web_search_triggered && !row.citations.length && !(row.search_sources?.length)) w.push("web search shown but no sources read");
  if (row.capture.footnotes && !row.citations.length) w.push(`${row.capture.footnotes} footnotes on the page but no citations read`);
  if (row.country === "US" && row.capture.ip_location && !/united states|\busa?\b|, [A-Z]{2}$/i.test(row.capture.ip_location)) {
    w.push(`the app placed us in ${row.capture.ip_location}, not the US`);
  }
  if (!row.capture.screenshot) w.push("no screenshot");
}

/** Letters only, lower case: compares stream markdown with page text regardless of markup. */
export const letters = (s: string, n = 60) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^a-z]/gi, "").toLowerCase().slice(0, n);
