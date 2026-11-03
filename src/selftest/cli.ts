// Self-test: launches Chrome exactly as captures will, reads what sites can see (the
// identity probe and its rules), then visits public bot-detection pages. Writes
// output/selftest/<time>-<label>/report.json plus one full-page screenshot per site.
//
//   npm run selftest                        visible window, timezone emulated, native viewport, every site
//   npm run selftest -- --sites probe       the identity probe only (fast)
//   npm run selftest -- --use-proxy         through the IPRoyal relay (needs credentials in .env)
//   npm run selftest -- --tz none|emulate|env --window offscreen|visible --viewport native|fixed --flags "--a --b"
// In PowerShell type npm.cmd instead of npm whenever options follow "--" (see ../cliArgs.ts).
//
// Exit code 1 when a probe rule fails or a site gives a bad verdict.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { keepAwake } from "../browser/keepAwake";
import { launch, type LaunchOptions, type TimezoneMode } from "../browser/launch";
import { sessionId, startRelay, upstreamUrl, type Relay } from "../browser/proxy";
import { stopIfNpmTookFlags } from "../cliArgs";
import { IDENTITY, PATHS, proxySettings } from "../config";
import { checkIdentity, readIdentity, type Check, type IdentityProbe } from "../probe/identity";
import { SITES, type SiteResult } from "./sites";

const OPTIONS = {
  profile: { type: "string", default: "selftest" },
  "use-proxy": { type: "boolean", default: false },
  tz: { type: "string", default: "emulate" },
  window: { type: "string", default: "visible" },
  viewport: { type: "string", default: "native" },
  flags: { type: "string", default: "" },
  sites: { type: "string", default: "all" },
  label: { type: "string" },
} as const;
const { values: a, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
stopIfNpmTookFlags("selftest", "src/selftest/cli.ts", Object.keys(OPTIONS), positionals);
const USE_PROXY = a["use-proxy"];

const tz = a.tz as TimezoneMode;
const windowMode = a.window as NonNullable<LaunchOptions["window"]>;
const viewport = a.viewport as NonNullable<LaunchOptions["viewport"]>;
const flags = a.flags.split(/\s+/).filter(Boolean);
const wanted = a.sites === "all" ? SITES : SITES.filter((s) => a.sites.toLowerCase().split(",").includes(s.name.toLowerCase()));
const PATCHRIGHT = (JSON.parse(readFileSync(join(PATHS.root, "node_modules", "patchright", "package.json"), "utf8")) as { version: string }).version;

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const mark = (ok: boolean | null) => (ok === null ? "?" : ok ? "✓" : "✗");

type Report = {
  label: string;
  startedAt: string;
  options: Record<string, unknown>;
  versions: { patchright: string; chrome: string | null };
  keepAwake: boolean;
  identity: IdentityProbe | null;
  checks: Check[];
  sites: SiteResult[];
  proxyBytes: number;
  error?: string;
};

async function main(): Promise<number> {
  const label = a.label ?? [windowMode, `tz-${tz}`, viewport, USE_PROXY ? "proxy" : "direct", ...(flags.length ? ["flags"] : [])].join("_");
  const dir = join(PATHS.output, "selftest", `${stamp()}-${slug(label)}`);
  mkdirSync(dir, { recursive: true });

  const awake = await keepAwake();
  let relay: Relay | null = null;
  if (USE_PROXY) {
    const p = proxySettings();
    if (!p) throw new Error("--use-proxy needs PROXY_USERNAME and PROXY_PASSWORD in .env");
    relay = await startRelay(upstreamUrl(p, sessionId(a.profile)));
  }

  const report: Report = {
    label,
    startedAt: new Date().toISOString(),
    options: { profile: a.profile, proxy: USE_PROXY, timezone: tz, window: windowMode, viewport, flags, presenting: { timezone: tz === "none" ? null : IDENTITY.timezone, locale: IDENTITY.locale } },
    versions: { patchright: PATCHRIGHT, chrome: null },
    keepAwake: awake.active,
    identity: null,
    checks: [],
    sites: [],
    proxyBytes: 0,
  };

  const context = await launch({ profile: a.profile, proxyUrl: relay?.url, timezone: tz, window: windowMode, viewport, flags });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://example.com/", { waitUntil: "load", timeout: 60_000 });
    const identity = await readIdentity(page);
    report.identity = identity;
    report.versions.chrome = identity.chromeVersion;
    report.checks = checkIdentity(identity, { timezone: tz === "none" ? null : IDENTITY.timezone, locale: IDENTITY.locale });

    for (const site of a.sites === "probe" ? [] : wanted) {
      try {
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (site.prepare) {
          await page.waitForTimeout(3_000);
          await site.prepare(page);
        }
        await page.waitForTimeout(site.settleMs);
        const text = await page.innerText("body").catch(() => "");
        report.sites.push({ site: site.name, url: site.url, ...(await site.read(page, text)) });
        await page.screenshot({ path: join(dir, `${slug(site.name)}.png`), fullPage: true, scale: "css" });
      } catch (e) {
        report.sites.push({ site: site.name, url: site.url, verdict: "error", ok: null, details: [], error: (e as Error).message.split("\n")[0] });
      }
    }
  } catch (e) {
    report.error = (e as Error).message.split("\n")[0];
  } finally {
    await context.close().catch(() => {});
    report.proxyBytes = relay?.bytes() ?? 0;
    await relay?.close();
    awake.release();
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  }

  const id = report.identity;
  console.log(`\n${label}  (Patchright ${report.versions.patchright}, Chrome ${report.versions.chrome ?? "?"}, keep-awake ${report.keepAwake ? "on" : "OFF"})`);
  if (id) {
    console.log(`  timezone ${id.timezone} · languages ${id.languages.join(",")} · screen ${id.screen.width}x${id.screen.height} · window ${id.outer.join("x")} · page ${id.inner.join("x")} · dpr ${id.dpr} · at ${id.screenXY.join(",")} · ${id.visibility}${id.hasFocus ? ", focused" : ""}`);
    console.log(`  GPU ${id.webgl ? id.webgl.renderer : "?"}`);
  }
  for (const c of report.checks) console.log(`  ${mark(c.ok)} ${c.check.padEnd(40)} ${c.detail}`);
  for (const s of report.sites) console.log(`  ${mark(s.ok)} ${s.site.padEnd(12)} ${s.verdict}${s.error ? ` (${s.error})` : ""}`);
  if (report.error) console.log(`  error: ${report.error}`);
  if (USE_PROXY) console.log(`  proxy traffic: ${(report.proxyBytes / 1e6).toFixed(1)} MB`);
  console.log(`  → ${dir}`);
  return report.error || report.checks.some((c) => !c.ok) || report.sites.some((s) => s.ok === false) ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
