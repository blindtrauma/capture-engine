// Reads ChatGPT's answer stream (POST /unauth-mweb/conversation/updates, content type
// application/vnd.openai.conversation-source+ndjson, "version": 2), as captured on 3 Nov 2026.
// One JSON object per line:
//   control    started, conversation-id, assistant-content-started, turn-latency (routing tags),
//              terminal-received (terminalKind "complete")
//   reasoning  status text ("Searching the web", "Searched 8 websites") and searchSources:
//              every page the web search returned, grouped by domain
//   content    per message and revision; `markdown` for plain answers, or `dil` for generated
//              layouts: each `dil` is a full snapshot carrying fallbackMarkdown (OpenAI's own
//              markdown of the layout) and appData.opGenui.componentResults (Cite items with
//              url/title/publisher/date, product Entity names, images)
//   state, shared, end

import type { Citation, SearchSource } from "./types";

type Json = Record<string, unknown>;

export type ChatGPTMessage = {
  id: string;
  revision: number;
  markdown: string;
  dil: Json | null;
  references: unknown[];
  status: string | null;
};

export type ChatGPTStream = {
  lines: number;
  badLines: number;
  ended: boolean;
  terminal: string | null;
  conversationId: string | null;
  canonicalPath: string | null;
  tags: Record<string, string> | null;
  activity: string[];
  searchSources: SearchSource[];
  messages: Map<string, ChatGPTMessage>;
  /** assistant message ids in the order their content started */
  order: string[];
};

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseChatGPTStream(text: string): ChatGPTStream {
  const s: ChatGPTStream = { lines: 0, badLines: 0, ended: false, terminal: null, conversationId: null, canonicalPath: null, tags: null, activity: [], searchSources: [], messages: new Map(), order: [] };
  const seenSearch = new Set<string>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let o: Json;
    try {
      o = JSON.parse(raw) as Json;
    } catch {
      s.badLines++;
      continue;
    }
    s.lines++;
    const type = o.type;
    if (type === "end") s.ended = true;
    else if (type === "control") {
      const d = obj(o.detail) ?? {};
      if (d.kind === "conversation-id") {
        s.conversationId = str(d.conversationId) ?? s.conversationId;
        s.canonicalPath = str(d.canonicalPath) ?? s.canonicalPath;
      } else if (d.kind === "assistant-content-started" && str(d.messageId) && !s.order.includes(d.messageId as string)) {
        s.order.push(d.messageId as string);
      } else if (d.kind === "terminal-received") {
        s.terminal = str(d.terminalKind) ?? "received";
        s.conversationId ??= str(d.conversationId);
      } else if (d.kind === "turn-latency") {
        const tags = obj(obj(d.turnLatency)?.tags);
        if (tags) s.tags = Object.fromEntries(Object.entries(tags).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      }
    } else if (type === "reasoning") {
      const status = obj(o.status);
      for (const t of [str(status?.text), ...arr(obj(o.activity)?.records).map((r) => str(obj(r)?.text))]) {
        if (t && !s.activity.includes(t)) s.activity.push(t);
      }
      for (const item of arr(obj(obj(status?.reasoning))?.items)) {
        for (const g of arr(obj(obj(item)?.searchSources)?.groups)) {
          for (const e of arr(obj(g)?.entries)) {
            const en = obj(e);
            const url = str(en?.url);
            if (!url || seenSearch.has(url)) continue;
            seenSearch.add(url);
            s.searchSources.push({ url, title: str(en?.title) ?? "", source: str(en?.attribution) ?? str(obj(g)?.domain), favicon: str(en?.faviconUrl) });
          }
        }
      }
    } else if (type === "content") {
      const id = str(o.messageId);
      if (!id) continue;
      const rev = typeof o.revision === "number" ? o.revision : 0;
      const m = s.messages.get(id) ?? { id, revision: -1, markdown: "", dil: null, references: [], status: null };
      if (rev < m.revision) continue;
      const md = typeof o.markdown === "string" ? o.markdown : "";
      // "replace" restarts the text. For "append", a chunk that already holds the text so far
      // is a snapshot, not a delta.
      if (o.mode === "replace" || (m.markdown && md.startsWith(m.markdown))) m.markdown = md;
      else m.markdown += md;
      if (obj(o.dil)) m.dil = o.dil as Json;
      if (Array.isArray(o.references) && o.references.length) m.references = o.references;
      m.status = str(o.status) ?? m.status;
      m.revision = rev;
      s.messages.set(id, m);
      if (!s.order.includes(id)) s.order.push(id);
    }
  }
  return s;
}

