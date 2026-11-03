// Public bot-detection pages. Each shows its verdict differently, so these readers pull
// the headline result out of the page text where they can; "?" means not recognised.
// The full-page screenshot saved for each one is the real record.

import type { Page } from "patchright";

export type SiteResult = { site: string; url: string; verdict: string; ok: boolean | null; details: string[]; error?: string };

type Reading = Omit<SiteResult, "site" | "url">;
/** `prepare` runs after the page opens, before the settle wait (e.g. pressing a start button). */
export type Site = { name: string; url: string; settleMs: number; prepare?(page: Page): Promise<void>; read(page: Page, text: string): Promise<Reading> };

const matchingLines = (text: string, re: RegExp, max = 8): string[] =>
  text.split("\n").map((l) => l.trim()).filter((l) => l && l.length < 200 && re.test(l)).slice(0, max);

export const SITES: Site[] = [
  {
    name: "CreepJS",
    url: "https://abrahamjuliot.github.io/creepjs/",
    settleMs: 15_000,
    // Shown as "0% headless: <hash>", "0% stealth: <hash>", "31% like headless: <hash>". Headless and
    // stealth are the verdicts; "like headless" counts traits normal desktop Chrome can share too,
    // so it is recorded, not judged.
    async read(_page, text) {
      const scores = new Map([...text.matchAll(/(\d+)%\s*(like headless|headless|stealth)\b/gi)].map((m) => [m[2].toLowerCase(), Number(m[1])]));
      const judged = ["headless", "stealth"].filter((k) => scores.has(k));
      return {
        verdict: scores.size ? [...scores].map(([k, pct]) => `${pct}% ${k}`).join(", ") : "not found",
        ok: judged.length === 2 ? judged.every((k) => scores.get(k) === 0) : null,
        details: matchingLines(text, /headless|stealth|lies|bot/i),
      };
    },
  },
  {
    name: "Sannysoft",
    url: "https://bot.sannysoft.com/",
    settleMs: 6_000,
    async read(page) {
      const failed = await page.locator("td.failed").count();
      const passed = await page.locator("td.passed").count();
      const names = await page.locator("tr:has(td.failed) td:first-child").allInnerTexts();
      return { verdict: `${passed} passed, ${failed} failed`, ok: passed > 0 ? failed === 0 : null, details: names.map((n) => `failed: ${n.trim()}`) };
    },
  },
  {
    name: "Browserscan",
    url: "https://www.browserscan.net/bot-detection",
    settleMs: 12_000,
    async read(_page, text) {
      const m = text.match(/Test Results?\s*:?\s*(Normal|Robot|Bot|Abnormal)/i);
      return { verdict: m ? m[1] : "not found", ok: m ? /normal/i.test(m[1]) : null, details: matchingLines(text, /webdriver|headless|cdp|robot|automation/i) };
    },
  },
  {
    name: "Pixelscan",
    url: "https://pixelscan.net/",
    settleMs: 15_000,
    // The address is a landing page; the scan runs after "Scan My Browser Now". Result cards:
    // "Your Browser Fingerprint is consistent", "No automated behavior detected",
    // "No masking detected", "No proxy detected", plus the IP's location.
    async prepare(page) {
      await page.getByText("Scan My Browser Now").first().click({ timeout: 15_000 });
    },
    async read(_page, text) {
      const consistent = /fingerprint\s+is\s+consistent/i.test(text);
      const inconsistent = /fingerprint\s+is\s+inconsistent/i.test(text);
      const noAutomation = /no\s+automated\s+behavio(u)?r\s+detected/i.test(text);
      const noMasking = /no\s+masking\s+detected/i.test(text);
      const parts = [
        consistent ? "consistent" : inconsistent ? "inconsistent" : "",
        noAutomation ? "no automation" : /automated\s+behavio(u)?r\s+detected/i.test(text) ? "automation detected" : "",
        noMasking ? "no masking" : /masking\s+detected/i.test(text) ? "masking detected" : "",
        /no\s+proxy\s+detected/i.test(text) ? "no proxy seen" : /proxy\s+detected/i.test(text) ? "proxy seen" : "",
      ].filter(Boolean);
      return {
        verdict: parts.join(", ") || "not found",
        ok: consistent || inconsistent ? consistent && noAutomation && noMasking : null,
        details: matchingLines(text, /consistent|automated|masking|proxy|location|\//i),
      };
    },
  },
  {
    name: "IPHey",
    url: "https://iphey.com/",
    settleMs: 12_000,
    async read(_page, text) {
      const m = text.match(/\b(Trustworthy|Suspicious|Unreliable)\b/i);
      return { verdict: m ? m[1] : "not found", ok: m ? /trustworthy/i.test(m[1]) : null, details: matchingLines(text, /browser|location|ip address|hardware|software/i) };
    },
  },
];
