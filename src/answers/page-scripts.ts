// Scripts run inside the page (read-only, except that text extraction hides the skipped parts for
// one synchronous moment and restores them before the page can paint). They are plain strings:
// tsx would wrap named helpers of a real function in __name(), which does not exist in the page.
// Selectors were read off chatgpt.com and gemini.google.com on 3 Nov 2026.

/** Visible text of `root` without the `skip` parts, as the page lays it out. */
const TEXT_FN = String.raw`function (root, skip) {
  var hidden = skip ? Array.prototype.slice.call(root.querySelectorAll(skip)) : [];
  var prev = hidden.map(function (e) { return e.style.getPropertyValue("display"); });
  var prio = hidden.map(function (e) { return e.style.getPropertyPriority("display"); });
  hidden.forEach(function (e) { e.style.setProperty("display", "none", "important"); });
  var t = root.innerText || "";
  hidden.forEach(function (e, i) { if (prev[i]) e.style.setProperty("display", prev[i], prio[i]); else e.style.removeProperty("display"); });
  return t.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}`;

/** Markdown of `root` without the `skip` parts. */
const MD_FN = String.raw`function (root, skip) {
  var FENCE = String.fromCharCode(96, 96, 96), TICK = String.fromCharCode(96);
  var BLOCK = /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|FIGURE|FIGCAPTION|DETAILS|SUMMARY|FIELDSET|FORM|DL|DT|DD|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|PRE|BLOCKQUOTE|HR|H1|H2|H3|H4|H5|H6)$/;
  var out = [], para = "";
  var gone = function (el) {
    if (skip && el.matches(skip)) return true;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    var s = getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden";
  };
  var flush = function () {
    var p = para.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (p) out.push(p);
    para = "";
  };
  var wrap = function (s, m) { var t = s.trim(); return t ? (s.match(/^\s*/)[0] + m + t + m + s.match(/\s*$/)[0]) : s; };
  var image = function (el) {
    var src = el.currentSrc || el.src || "";
    var w = el.naturalWidth || el.width || 0;
    return /^https?:/.test(src) && w >= 48 ? "![" + (el.alt || "").replace(/[\[\]\n]/g, " ").trim() + "](" + src + ")" : "";
  };
  var inline = function (node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, " ");
    if (node.nodeType !== 1 || gone(node)) return "";
    var t = node.tagName;
    if (t === "BR") return "\n";
    if (t === "IMG") return image(node);
    if (t === "SUP" || t === "SUB" || t === "SCRIPT" || t === "STYLE" || t === "svg" || t === "SVG") return "";
    if (t === "CODE") return TICK + node.textContent + TICK;
    var s = "";
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      s += c.nodeType === 1 && BLOCK.test(c.tagName) ? " " + inline(c).trim() + " " : inline(c);
    }
    if (t === "STRONG" || t === "B") return wrap(s, "**");
    if (t === "EM" || t === "I") return wrap(s, "_");
    if (t === "A") {
      var href = node.href || "", txt = s.replace(/\s+/g, " ").trim();
      return /^https?:/.test(href) && txt ? "[" + txt.replace(/[\[\]]/g, "") + "](" + href + ")" : s;
    }
    return s;
  };
  var list = function (el, depth) {
    var lines = [], n = 0, ordered = el.tagName === "OL";
    for (var i = 0; i < el.children.length; i++) {
      var li = el.children[i];
      if (li.tagName !== "LI" || gone(li)) continue;
      n++;
      var head = "", subs = [];
      for (var j = 0; j < li.childNodes.length; j++) {
        var c = li.childNodes[j];
        if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) { if (!gone(c)) subs.push(c); }
        else head += c.nodeType === 1 && BLOCK.test(c.tagName) ? " " + inline(c).trim() + " " : inline(c);
      }
      lines.push("  ".repeat(depth) + (ordered ? n + ". " : "- ") + head.replace(/\s+/g, " ").trim());
      subs.forEach(function (s) { lines = lines.concat(list(s, depth + 1)); });
    }
    return lines;
  };
  var table = function (el) {
    var rows = Array.prototype.slice.call(el.querySelectorAll("tr")).filter(function (r) { return !gone(r); });
    var cells = rows.map(function (r) {
      return Array.prototype.slice.call(r.children).filter(function (c) { return /^(TD|TH)$/.test(c.tagName); })
        .map(function (c) { return inline(c).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(); });
    }).filter(function (r) { return r.length; });
    if (!cells.length) return "";
    var width = Math.max.apply(null, cells.map(function (r) { return r.length; }));
    var line = function (r) { var x = r.slice(); while (x.length < width) x.push(""); return "| " + x.join(" | ") + " |"; };
    var sep = "|" + new Array(width).fill(" --- |").join("");
    return [line(cells[0]), sep].concat(cells.slice(1).map(line)).join("\n");
  };
  var walk = function (node) {
    if (node.nodeType === 3) { para += node.nodeValue.replace(/\s+/g, " "); return; }
    if (node.nodeType !== 1 || gone(node)) return;
    var t = node.tagName, m = /^H([1-6])$/.exec(t);
    if (m) { flush(); var h = inline(node).replace(/\s+/g, " ").trim(); if (h) out.push(new Array(+m[1] + 1).join("#") + " " + h); return; }
    if (t === "UL" || t === "OL") { flush(); var l = list(node, 0); if (l.length) out.push(l.join("\n")); return; }
    if (t === "TABLE") { flush(); var tb = table(node); if (tb) out.push(tb); return; }
    if (t === "PRE") { flush(); out.push(FENCE + "\n" + node.textContent.replace(/\n$/, "") + "\n" + FENCE); return; }
    if (t === "HR") { flush(); out.push("---"); return; }
    if (t === "BLOCKQUOTE") { flush(); var q = inline(node).trim(); if (q) out.push(q.split("\n").map(function (x) { return "> " + x; }).join("\n")); return; }
    if (BLOCK.test(t)) { flush(); for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]); flush(); return; }
    para += inline(node);
  };
  walk(root);
  flush();
  return out.join("\n\n").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}`;

