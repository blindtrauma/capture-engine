// Captures the full bodies of an app's answer requests from Chrome's network layer. Streamed
// responses (ChatGPT's NDJSON, Gemini's WebChannel) are read by the page as they arrive and
// Chrome keeps no copy, so `Network.getResponseBody` finds nothing; `Network.streamResourceContent`
// hands over what was buffered and every later chunk instead. Nothing is injected into the page.

import type { CDPSession, Page } from "patchright";

export type Tapped = {
  id: string;
  url: string;
  method: string;
  postData: string | null;
  status: number | null;
  startedAt: number;
  firstByteAt: number | null;
  finishedAt: number | null;
  failed: string | null;
  chunks: Buffer[];
  mode: "pending" | "streaming" | "fallback";
};

export class NetworkTap {
  private cdp: CDPSession | null = null;
  private readonly seen = new Map<string, Tapped>();

  constructor(
    private readonly page: Page,
    private readonly match: (url: string, method: string) => boolean,
  ) {}

  async start(): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page);
    this.cdp = cdp;
    cdp.on("Network.requestWillBeSent", (e) => {
      if (!this.match(e.request.url, e.request.method)) return;
      this.seen.set(e.requestId, {
        id: e.requestId,
        url: e.request.url,
        method: e.request.method,
        postData: e.request.postData ?? null,
        status: null,
        startedAt: Date.now(),
        firstByteAt: null,
        finishedAt: null,
        failed: null,
        chunks: [],
        mode: "pending",
      });
    });
    cdp.on("Network.responseReceived", (e) => {
      const t = this.seen.get(e.requestId);
      if (!t) return;
      t.status = e.response.status;
      cdp.send("Network.streamResourceContent", { requestId: e.requestId }).then(
        (r) => {
          t.mode = "streaming";
          if (r.bufferedData) this.push(t, Buffer.from(r.bufferedData, "base64"));
        },
        () => {
          // Already finished loading: Chrome still holds the whole body.
          t.mode = "fallback";
          if (t.finishedAt) void this.readWhole(t);
        },
      );
    });
    cdp.on("Network.dataReceived", (e) => {
      const t = this.seen.get(e.requestId);
      if (t && e.data) this.push(t, Buffer.from(e.data, "base64"));
    });
    cdp.on("Network.loadingFinished", (e) => {
      const t = this.seen.get(e.requestId);
      if (!t) return;
      t.finishedAt = Date.now();
      if (t.mode === "fallback") void this.readWhole(t);
    });
    cdp.on("Network.loadingFailed", (e) => {
      const t = this.seen.get(e.requestId);
      if (!t) return;
      t.finishedAt = Date.now();
      t.failed = e.errorText || "failed";
    });
    await cdp.send("Network.enable", { maxPostDataSize: 65_536 });
  }

  private push(t: Tapped, b: Buffer): void {
    if (!b.length) return;
    t.firstByteAt ??= Date.now();
    t.chunks.push(b);
  }

  private async readWhole(t: Tapped): Promise<void> {
    if (t.chunks.length || !this.cdp) return;
    try {
      const b = await this.cdp.send("Network.getResponseBody", { requestId: t.id });
      this.push(t, Buffer.from(b.body, b.base64Encoded ? "base64" : "utf8"));
    } catch {
      // Body gone; the entry stays with no chunks.
    }
  }

  /** Drops everything captured so far (call before each prompt). */
  reset(): void {
    this.seen.clear();
  }

  list(): Tapped[] {
    return [...this.seen.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  static text(t: Tapped): string {
    return Buffer.concat(t.chunks).toString("utf8");
  }

  async stop(): Promise<void> {
    await this.cdp?.detach().catch(() => {});
    this.cdp = null;
  }
}
