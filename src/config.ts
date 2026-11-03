// Settings from the environment (.env next to package.json, loaded once).

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const PATHS = {
  root: ROOT,
  profiles: resolve(process.env.PROFILES_DIR || join(ROOT, "profiles")),
  output: resolve(process.env.OUTPUT_DIR || join(ROOT, "output")),
};

/** What the browser presents to sites. It must agree with the proxy's location. */
export const IDENTITY = {
  timezone: process.env.CAPTURE_TIMEZONE || "America/New_York",
  locale: process.env.CAPTURE_LOCALE || "en-US",
};

export type ProxySettings = { host: string; port: number; username: string; password: string; country: string; lifetime: string };

/** The IPRoyal account, or null when no credentials are set (the PC's own connection is used). */
export function proxySettings(): ProxySettings | null {
  const { PROXY_USERNAME, PROXY_PASSWORD } = process.env;
  if (!PROXY_USERNAME || !PROXY_PASSWORD) return null;
  return {
    host: process.env.PROXY_HOST || "geo.iproyal.com",
    port: Number(process.env.PROXY_PORT || 12321),
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
    country: (process.env.PROXY_COUNTRY || "us").toLowerCase(),
    lifetime: process.env.PROXY_LIFETIME || "24h",
  };
}
