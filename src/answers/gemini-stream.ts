// Reads Gemini's answer stream as captured on 3 Nov 2026: a WebChannel session
// (geminiweb-pa.clients6.google.com/v1/processSession), whose long-poll GET delivers frames
// "<length>\n<json>", each json [[seq, ["<base64 protobuf>"]]]. The protobuf has no published
// schema, so it is decoded generically and read by position relative to the answer's turn,
// the message holding {2: {1: "c_<conversation>", 2: "r_<response>"}}:
//   5.2.1           the answer's markdown (grows frame by frame)
//   5.3.2[]         one entry per cited span: 1.1 the span's text, 3 the source
//                   {1 url (with a #:~:text= fragment), 2 title, 4 snippet, 7 publisher}
//   5.38.2          the "Searched the web" block; 8[] every result {2 url, 3 title}
//   6.1, 6.2        the location Gemini placed us in and how it knew
//                   ("SWML_DESCRIPTION_FROM_YOUR_INTERNET_ADDRESS")
// If Google moves a field, that field comes back empty and the driver says so in warnings.

import type { Citation, SearchSource } from "./types";

export type PbField = { field: number; n?: string; s?: string; m?: PbField[]; bytes?: number };

function varint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n, shift = 0n, b: number;
  do {
    if (pos >= buf.length) throw new Error("eof");
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [result, pos];
}

const printable = (s: string): boolean => !/[\x00-\x08\x0e-\x1f�]/.test(s);

/** No raw-bytes leaves and readable strings: a clean parse, not text that happened to parse. */
function clean(fields: PbField[]): boolean {
  return fields.every((f) => (f.bytes === undefined) && (f.s === undefined || printable(f.s)) && (!f.m || clean(f.m)));
}

/** Schema-free protobuf decode: length-delimited fields become messages when they parse cleanly, else strings. */
export function decodeProto(buf: Buffer, depth = 0): PbField[] {
  const out: PbField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let key: bigint;
    [key, pos] = varint(buf, pos);
    const field = Number(key >> 3n), wt = Number(key & 7n);
    if (field === 0) throw new Error("field 0");
    if (wt === 0) {
      let v: bigint;
      [v, pos] = varint(buf, pos);
      out.push({ field, n: v.toString() });
    } else if (wt === 1 || wt === 5) {
      pos += wt === 1 ? 8 : 4;
      if (pos > buf.length) throw new Error("eof");
      out.push({ field, n: "fixed" });
    } else if (wt === 2) {
      let len: bigint;
      [len, pos] = varint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error("overflow");
      const sub = buf.subarray(pos, end);
      pos = end;
      let nested: PbField[] | null = null;
      if (depth < 48 && sub.length) {
        try {
          nested = decodeProto(sub, depth + 1);
        } catch {
          nested = null;
        }
      }
      const text = sub.toString("utf8");
      if (nested && nested.length && clean(nested)) out.push({ field, m: nested });
      else if (printable(text)) out.push({ field, s: text });
      else if (nested) out.push({ field, m: nested });
      else out.push({ field, bytes: sub.length });
    } else throw new Error(`wire type ${wt}`);
  }
  return out;
}

/** All values at a path of field numbers (repeated fields give several). */
export function at(fields: PbField[], path: number[]): PbField[] {
  let cur: PbField[] = [{ field: 0, m: fields }];
  for (const n of path) cur = cur.flatMap((f) => (f.m ?? []).filter((x) => x.field === n));
  return cur;
}
const strAt = (fields: PbField[], path: number[]): string | null => at(fields, path).find((f) => f.s !== undefined)?.s ?? null;

/** WebChannel framing: "<length>\n<json>" repeated; returns each frame's JSON. */
export function webChannelFrames(body: string): unknown[] {
  const frames: unknown[] = [];
  for (let i = 0; i < body.length; ) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const nl = body.indexOf("\n", i);
    if (nl < 0) break;
    const len = Number(body.slice(i, nl));
    if (!Number.isInteger(len) || len <= 0) break;
    try {
      frames.push(JSON.parse(body.slice(nl + 1, nl + 1 + len)));
    } catch {
      break;
    }
    i = nl + 1 + len;
  }
  return frames;
}

