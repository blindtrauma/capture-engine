// Asks chatgpt.com one question, logged out, the way Bright Data's ChatGPT scraper did
// (https://chatgpt.com/?q=<prompt> with web search on: &hints=search, ChatGPT's own link format),
// and reads the answer from the page and from ChatGPT's answer stream. Every question starts a
// new conversation.

import { answerMessage, compactChatGPTStream, messageCitations, messageEntities, messageMarkdown, parseChatGPTStream } from "./chatgpt-stream";
import { CHATGPT_EXTRACT_JS, CHATGPT_STATE_JS, type ChatGPTPage, type ChatGPTState } from "./page-scripts";
import { blockerCode, blockers, check, fail, letters, newRow, type AskContext } from "./row";
import { captureConversation } from "./screenshot";
import { evalIn, firstLine, humanType, rand, sleep, within, type EngineSession } from "./session";
import { NetworkTap } from "./tap";
import { ENGINE_HOME, type AnswerRow, type AskJob, type Citation } from "./types";

const ANSWER_ERROR = /^(something went wrong|there was an error|an error occurred|network error|unusual activity|hmm\.\.\.something seems to have gone wrong|request timed out|chatgpt is temporarily experiencing issues)/i;
/** Presses of ChatGPT's own Retry button before the attempt is given up (a person would try it). */
const RETRY_PRESSES = 2;

const state = (s: EngineSession) => evalIn<ChatGPTState>(s.page, CHATGPT_STATE_JS);

/** Logged-out ChatGPT can ask to log in after a few chats; "Stay logged out" closes it. */
async function dismissLoginPrompt(s: EngineSession, row: AnswerRow): Promise<void> {
  const stay = s.page.getByText(/^stay logged out$/i).first();
  if (!(await stay.isVisible().catch(() => false))) return;
  await stay.click({ timeout: 3000 }).catch(() => {});
  if (!row.capture.warnings.includes("closed a log-in prompt")) row.capture.warnings.push("closed a log-in prompt");
}

