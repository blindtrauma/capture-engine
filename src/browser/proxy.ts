// Local relay in front of the IPRoyal proxy. Chrome launched with a persistent profile
// can't log in to an authenticated proxy (ERR_PROXY_AUTH_UNSUPPORTED), so it talks to
// this unauthenticated relay on 127.0.0.1, which adds the credentials upstream. The
// relay also counts the bytes the proxy provider bills for.

import { createHash } from "node:crypto";
import { Server } from "proxy-chain";
import type { ProxySettings } from "../config";

export type Relay = { url: string; bytes(): number; close(): Promise<void> };

/** IPRoyal sticky-session id: 8 lowercase hex characters, stable per profile and day, so a site keeps one US IP for the day. */
export function sessionId(profile: string, day = new Date().toISOString().slice(0, 10)): string {
  return createHash("sha256").update(`${profile}|${day}`).digest("hex").slice(0, 8);
}

/** IPRoyal takes country, session and lifetime as suffixes on the password. */
export function upstreamUrl(p: ProxySettings, session: string): string {
  const password = `${p.password}_country-${p.country}_session-${session}_lifetime-${p.lifetime}`;
  return `http://${encodeURIComponent(p.username)}:${encodeURIComponent(password)}@${p.host}:${p.port}`;
}

export async function startRelay(upstream: string): Promise<Relay> {
  let total = 0;
  const server = new Server({ port: 0, host: "127.0.0.1", verbose: false, prepareRequestFunction: () => ({ upstreamProxyUrl: upstream }) });
  // Client -> relay plus upstream -> relay: everything that crosses the paid proxy.
  server.on("connectionClosed", ({ stats }: { stats?: { srcRxBytes?: number; trgRxBytes?: number | null } }) => {
    if (stats) total += (stats.srcRxBytes ?? 0) + (stats.trgRxBytes ?? 0);
  });
  await server.listen();
  return { url: `http://127.0.0.1:${server.port}`, bytes: () => total, close: () => server.close(true) };
}
