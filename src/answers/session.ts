// One browser per app: its own Chrome profile (answers-chatgpt, answers-gemini), its own sticky
// IPRoyal session when --use-proxy is on (so each app keeps one US address for the day), and a
// network tap on the requests that carry the answer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "patchright";
import { launch } from "../browser/launch";
import { sessionId, startRelay, upstreamUrl, type Relay } from "../browser/proxy";
import { PATHS, proxySettings } from "../config";
import { NetworkTap } from "./tap";
import type { AnswerEngine } from "./types";

export type EngineSession = {
  engine: AnswerEngine;
  profile: string;
  context: BrowserContext;
  page: Page;
  tap: NetworkTap;
  relay: Relay | null;
  proxy: { country: string; session: string } | null;
  versions: { patchright: string; chrome: string | null };
  /** Swaps in a fresh tab (and tap) for a page that stopped answering. */
  renew(): Promise<void>;
  close(): Promise<void>;
};

/** The requests whose bodies carry the answer. */
const ANSWER_REQUESTS: Record<AnswerEngine, (url: string, method: string) => boolean> = {
  chatgpt: (url, method) => method === "POST" && /\/conversation\/updates|\/backend-(?:anon|api)\/(?:f\/)?conversation(?:\?|$)/.test(url),
  gemini: (url, method) => (method === "GET" && /\/processSession\?/.test(url) && /[?&]TYPE=xmlhttp/.test(url)) || /StreamGenerate/.test(url),
};

const PATCHRIGHT = (JSON.parse(readFileSync(join(PATHS.root, "node_modules", "patchright", "package.json"), "utf8")) as { version: string }).version;

/** Visible windows (about 1295 px wide with their frame) open offset on a 1536-px-wide screen, so both title bars show. */
const POSITION: Record<AnswerEngine, { x: number; y: number }> = { chatgpt: { x: 0, y: 0 }, gemini: { x: 240, y: 0 } };

export async function openEngine(engine: AnswerEngine, o: { proxy: boolean; window?: "offscreen" | "visible"; profile?: string }): Promise<EngineSession> {
  const profile = o.profile ?? `answers-${engine}`;
  let relay: Relay | null = null;
  let proxy: EngineSession["proxy"] = null;
  if (o.proxy) {
    const p = proxySettings();
    if (!p) throw new Error("--use-proxy needs PROXY_USERNAME and PROXY_PASSWORD in .env");
    const session = sessionId(profile);
    relay = await startRelay(upstreamUrl(p, session));
    proxy = { country: p.country.toUpperCase(), session };
  }
  // Through the proxy the page presents US time; without it, this PC's own time, matching its own IP.
  const context = await launch({ profile, proxyUrl: relay?.url, timezone: o.proxy ? "emulate" : "none", window: o.window ?? "visible", position: POSITION[engine] });
  const page = context.pages()[0] ?? (await context.newPage());
  const tap = new NetworkTap(page, ANSWER_REQUESTS[engine]);
  await tap.start();
  let chrome: string | null = null;
  try {
    const cdp = await context.newCDPSession(page);
    chrome = (await cdp.send("Browser.getVersion")).product.replace(/^[^/]*\//, "");
    await cdp.detach();
  } catch {
    chrome = null;
  }
  const s: EngineSession = {
    engine,
    profile,
    context,
    page,
    tap,
    relay,
    proxy,
    versions: { patchright: PATCHRIGHT, chrome },
    async renew() {
      const old = s.page;
      await s.tap.stop();
      s.page = await context.newPage(); // opened before the old tab closes, so the window stays
      await old.close().catch(() => {});
      s.tap = new NetworkTap(s.page, ANSWER_REQUESTS[engine]);
      await s.tap.start();
    },
    async close() {
      await s.tap.stop();
      await context.close().catch(() => {});
      await relay?.close();
    },
  };
  return s;
}

/** Rejects when `p` has not settled within `ms`. */
export async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** page.evaluate with a deadline: it has none of its own, and a page stuck mid-navigation never answers. */
export const evalIn = <T>(page: Page, js: string, ms = 15_000): Promise<T> => within(page.evaluate(js) as Promise<T>, ms, "the page");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
export const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split(/\r?\n/)[0];

/** Types like a person: uneven gaps between keys, longer after spaces; Shift+Enter for line breaks. */
export async function humanType(page: Page, text: string): Promise<void> {
  for (const ch of text) {
    if (ch === "\n") await page.keyboard.press("Shift+Enter");
    else await page.keyboard.type(ch);
    await sleep(ch === " " ? rand(45, 150) : rand(15, 70));
  }
}