const PRICE = String.raw`/(?:[$₹€£¥]|US\$|Rs\.?)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|INR|EUR|GBP)\b/`;

/** Bot checks, captchas, sign-in walls and refusals that stand between us and an answer. */
export const BLOCKERS_JS = String.raw`(() => {
  var title = document.title || "";
  var vis = function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  var bodyHead = ((document.body && document.body.innerText) || "").slice(0, 600);
  var notices = Array.prototype.slice.call(document.querySelectorAll("[role='alert'], [role='alertdialog'], [role='dialog'], dialog[open], [data-sonner-toast], mat-snack-bar-container, .cdk-overlay-pane"))
    .filter(vis).map(function (e) { return (e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 400); }).filter(Boolean);
  var all = notices.join(" | ");
  return {
    url: location.href,
    title: title,
    challenge: /just a moment|attention required|verify you are human|checking your browser|security check/i.test(title + " " + bodyHead)
      || !!document.querySelector("iframe[src*='challenges.cloudflare.com'], #challenge-form, #cf-challenge-running, #challenge-stage"),
    captcha: !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='arkoselabs'], #captcha-form")
      || /\/sorry\//.test(location.pathname) || /unusual traffic from your computer/i.test(bodyHead),
    signIn: /accounts\.google\.com|\/auth\/login|\/log-in/.test(location.href)
      || /(log ?in|sign ?in|sign up)[^|]{0,80}(to continue|to keep chatting|to get smarter responses|required)/i.test(all),
    limit: (all.match(/[^|]{0,80}(you['’]ve (hit|reached)[^|]{0,60}limit|too many (requests|messages)|rate limit|usage cap|try again (later|in))[^|]{0,120}/i) || [null])[0],
    notices: notices.slice(0, 5),
  };
})()`;

/**
 * Answer progress on chatgpt.com. errorCard: the text of an error box with a Retry button, as
 * ChatGPT shows when a turn fails ("ChatGPT is temporarily experiencing issues. We're working to
 * restore service. Check service status [Retry]", seen 3 Nov 2026; pressing Retry answered).
 */
