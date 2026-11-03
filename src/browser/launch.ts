// Launches real Google Chrome through Patchright the way Patchright recommends:
// a persistent profile, headed, no emulated viewport (the page is the real window),
// no custom user agent or headers. One profile directory per site, so a profile a
// site has flagged can be reset without touching the others.
//
// The options exist so the self-test can compare launch variants on this machine.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "patchright";
import { IDENTITY, PATHS } from "../config";

/** How the browser is given the US timezone: not at all, through Chrome's emulation, or through the TZ environment variable. */
export type TimezoneMode = "none" | "emulate" | "env";

export type LaunchOptions = {
  profile: string;
  proxyUrl?: string;
  timezone?: TimezoneMode;
  /** "visible" (default) shows the window; "offscreen" parks it outside the screen so it doesn't cover the desktop. */
  window?: "offscreen" | "visible";
  /** Where a visible window opens (screen pixels at 100%); Chrome's own placement when unset. */
  position?: { x: number; y: number };
  /** "native" is Patchright's recommendation (viewport null); "fixed" reproduces v1's emulated 1280x800 viewport. */
  viewport?: "native" | "fixed";
  /** Extra Chrome switches, for testing their effect. */
  flags?: string[];
};

// Window size in device-independent pixels. With no emulated viewport the page is as wide
// as the window (measured: 1296 wide window -> 1296 CSS px page), so 1280 gives v1's page
// width; 816 high fits this PC's 1536x864 screen (125% scaling) above the taskbar.
export const WINDOW = { width: 1280, height: 816 };

export function profileDir(profile: string): string {
  return join(PATHS.profiles, profile);
}

export async function launch(o: LaunchOptions): Promise<BrowserContext> {
  const dir = profileDir(o.profile);
  mkdirSync(dir, { recursive: true });
  // A Chrome that died uncleanly leaves these behind and refuses to start again.
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(dir, name), { force: true });

  const timezone = o.timezone ?? "emulate";
  const args = [`--window-size=${WINDOW.width},${WINDOW.height}`, `--lang=${IDENTITY.locale}`, ...(o.flags ?? [])];
  if (o.window === "offscreen") args.push("--window-position=-2400,-2400");
  else if (o.position) args.push(`--window-position=${o.position.x},${o.position.y}`);

  const context = await chromium.launchPersistentContext(dir, {
    channel: "chrome",
    headless: false,
    // Playwright starts Chrome with --no-sandbox unless told otherwise: no security sandbox and a
    // "--no-sandbox" warning bar. With the sandbox on, Chrome still shows one warning bar, for Patchright's --disable-blink-features=
    // AutomationControlled. That flag must stay: without it navigator.webdriver is true under
    // automation and every detector flags the browser (measured 3 Nov 2026: CreepJS 33%
    // headless, Browserscan "Robot", Pixelscan "automation detected"). Pages cannot see the bar.
    chromiumSandbox: true,
    viewport: o.viewport === "fixed" ? { width: 1280, height: 800 } : null,
    args,
    ...(o.proxyUrl ? { proxy: { server: o.proxyUrl } } : {}),
    // No `locale` option: it overrides navigator.languages for the page but not for its
    // workers (measured: page "en-US", worker "en-US,en"), a mismatch detectors compare.
    // Chrome's own --lang (above) sets both the same way.
    ...(timezone === "emulate" ? { timezoneId: IDENTITY.timezone } : {}),
    ...(timezone === "env" ? { env: { ...process.env, TZ: IDENTITY.timezone } } : {}),
  });
  if (o.window !== "offscreen" && o.viewport !== "fixed") await fitPageWidth(context, WINDOW.width);
  return context;
}

/**
 * On screen, Windows 11's window frame takes 15 px of the width (measured: window 1282, page
 * 1267; off screen the page is the full 1280), so the window is widened until the page itself
 * is `width` CSS px.
 */
async function fitPageWidth(context: BrowserContext, width: number): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  const inner = (await page.evaluate("window.innerWidth")) as number;
  if (inner === width) return;
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: (bounds.width ?? width) + (width - inner) } });
  } finally {
    await cdp.detach().catch(() => {});
  }
}