export async function askChatGPT(session: EngineSession, job: AskJob, ctx: AskContext): Promise<AnswerRow> {
  // This attempt keeps the tab it started with: if the runner gives up on it and swaps in a
  // fresh tab, whatever is still running here fails on the closed one instead of the new one.
  const s: EngineSession = { ...session };
  const link = `${ENGINE_HOME.chatgpt}?q=${encodeURIComponent(job.prompt)}&hints=search`;
  s.tap.reset();
  const sentAt = new Date();
  const row = newRow(s, job, ctx, link, sentAt);
  const t0 = Date.now();

  try {
    await s.page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    return fail(s, row, ctx, "navigation", `chatgpt.com did not load: ${firstLine(e)}`);
  }

  // The link sends the question by itself. If it has not gone out after 12 s (no question on the
  // page, no answer request), type it into the composer instead.
  let typed = false;
  for (;;) {
    await dismissLoginPrompt(s, row);
    const st = await state(s).catch(() => null);
    if ((st?.users ?? 0) > 0 || s.tap.list().length) break;
    const b = await blockers(s.page);
    if (!b?.challenge && !b?.captcha && !typed && st?.composer && Date.now() - t0 > 12_000) {
      await s.page.click("textarea[name='prompt'], #prompt-textarea", { timeout: 10_000 }).catch(() => {});
      await s.page.keyboard.press("Control+A");
      await s.page.keyboard.press("Delete");
      await humanType(s.page, job.prompt);
      await sleep(400);
      await s.page.keyboard.press("Enter");
      typed = true;
      row.capture.warnings.push("the link did not send the question; typed it");
    }
    if (Date.now() - t0 > 45_000) return fail(s, row, ctx, blockerCode(b) ?? "no_answer", "the question was never sent");
    await sleep(1000);
  }

  // Wait for the answer: the page marks it complete, the stop button is gone, the answer stream
  // has ended and the text has not changed for 2 s. An error box with a Retry button gets the
  // button pressed, as a person would, up to RETRY_PRESSES times.
  let last = -1, stableAt = Date.now(), presses = 0;
  let deadline = Date.now() + ctx.timeoutMs;
  for (;;) {
    await sleep(1000);
    const st = await state(s).catch(() => null);
    if (!st) continue;
    if (st.errorCard && !st.stop && st.chars < 400) {
      if (presses >= RETRY_PRESSES) return fail(s, row, ctx, "answer_error", `ChatGPT showed "${st.errorCard}" again after ${presses} presses of Retry`);
      await sleep(rand(2500, 5000));
      const pressed = await s.page.getByRole("button", { name: /^(retry|try again)$/i }).last().click({ timeout: 5000 }).then(() => true, () => false);
      if (!pressed) return fail(s, row, ctx, "answer_error", `ChatGPT showed "${st.errorCard}" and its Retry button could not be pressed`);
      presses++;
      row.capture.warnings.push(`ChatGPT showed "${st.errorCard.slice(0, 160)}"; pressed Retry (${presses})`);
      last = -1;
      stableAt = Date.now();
      deadline = Math.max(deadline, Date.now() + ctx.timeoutMs / 2);
      continue;
    }
    if (st.chars > 0 && !row.capture.timings.first_text_at) row.capture.timings.first_text_at = new Date().toISOString();
    if (st.chars !== last) {
      last = st.chars;
      stableAt = Date.now();
    }
    const streamDone = s.tap.list().every((t) => t.finishedAt);
    if (st.complete && !st.stop && Date.now() - stableAt >= 2000) {
      if (streamDone) break;
      if (Date.now() - stableAt >= 10_000) {
        row.capture.warnings.push("an answer request was still open 10 s after the page finished; took the stream as received");
        break;
      }
    }
    if (!st.stop && st.chars < 400 && ANSWER_ERROR.test(st.head.trim()) && Date.now() - stableAt > 3000) {
      return fail(s, row, ctx, "answer_error", `ChatGPT answered with an error: ${st.head.trim().slice(0, 200)}`);
    }
    if (Date.now() > deadline) {
      if (st.chars > 200 && !st.stop && Date.now() - stableAt > 15_000) {
        row.capture.warnings.push("no completion mark before the deadline; took the answer as shown");
        break;
      }
      const b = await blockers(s.page);
      return fail(s, row, ctx, blockerCode(b) ?? "no_answer", `no complete answer after ${Math.round(ctx.timeoutMs / 1000)} s (${st.chars} chars on the page)`);
    }
  }
  row.capture.timings.complete_at = new Date().toISOString();
  await dismissLoginPrompt(s, row);

  const pg = await evalIn<ChatGPTPage>(s.page, CHATGPT_EXTRACT_JS, 30_000);
  if (!pg.found) return fail(s, row, ctx, "no_answer", "the answer element was not found");

  const raw = s.tap.list().map((t) => NetworkTap.text(t)).filter(Boolean).join("\n");
  const stream = raw ? parseChatGPTStream(raw) : null;
  const msg = stream ? answerMessage(stream, pg.messageId) : null;
  const streamMd = msg ? messageMarkdown(msg) : null;

  row.url = pg.url;
  row.answer_text = pg.text;
  if (streamMd && letters(streamMd).slice(0, 40) && letters(pg.text).includes(letters(streamMd).slice(0, 40))) {
    row.answer_text_markdown = streamMd;
    row.capture.markdown_from = "stream";
  } else {
    row.answer_text_markdown = pg.markdown || null;
    row.capture.markdown_from = pg.markdown ? "page" : null;
    if (streamMd) row.capture.warnings.push("stream markdown does not match the page; used the page's");
  }
  row.answer_html = await within(s.page.content(), 30_000, "the page");
  row.answer_section_html = pg.html;

  const external = pg.links.filter((l) => !l.internal);
  let citations: Citation[] = msg ? messageCitations(msg) : [];
  if (!stream) {
    // No stream: the source chips on the page are the citations.
    citations = external.map((l, i) => ({ url: l.url, title: l.text, description: null, source: null, date: null, cited_text: [], position: i + 1 }));
  }
  row.citations = citations;
  row.links_attached = external.map((l, i) => ({ url: l.url, text: l.text, position: i }));
  row.search_sources = stream ? stream.searchSources : null;
  // A card with no price counts when ChatGPT marked its name as a product (or, without the
  // stream, when the name is a product link on the page).
  const entities = msg ? messageEntities(msg) : [];
  const products = new Set(entities.map((e) => e.toLowerCase()));
  row.shopping = pg.cards
    .filter((c) => c.price || products.has(c.title.toLowerCase()) || (!msg && c.named))
    .map(({ named: _named, ...c }) => c);
  row.shopping_visible = row.shopping.length > 0;
  const searchedOnPage = pg.reasoning.some((r) => /search/i.test(r));
  row.web_search_triggered = stream
    ? stream.searchSources.length > 0 || stream.activity.some((a) => /search/i.test(a)) || citations.length > 0 || searchedOnPage
    : (searchedOnPage || citations.length > 0) ? true : null;
  row.model = null; // logged-out ChatGPT names no model; the routing tags are in capture.model_detail
  row.ads = pg.ads.length ? pg.ads : null;
  row.response_raw = raw ? compactChatGPTStream(raw) : null;
  row.timestamp = row.capture.timings.complete_at;

  row.capture.conversation_id = stream?.conversationId ?? /\/uc\/([0-9a-f-]+)/.exec(pg.url)?.[1] ?? null;
  row.capture.message_id = pg.messageId;
  row.capture.model_detail = stream?.tags ?? null;
  row.capture.entities = entities;
  row.capture.reasoning = [...new Set([...(stream?.activity ?? []), ...pg.reasoning])];
  if (!stream) row.capture.warnings.push("answer stream not captured: citations from the page only, no search sources or routing tags");
  else if (!msg) row.capture.warnings.push("answer stream had no content for this message");
  else if (stream.terminal !== "complete") row.capture.warnings.push(`answer stream ended as ${stream.terminal ?? "unknown"}`);

  try {
    const shot = await captureConversation(s.page, ctx.shot.abs);
    row.capture.screenshot = ctx.shot.rel;
    if (shot.clipped) row.capture.warnings.push(`screenshot cut at ${shot.height}px`);
  } catch (e) {
    row.capture.warnings.push(`screenshot failed: ${firstLine(e)}`);
  }
  row.capture.timings.ms = Date.now() - t0;
  check(row);
  return row;
}
