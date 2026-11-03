// What a website's own scripts can see about this browser, read in the page's main
// world (where site scripts run), plus a background worker's view, which must agree
// with the page. Then pass/fail rules for the things bot detectors check first.
//
// The in-page code is a plain JavaScript string: tsx adds helper calls to named
// functions, which would break code serialized into the page.

import type { Page } from "patchright";

export type WorkerView = { userAgent: string; languages: string[]; timezone: string; cores: number; platform: string; webdriver: unknown };

export type IdentityProbe = {
  webdriver: unknown;
  userAgent: string;
  brands: Array<{ brand: string; version: string }> | null;
  chromeVersion: string | null;
  platform: string;
  uaPlatform: string | null;
  language: string;
  languages: string[];
  cores: number;
  memory: number | null;
  plugins: number;
  chromeObject: string;
  notification: string | null;
  permissionQuery: string | null;
  timezone: string;
  offsetMinutes: number;
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number };
  dpr: number;
  inner: [number, number];
  outer: [number, number];
  screenXY: [number, number];
  visibility: string;
  hasFocus: boolean;
  webgl: { vendor: string; renderer: string } | null;
  worker: WorkerView | { error: string } | null;
};

const PROBE = `(async () => {
  const nav = navigator;
  const uad = nav.userAgentData;
  let high = null;
  try { high = uad ? await uad.getHighEntropyValues(["platform", "fullVersionList"]) : null; } catch (e) {}
  let permissionQuery = null;
  try { permissionQuery = (await navigator.permissions.query({ name: "notifications" })).state; } catch (e) {}
  let webgl = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) webgl = { vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) };
  } catch (e) {}
  const src = "onmessage=()=>postMessage({userAgent:navigator.userAgent,languages:[...navigator.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency,platform:navigator.platform,webdriver:navigator.webdriver})";
  const worker = await new Promise((resolve) => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      const t = setTimeout(() => { w.terminate(); resolve(null); }, 4000);
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data); };
      w.onerror = (e) => { clearTimeout(t); resolve({ error: String(e.message || "worker error") }); };
      w.postMessage(0);
    } catch (e) { resolve({ error: String(e) }); }
  });
  const chrome = high && high.fullVersionList ? high.fullVersionList.find((b) => b.brand === "Google Chrome") : null;
  return {
    webdriver: nav.webdriver,
    userAgent: nav.userAgent,
    brands: uad ? uad.brands : null,
    chromeVersion: chrome ? chrome.version : null,
    platform: nav.platform,
    uaPlatform: high ? high.platform : null,
    language: nav.language,
    languages: [...nav.languages],
    cores: nav.hardwareConcurrency,
    memory: nav.deviceMemory ?? null,
    plugins: nav.plugins.length,
    chromeObject: typeof window.chrome,
    notification: typeof Notification === "undefined" ? null : Notification.permission,
    permissionQuery,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date().getTimezoneOffset(),
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
    dpr: devicePixelRatio,
    inner: [innerWidth, innerHeight],
    outer: [outerWidth, outerHeight],
    screenXY: [screenX, screenY],
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    webgl,
    worker,
  };
})()`;

/** Reads the probe in the page's main world (isolatedContext = false), as site scripts would see it. */
export async function readIdentity(page: Page): Promise<IdentityProbe> {
  return (await page.evaluate(PROBE, undefined, undefined, false)) as IdentityProbe;
}

export type Check = { check: string; ok: boolean; detail: string };

/** `timezone` null skips the timezone rule (when no timezone is being presented on purpose). */
export function checkIdentity(p: IdentityProbe, expect: { timezone: string | null; locale: string }): Check[] {
  const w = p.worker && !("error" in p.worker) ? p.worker : null;
  const c = (check: string, ok: boolean, detail: string): Check => ({ check, ok, detail });
  return [
    c("navigator.webdriver is false", p.webdriver === false, String(p.webdriver)),
    c("user agent is not headless", !/headless/i.test(p.userAgent), p.userAgent),
    c("brands include Google Chrome", !!p.brands?.some((b) => b.brand === "Google Chrome"), (p.brands ?? []).map((b) => `${b.brand} ${b.version}`).join(", ")),
    c("window.chrome exists", p.chromeObject === "object", p.chromeObject),
    c("PDF plugins present", p.plugins > 0, String(p.plugins)),
    c("notification permission is consistent", !(p.notification === "denied" && p.permissionQuery === "prompt"), `${p.notification} / query ${p.permissionQuery}`),
    // Real Chrome has no navigator.webdriver inside workers, so the worker must show undefined (or false), never true.
    c("worker sees the same browser", !!w && w.userAgent === p.userAgent && w.platform === p.platform && w.webdriver !== true, w ? `${w.platform}, worker webdriver ${String(w.webdriver)}` : JSON.stringify(p.worker)),
    c("worker sees the same timezone", !!w && w.timezone === p.timezone, w ? `page ${p.timezone} / worker ${w.timezone}` : "-"),
    c("worker sees the same languages", !!w && w.languages.join(",") === p.languages.join(","), w ? `page ${p.languages.join(",")} / worker ${w.languages.join(",")}` : "-"),
    ...(expect.timezone ? [c(`timezone is ${expect.timezone}`, p.timezone === expect.timezone, p.timezone)] : []),
    c(`first language is ${expect.locale}`, p.languages[0] === expect.locale, p.languages.join(", ")),
    c("window fits on the screen", p.outer[0] <= p.screen.width && p.outer[1] <= p.screen.height, `window ${p.outer.join("x")} / screen ${p.screen.width}x${p.screen.height}`),
    c("page counts as visible", p.visibility === "visible", p.visibility),
  ];
}