/** Every base64 protobuf payload in a frame, decoded. */
function payloads(frame: unknown): PbField[][] {
  const out: PbField[][] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v !== "string" || v.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return;
    try {
      out.push(decodeProto(Buffer.from(v, "base64")));
    } catch {
      // not protobuf
    }
  };
  visit(frame);
  return out;
}

type Turn = { conversationId: string; responseId: string; node: PbField[] };

function turns(msg: PbField[]): Turn[] {
  const found: Turn[] = [];
  const walk = (fields: PbField[], depth: number): void => {
    if (depth > 30) return;
    const ids = fields.filter((f) => f.field === 2 && f.m).map((f) => f.m!);
    for (const idm of ids) {
      const c = strAt(idm, [1]), r = strAt(idm, [2]);
      if (c && r && /^c_[0-9a-f]+$/.test(c) && /^r_[0-9a-f]+$/.test(r)) found.push({ conversationId: c, responseId: r, node: fields });
    }
    for (const f of fields) if (f.m) walk(f.m, depth + 1);
  };
  walk(msg, 0);
  return found;
}

export type GeminiStream = {
  frames: number;
  conversationId: string | null;
  responseId: string | null;
  markdown: string | null;
  citations: Citation[];
  searchSources: SearchSource[];
  searched: boolean;
  location: string | null;
  locationBasis: string | null;
};

const ASSET = /gstatic\.com|googleusercontent\.com|ggpht\.com|encrypted-tbn/;

/**
 * Reads the captured backchannel bodies. `responseId` (from the page) picks the turn when the
 * session carried more than one; otherwise the last turn seen wins.
 */
export function parseGeminiStream(bodies: string[], responseId: string | null): GeminiStream {
  const out: GeminiStream = { frames: 0, conversationId: null, responseId: null, markdown: null, citations: [], searchSources: [], searched: false, location: null, locationBasis: null };
  const byTurn = new Map<string, Turn[]>();
  for (const body of bodies) {
    for (const frame of webChannelFrames(body)) {
      out.frames++;
      for (const msg of payloads(frame)) for (const t of turns(msg)) byTurn.set(t.responseId, [...(byTurn.get(t.responseId) ?? []), t]);
    }
  }
  const id = responseId && byTurn.has(responseId) ? responseId : [...byTurn.keys()].pop();
  if (!id) return out;
  const list = byTurn.get(id)!;
  out.responseId = id;
  out.conversationId = list[0].conversationId;
  const cites = new Map<string, Citation>();
  const search = new Map<string, SearchSource>();
  for (const { node } of list) {
    const md = strAt(node, [5, 2, 1]);
    if (md && md.length >= (out.markdown?.length ?? 0)) out.markdown = md;
    for (const span of at(node, [5, 3, 2])) {
      const src = at(span.m ?? [], [3])[0]?.m;
      if (!src) continue;
      const url = strAt(src, [1]);
      if (!url || !/^https?:\/\//.test(url) || ASSET.test(url)) continue;
      const c = cites.get(url) ?? { url, title: strAt(src, [2]) ?? "", description: strAt(src, [4]), source: strAt(src, [7]), date: null, cited_text: [], position: cites.size + 1 };
      const spanText = strAt(span.m ?? [], [1, 1]);
      if (spanText && !c.cited_text.includes(spanText)) c.cited_text.push(spanText);
      cites.set(url, c);
    }
    for (const block of at(node, [5, 38, 2])) {
      const labels = (block.m ?? []).filter((f) => f.s !== undefined).map((f) => f.s!);
      if (labels.some((l) => /searched the web|google search/i.test(l))) out.searched = true;
      for (const e of at(block.m ?? [], [8])) {
        const url = strAt(e.m ?? [], [2]);
        if (!url || !/^https?:\/\//.test(url) || search.has(url)) continue;
        search.set(url, { url, title: strAt(e.m ?? [], [3]) ?? "", source: hostName(url), favicon: strAt(e.m ?? [], [1]) });
      }
    }
    out.location = strAt(node, [6, 1]) ?? out.location;
    out.locationBasis = strAt(node, [6, 2]) ?? out.locationBasis;
  }
  out.citations = [...cites.values()];
  out.searchSources = [...search.values()];
  if (out.citations.length || out.searchSources.length) out.searched = true;
  return out;
}

function hostName(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
