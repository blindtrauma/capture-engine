// One answer as it leaves the capture engine. Field names follow Bright Data's ChatGPT and
// Gemini datasets, so the AI answer collector reads a row exactly as it reads a Bright Data
// row (answer_text, citations, links_attached, search_sources, shopping, model, ...). What
// Bright Data never returned sits under `capture`.

export type AnswerEngine = "chatgpt" | "gemini";

export const ENGINE_HOME: Record<AnswerEngine, string> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
};

export type Citation = {
  url: string;
  title: string;
  /** the snippet the app shows for the source */
  description: string | null;
  /** publisher as the app labels it ("91mobiles", "Best Buy") */
  source: string | null;
  /** publication date as the app shows it */
  date: string | null;
  /** the answer text this source backs (Gemini) */
  cited_text: string[];
  /** order in the answer, from 1 (Bright Data's citations.position) */
  position: number;
};

export type SearchSource = { url: string; title: string; source: string | null; favicon: string | null };

/** position: order in the answer, from 0 (Bright Data's links_attached.position) */
export type Link = { url: string; text: string; position: number };

/** A product card in the answer: what the page shows for it. */
export type ShoppingItem = {
  title: string;
  price: string | null;
  merchant: string | null;
  rating: string | null;
  reviews: string | null;
  /** the card's label ("Best overall Android") */
  label: string | null;
  url: string | null;
  image: string | null;
};

export type Ad = { text: string; url: string | null };

export type ErrorCode =
  | "blocked" // bot check or captcha the page did not clear
  | "login_required" // the app asked to sign in before answering
  | "rate_limited" // the app refused more questions for now
  | "answer_error" // the app showed an error instead of an answer
  | "no_answer" // no finished answer before the deadline
  | "navigation" // the page did not load
  | "internal"; // our own failure

export type AnswerRow = {
  /** where the answer lives (the conversation page) */
  url: string | null;
  /** same as url: the collector reads answer_url for the evidence link */
  answer_url: string | null;
  prompt: string;
  /** the caller's id for this prompt */
  index: string | null;
  /** the market the answer was asked from (the proxy's country), null without a proxy */
  country: string | null;
  input: { url: string; prompt: string; country: string | null; web_search?: boolean };
  prompt_sent_at: string;
  /** when the answer was complete */
  timestamp: string;
  /** the answer as the page shows it, as plain text */
  answer_text: string;
  answer_text_markdown: string | null;
  /** the whole page at capture time */
  answer_html: string | null;
  /** the answer element only */
  answer_section_html: string | null;
  citations: Citation[];
  links_attached: Link[];
  /** every page the app's web search returned, cited or not */
  search_sources: SearchSource[] | null;
  shopping: ShoppingItem[];
  shopping_visible: boolean;
  web_search_triggered: boolean | null;
  /** the model the app names, null when it names none (logged-out ChatGPT) */
  model: string | null;
  /** sponsored units found in the answer; null when none was recognised */
  ads: Ad[] | null;
  /** the app's own answer stream as captured from the network */
  response_raw: string | null;
  error: string | null;
  error_code: ErrorCode | null;
  capture: CaptureInfo;
};

export type CaptureInfo = {
  tool: "capture-engine";
  engine: AnswerEngine;
  versions: { patchright: string; chrome: string | null };
  profile: string;
  proxy: { country: string; session: string } | null;
  /** where the app placed us (Gemini states the location it inferred from the IP) */
  ip_location: string | null;
  conversation_id: string | null;
  message_id: string | null;
  /** ChatGPT's routing tags for the turn (plan type, model experience, use case) */
  model_detail: Record<string, string> | null;
  /** products the answer names as product entities (ChatGPT) */
  entities: string[];
  /** "stream": the app's own markdown; "page": converted from the page */
  markdown_from: "stream" | "page" | null;
  /** search / reasoning notes the app showed ("Searched 8 websites") */
  reasoning: string[];
  /** footnote markers on the page (Gemini), to check the citations against */
  footnotes: number | null;
  screenshot: string | null;
  timings: { sent_at: string; first_text_at: string | null; complete_at: string | null; ms: number };
  attempt: number;
  warnings: string[];
};

export type AskJob = { engine: AnswerEngine; prompt: string; index: string | null; run: number };