export const CHATGPT_STATE_JS = String.raw`(() => {
  var items = document.querySelectorAll("[data-message-role='assistant'], [data-message-author-role='assistant']");
  var li = items[items.length - 1];
  var root = li ? (li.querySelector("[data-assistant-markdown-root]") || li) : null;
  var text = root ? (root.innerText || "") : "";
  var errorCard = null;
  Array.prototype.forEach.call(document.querySelectorAll("button"), function (b) {
    if (errorCard) return;
    var label = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).trim();
    if (!/^(retry|try again)\b/i.test(label)) return;
    var r = b.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var box = b.parentElement;
    for (var i = 0; i < 5 && box && (box.innerText || "").trim().length < 40; i++) box = box.parentElement;
    var t = box ? (box.innerText || "").replace(/\s+/g, " ").trim() : "";
    if (t.length < 500 && /temporarily|went wrong|error|network|too many|unusual activity|try again later|unable to|failed/i.test(t)) errorCard = t;
  });
  return {
    errorCard: errorCard,
    users: document.querySelectorAll("[data-message-role='user'], [data-message-author-role='user']").length,
    assistants: items.length,
    complete: !!li && li.hasAttribute("data-message-complete"),
    stop: !!document.querySelector("button[aria-label='Stop generating'], button[aria-label='Stop streaming'], button[data-testid='stop-button']"),
    chars: text.length,
    head: text.slice(0, 400),
    url: location.href,
    composer: !!document.querySelector("textarea[name='prompt'], #prompt-textarea"),
  };
})()`;

/** Everything the ChatGPT answer shows. */
export const CHATGPT_EXTRACT_JS = String.raw`(() => {
  var TEXT = ${TEXT_FN};
  var MD = ${MD_FN};
  var PRICE = ${PRICE};
  var items = document.querySelectorAll("[data-message-role='assistant'], [data-message-author-role='assistant']");
  var li = items[items.length - 1];
  if (!li) return { found: false, url: location.href };
  var root = li.querySelector("[data-assistant-markdown-root]") || li;
  var SKIP = "[data-assistant-reasoning-summary], [role='status'], details[data-d-component='reasoning'], [data-message-attribution], [data-assistant-message-actions], [data-assistant-placeholder-slot], a[hidden], [data-d-image-loading], [data-d-component='loading-block']";
  var line = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
  var links = [], seen = {};
  Array.prototype.forEach.call(root.querySelectorAll("a[href]"), function (a) {
    var u = a.href;
    if (!/^https?:/.test(u) || seen[u] || a.closest(SKIP)) return;
    seen[u] = 1;
    var internal = false;
    try { internal = new URL(u).hostname.replace(/^www\./, "") === location.hostname.replace(/^www\./, ""); } catch (e) {}
    links.push({ url: u, text: line(a.innerText).slice(0, 300), internal: internal });
  });
  // Product cards: a row with an image and a named product. The price is a title ("₹1,16,480+")
  // or a "Listed at ₹42,499 from Amazon.in + others." line; cards without one are kept by the
  // driver only when ChatGPT marked the name as a product.
  var cards = [];
  Array.prototype.forEach.call(root.querySelectorAll("[data-d-component='row']"), function (row) {
    if (row.querySelector("[data-d-component='row']")) return;
    var img = row.querySelector("[data-d-component='image'] img") || row.querySelector("img");
    if (!img) return;
    var text = row.innerText || "";
    // The image frame is a pressable too (empty); the product name is the first named one outside it.
    var named = Array.prototype.filter.call(row.querySelectorAll("[data-d-component='pressable'], [data-d-component='text']"), function (p) {
      return !p.closest("[data-d-component='image']") && line(p.innerText);
    });
    var pressable = named.filter(function (p) { return p.getAttribute("data-d-component") === "pressable"; })[0] || null;
    var name = line((pressable || named[0] || {}).innerText || "").replace(/^\d+\.\s*/, "");
    if (!name) return;
    var priceEl = Array.prototype.filter.call(row.querySelectorAll("[data-d-component='title']"), function (t) { return PRICE.test(t.innerText); })[0];
    var shown = priceEl ? line(priceEl.innerText) : null;
    var listed = /Listed at\s+(.+?)\s+from\s+([^\n]+)/i.exec(text);
    var merchant = /Merchant:\s*([^\n]+)/.exec(text);
    var rating = /(\d(?:\.\d)?)\s*(?:★|stars?|out of 5)/i.exec(text);
    var reviews = /\(([\d.,]+\s?[kKmM]?\+?)\s*(?:reviews?|ratings?)?\)/.exec(text);
    var badge = row.querySelector("[data-d-component='badge']");
    var a = row.querySelector("[data-d-component='popover-trigger'] a[href], a[href]");
    cards.push({
      title: name,
      price: shown ? (shown.length <= 40 ? shown : (PRICE.exec(shown) || [shown])[0]) : listed ? line(listed[1]) : null,
      merchant: merchant ? line(merchant[1]) : listed ? line(listed[2]).replace(/\.$/, "") : null,
      rating: rating ? rating[1] : null,
      reviews: reviews ? reviews[1] : null,
      label: badge ? line(badge.innerText) : null,
      url: a ? a.href : null,
      image: /^https?:/.test(img.currentSrc || img.src) ? (img.currentSrc || img.src) : null,
      named: !!pressable,
    });
  });
  var reasoning = [];
  Array.prototype.forEach.call(li.querySelectorAll("[data-assistant-reasoning-summary] summary, [data-assistant-reasoning-summary] [data-text-shimmer-text], [data-assistant-reasoning-summary] [role='status']"), function (e) {
    var t = line(e.textContent);
    if (t && reasoning.indexOf(t) < 0) reasoning.push(t);
  });
  var ads = [];
  var scope = li.parentElement || document.body;
  Array.prototype.forEach.call(scope.querySelectorAll("*"), function (e) {
    if (e.children.length || !/^(sponsored|ad)$/i.test((e.textContent || "").trim())) return;
    var box = e.closest("li, article, section, [data-d-component='box']") || e.parentElement;
    var a2 = box && box.querySelector("a[href]");
    ads.push({ text: line(box ? box.innerText : e.textContent).slice(0, 500), url: a2 ? a2.href : null });
  });
  return {
    found: true,
    complete: li.hasAttribute("data-message-complete"),
    messageId: li.id || null,
    url: location.href,
    text: TEXT(root, SKIP),
    markdown: MD(root, SKIP),
    html: li.outerHTML,
    links: links,
    cards: cards,
    reasoning: reasoning,
    ads: ads,
  };
})()`;

