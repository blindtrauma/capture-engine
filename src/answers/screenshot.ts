// Screenshot of the whole conversation at the window's width. ChatGPT scrolls the document, but
// Gemini scrolls an inner panel, so a "full page" screenshot there stops at the window. Instead
// the viewport is grown (Chrome's device-metrics override) by however much the scrolling area
// overflows, captured at 1 CSS px per pixel, then put back. Runs after the answer is complete.

import { writeFileSync } from "node:fs";
import type { Page } from "patchright";
import { evalIn, within } from "./session";

const MEASURE_JS = (selector: string | null) => String.raw`(() => {
  var pick = ${JSON.stringify(selector)};
  var el = pick ? document.querySelector(pick) : null;
  if (!el) {
    var best = null;
    Array.prototype.forEach.call(document.querySelectorAll("*"), function (e) {
      var s = getComputedStyle(e);
      if (!/(auto|scroll)/.test(s.overflowY) || e.scrollHeight <= e.clientHeight + 4) return;
      if (!best || e.scrollHeight > best.scrollHeight) best = e;
    });
    var doc = document.scrollingElement || document.documentElement;
    el = best && best.scrollHeight - best.clientHeight > doc.scrollHeight - window.innerHeight ? best : doc;
  }
  var doc2 = document.scrollingElement || document.documentElement;
  var extra = el === doc2 ? doc2.scrollHeight - window.innerHeight : el.scrollHeight - el.clientHeight;
  return { width: window.innerWidth, height: window.innerHeight, extra: Math.max(0, extra) };
})()`;

const TO_TOP_JS = (selector: string | null) => String.raw`(() => {
  var el = ${JSON.stringify(selector)} ? document.querySelector(${JSON.stringify(selector)}) : null;
  if (el) el.scrollTop = 0;
  window.scrollTo(0, 0);
  return true;
})()`;

export type Shot = { width: number; height: number; clipped: boolean };

export async function captureConversation(page: Page, file: string, o: { scroller?: string; maxHeight?: number; quality?: number } = {}): Promise<Shot> {
  const selector = o.scroller ?? null;
  const m = await evalIn<{ width: number; height: number; extra: number }>(page, MEASURE_JS(selector));
  const want = m.height + m.extra;
  const height = Math.min(want, o.maxHeight ?? 15_000);
  const cdp = await page.context().newCDPSession(page);
  try {
    await within(cdp.send("Emulation.setDeviceMetricsOverride", { width: m.width, height, deviceScaleFactor: 1, mobile: false }), 15_000, "Chrome");
    await page.waitForTimeout(400);
    await evalIn(page, TO_TOP_JS(selector));
    await page.waitForTimeout(900);
    const shot = await within(cdp.send("Page.captureScreenshot", { format: "jpeg", quality: o.quality ?? 80 }), 60_000, "Chrome");
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return { width: m.width, height, clipped: want > height };
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}