/**
 * The stream as stored in response_raw: a content line carrying `dil` is dropped when a later
 * line of the same message carries one too (each holds the whole layout, so an answer's stream
 * repeats it 20-50 times). Every other line is kept exactly as received.
 */
export function compactChatGPTStream(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l) as Json;
    } catch {
      return null;
    }
  });
  const lastDil = new Map<string, number>();
  parsed.forEach((o, i) => {
    if (o?.type === "content" && obj(o.dil) && str(o.messageId)) lastDil.set(o.messageId as string, i);
  });
  return lines.filter((_, i) => {
    const o = parsed[i];
    return !(o?.type === "content" && obj(o.dil) && str(o.messageId) && lastDil.get(o.messageId as string) !== i);
  }).join("\n");
}

/** The message to report: the one the page shows, else the last one that has content. */
export function answerMessage(s: ChatGPTStream, pageMessageId: string | null): ChatGPTMessage | null {
  if (pageMessageId && s.messages.has(pageMessageId)) return s.messages.get(pageMessageId)!;
  for (const id of [...s.order].reverse()) {
    const m = s.messages.get(id);
    if (m && (m.markdown || m.dil)) return m;
  }
  return null;
}

/** OpenAI's own markdown for the message: the plain answer, or the layout's fallback markdown. */
export function messageMarkdown(m: ChatGPTMessage): string | null {
  const fallback = str(m.dil?.fallbackMarkdown);
  return cleanMarkdown(m.markdown.trim() ? m.markdown : fallback ?? "") || null;
}

/** Strips ChatGPT's private-use citation markers ("citeturn0search1"). */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/[^]*/g, "")
    .replace(/[-]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function components(m: ChatGPTMessage): Json[] {
  const results = obj(obj(obj(m.dil?.appData)?.opGenui)?.componentResults);
  return results ? Object.values(results).map(obj).filter((x): x is Json => !!x) : [];
}

const dateOf = (ts: unknown): string | null => (typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : null);

/**
 * Sources the answer cites: the layout's Cite components, then any url+title object in the
 * message's references (plain answers carry their citations there).
 */
export function messageCitations(m: ChatGPTMessage): Citation[] {
  const out = new Map<string, Citation>();
  for (const c of components(m)) {
    if (c.componentName !== "Cite") continue;
    for (const it of arr(obj(c.state)?.items)) {
      const i = obj(it);
      const url = str(i?.url);
      if (!url || out.has(url)) continue;
      out.set(url, { url, title: str(i?.title) ?? "", description: str(i?.snippet), source: str(i?.source_label), date: str(i?.metadata_label) ?? dateOf(i?.pub_timestamp), cited_text: [], position: 0 });
    }
  }
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = obj(v);
    if (!o) return;
    const url = str(o.url);
    const title = str(o.title);
    if (url && /^https?:\/\//.test(url) && title && !/images\.openai\.com|oaiusercontent|favicon/i.test(url) && !out.has(url)) {
      out.set(url, { url, title, description: str(o.snippet), source: str(o.attribution) ?? str(o.source_label), date: dateOf(o.pub_date) ?? dateOf(o.pub_timestamp), cited_text: [], position: 0 });
    }
    for (const [k, x] of Object.entries(o)) if (k !== "modelDilV2" && typeof x === "object") walk(x, depth + 1);
  };
  walk(m.references, 0);
  return [...out.values()].map((c, i) => ({ ...c, position: i + 1 }));
}

/** Products the answer marks up as product entities. */
export function messageEntities(m: ChatGPTMessage): string[] {
  const names: string[] = [];
  for (const c of components(m)) {
    if (c.componentName !== "Entity") continue;
    const st = obj(c.state);
    const payload = obj(st?.action_payload) ?? obj(obj(st?.click_action)?.payload);
    const name = str(st?.value) ?? str(payload?.query);
    if (name && payload?.category === "product" && !names.includes(name)) names.push(name);
  }
  return names;
}