/** Answer progress on gemini.google.com. */
export const GEMINI_STATE_JS = String.raw`(() => {
  var rs = document.querySelectorAll("model-response");
  var mr = rs[rs.length - 1];
  var md = mr ? (mr.querySelector("message-content .markdown") || mr.querySelector("message-content")) : null;
  var text = md ? (md.innerText || "") : "";
  return {
    users: document.querySelectorAll("user-query").length,
    responses: rs.length,
    busy: mr ? mr.querySelectorAll("[aria-busy='true']").length : 0,
    actions: !!(mr && mr.querySelector("message-actions")),
    stop: !!document.querySelector("button[aria-label='Stop response']"),
    chars: text.length,
    head: text.slice(0, 400),
    url: location.href,
    editor: !!document.querySelector("rich-textarea [contenteditable='true']"),
    model: ((document.querySelector("[data-test-id='bard-mode-menu-button']") || {}).innerText || "").trim() || null,
  };
})()`;

/** Everything the Gemini answer shows. */
export const GEMINI_EXTRACT_JS = String.raw`(() => {
  var TEXT = ${TEXT_FN};
  var MD = ${MD_FN};
  var PRICE = ${PRICE};
  var rs = document.querySelectorAll("model-response");
  var mr = rs[rs.length - 1];
  if (!mr) return { found: false, url: location.href };
  var content = mr.querySelector("message-content");
  var md = content ? (content.querySelector(".markdown") || content) : mr;
  var line = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
  var CHIPS = "source-footnote, sup, .cdk-visually-hidden";
  var MD_SKIP = "source-footnote, sup, .cdk-visually-hidden, .source-inline-chip-container, sources-carousel-inline, source-inline-chip";
  var links = [], seen = {};
  Array.prototype.forEach.call(md.querySelectorAll("a[href]"), function (a) {
    var u = a.href;
    if (!/^https?:/.test(u) || seen[u]) return;
    seen[u] = 1;
    var internal = /(^|\.)gemini\.google\.com$/.test((function () { try { return new URL(u).hostname; } catch (e) { return ""; } })());
    links.push({ url: u, text: line(a.innerText).slice(0, 300), internal: internal });
  });
  var cards = [], used = [];
  Array.prototype.forEach.call(md.querySelectorAll("img"), function (img) {
    var src = img.currentSrc || img.src || "";
    if (!/gstatic\.com\/shopping|\/shopping\?q=tbn/.test(src)) return;
    var box = img.parentElement;
    for (var i = 0; i < 6 && box && !PRICE.test(box.innerText || ""); i++) box = box.parentElement;
    if (!box || used.indexOf(box) >= 0) return;
    used.push(box);
    var lines = (box.innerText || "").split("\n").map(line).filter(Boolean);
    var priceLine = lines.filter(function (l) { return PRICE.test(l); })[0] || null;
    var title = lines.filter(function (l) { return l !== priceLine && !/stars?|rating|& more/i.test(l); })[0] || "";
    var a = box.querySelector("a[href]");
    if (!a) a = Array.prototype.filter.call(md.querySelectorAll("a[href*='prds='], a[href*='/shopping/']"), function (x) { return line(x.innerText) === title; })[0];
    var rating = /(\d(?:\.\d)?)\s*stars?/i.exec(box.innerText) || /rating\s*(\d(?:\.\d)?)/i.exec(box.innerText);
    var reviews = /\(([\d.,]+\s?[kKmM]?\+?)\)/.exec(box.innerText);
    var merchant = lines.filter(function (l) { return /& more$|\bat\s+[A-Z]/.test(l) && !PRICE.test(l); })[0] || null;
    cards.push({ title: title, price: priceLine ? (PRICE.exec(priceLine) || [priceLine])[0] : null, merchant: merchant, rating: rating ? rating[1] : null, reviews: reviews ? reviews[1] : null, label: null, url: a ? a.href : null, image: src });
  });
  return {
    found: true,
    complete: mr.querySelectorAll("[aria-busy='true']").length === 0 && !!mr.querySelector("message-actions"),
    responseId: content && content.id ? content.id.replace(/^message-content-id-/, "") : null,
    url: location.href,
    model: ((document.querySelector("[data-test-id='bard-mode-menu-button']") || {}).innerText || "").trim() || null,
    text: TEXT(md, CHIPS),
    markdown: MD(md, MD_SKIP),
    html: mr.outerHTML,
    links: links,
    cards: cards,
    footnotes: md.querySelectorAll("source-footnote sup").length,
  };
})()`;

export type BlockerState = { url: string; title: string; challenge: boolean; captcha: boolean; signIn: boolean; limit: string | null; notices: string[] };
export type ChatGPTState = { errorCard: string | null; users: number; assistants: number; complete: boolean; stop: boolean; chars: number; head: string; url: string; composer: boolean };
export type GeminiState = { users: number; responses: number; busy: number; actions: boolean; stop: boolean; chars: number; head: string; url: string; editor: boolean; model: string | null };
export type PageLink = { url: string; text: string; internal: boolean };
export type PageCard = { title: string; price: string | null; merchant: string | null; rating: string | null; reviews: string | null; label: string | null; url: string | null; image: string | null; named?: boolean };
export type ChatGPTPage = { found: false; url: string } | { found: true; complete: boolean; messageId: string | null; url: string; text: string; markdown: string; html: string; links: PageLink[]; cards: PageCard[]; reasoning: string[]; ads: Array<{ text: string; url: string | null }> };
export type GeminiPage = { found: false; url: string } | { found: true; complete: boolean; responseId: string | null; url: string; model: string | null; text: string; markdown: string; html: string; links: PageLink[]; cards: PageCard[]; footnotes: number };
