// Asks gemini.google.com one question, logged out, in a new chat: opens /app, types the question
// into the prompt box like a person and sends it. Reads the answer from the page and the cited
// sources, search results and inferred location from Gemini's answer stream. Gemini names its
// model on the page (the mode button, "Flash-Lite" when logged out on 3 Nov 2026).

import { parseGeminiStream } from "./gemini-stream";
import { GEMINI_EXTRACT_JS, GEMINI_STATE_JS, type GeminiPage, type GeminiState } from "./page-scripts";
import { blockerCode, blockers, check, fail, letters, newRow, type AskContext } from "./row";
import { captureConversation } from "./screenshot";
import { evalIn, firstLine, humanType, rand, sleep, within, type EngineSession } from "./session";
import { NetworkTap } from "./tap";
import { ENGINE_HOME, type AnswerRow, type AskJob } from "./types";

const EDITOR = "rich-textarea [contenteditable='true']";
const ANSWER_ERROR = /^(something went wrong|sorry, something went wrong|i'm having a hard time fulfilling|an error occurred|there was a problem)/i;

const state = (s: EngineSession) => evalIn<GeminiState>(s.page, GEMINI_STATE_JS);

export async function askGemini(session: EngineSession, job: AskJob, ctx: AskContext): Promise<AnswerRow> {
  // This attempt keeps the tab it started with (see askChatGPT).
  const s: EngineSession = { ...session };
  s.tap.reset();
  const t0 = Date.now();
  const row = newRow(s, job, ctx, ENGINE_HOME.gemini, new Date());

  try {
    await s.page.goto(ENGINE_HOME.gemini, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    return fail(s, row, ctx, "navigation", `gemini.google.com did not load: ${firstLine(e)}`);
  }
  for (;;) {
    const st = await state(s).catch(() => null);
    if (st?.editor) break;
    if (Date.now() - t0 > 40_000) return fail(s, row, ctx, blockerCode(await blockers(s.page)) ?? "navigation", "the prompt box never appeared");
    await sleep(1000);
  }
  await sleep(rand(800, 1800));

  await s.page.click(EDITOR, { timeout: 10_000 });
  await humanType(s.page, job.prompt);
  await sleep(rand(300, 800));
  const sentAt = new Date();
  row.prompt_sent_at = sentAt.toISOString();
  row.capture.timings.sent_at = sentAt.toISOString();
  await s.page.keyboard.press("Enter");

  // The question shows up on the page; if Enter did not send it, press the send button.
  for (let pressed = false; ; ) {
    await sleep(1000);
    const st = await state(s).catch(() => null);
    if ((st?.users ?? 0) > 0) break;
    if (!pressed && Date.now() - sentAt.getTime() > 5000) {
      await s.page.click("button[aria-label='Send message']", { timeout: 5000 }).catch(() => {});
      pressed = true;
    }
    if (Date.now() - sentAt.getTime() > 25_000) return fail(s, row, ctx, blockerCode(await blockers(s.page)) ?? "no_answer", "the question was never sent");
  }

  // Wait for the answer: no "Stop response" button, nothing busy in the response, its action bar
  // shown, and the text unchanged for 2 s.
  let last = -1, stableAt = Date.now();
  const deadline = Date.now() + ctx.timeoutMs;
  for (;;) {
    await sleep(1000);
    const st = await state(s).catch(() => null);
    if (!st) continue;
    if (st.chars > 0 && !row.capture.timings.first_text_at) row.capture.timings.first_text_at = new Date().toISOString();
    if (st.chars !== last) {
      last = st.chars;
      stableAt = Date.now();
    }
    if (st.responses > 0 && st.chars > 0 && st.busy === 0 && st.actions && !st.stop && Date.now() - stableAt >= 2000) break;
    if (!st.stop && st.chars < 400 && ANSWER_ERROR.test(st.head.trim()) && Date.now() - stableAt > 3000) {
      return fail(s, row, ctx, "answer_error", `Gemini answered with an error: ${st.head.trim().slice(0, 200)}`);
    }
    if (Date.now() > deadline) {
      if (st.chars > 200 && !st.stop && Date.now() - stableAt > 15_000) {
        row.capture.warnings.push("no completion mark before the deadline; took the answer as shown");
        break;
      }
      return fail(s, row, ctx, blockerCode(await blockers(s.page)) ?? "no_answer", `no complete answer after ${Math.round(ctx.timeoutMs / 1000)} s (${st.chars} chars on the page)`);
    }
  }
  row.capture.timings.complete_at = new Date().toISOString();
  await sleep(1000); // the last stream frames trail the page by a moment

  const pg = await evalIn<GeminiPage>(s.page, GEMINI_EXTRACT_JS, 30_000);
  if (!pg.found) return fail(s, row, ctx, "no_answer", "the answer element was not found");

  const bodies = s.tap.list().map((t) => NetworkTap.text(t)).filter(Boolean);
  const stream = bodies.length ? parseGeminiStream(bodies, pg.responseId) : null;
  const parsed = !!stream && !!stream.responseId;

  row.url = pg.url;
  row.answer_text = pg.text;
  if (stream?.markdown && letters(pg.text).includes(letters(stream.markdown).slice(0, 40))) {
    row.answer_text_markdown = stream.markdown;
    row.capture.markdown_from = "stream";
  } else {
    row.answer_text_markdown = pg.markdown || null;
    row.capture.markdown_from = pg.markdown ? "page" : null;
    if (stream?.markdown) row.capture.warnings.push("stream markdown does not match the page; used the page's");
  }
  row.answer_html = await within(s.page.content(), 30_000, "the page");
  row.answer_section_html = pg.html;
  row.citations = stream?.citations ?? [];
  row.links_attached = pg.links.filter((l) => !l.internal).map((l, i) => ({ url: l.url, text: l.text, position: i }));
  row.search_sources = parsed ? stream!.searchSources : null;
  row.shopping = pg.cards;
  row.shopping_visible = pg.cards.length > 0;
  row.web_search_triggered = parsed ? stream!.searched : pg.footnotes > 0 ? true : null;
  row.model = pg.model;
  row.response_raw = bodies.join("\n") || null;
  row.timestamp = row.capture.timings.complete_at;

  row.capture.ip_location = stream?.location ?? null;
  row.capture.conversation_id = stream?.conversationId ?? /\/app\/([0-9a-f]+)/.exec(pg.url)?.[1] ?? null;
  row.capture.message_id = pg.responseId;
  row.capture.footnotes = pg.footnotes;
  if (!bodies.length) row.capture.warnings.push("answer stream not captured: no citations, search results or location");
  else if (!parsed) row.capture.warnings.push("answer stream captured but not readable (format changed?)");
  else if (pg.responseId && stream!.responseId !== pg.responseId) row.capture.warnings.push(`stream answer ${stream!.responseId} is not the page's ${pg.responseId}`);

  try {
    const shot = await captureConversation(s.page, ctx.shot.abs, { scroller: "infinite-scroller.chat-history" });
    row.capture.screenshot = ctx.shot.rel;
    if (shot.clipped) row.capture.warnings.push(`screenshot cut at ${shot.height}px`);
  } catch (e) {
    row.capture.warnings.push(`screenshot failed: ${firstLine(e)}`);
  }
  row.capture.timings.ms = Date.now() - t0;
  check(row);
  return row;
}
