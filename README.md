# capture-engine

Built on Patchright (a patched Playwright that drives real Google Chrome without the usual
automation tells), it replaces two things:

- the retail audit tool's capture side: same job and same output files as v1, so v1's
  extractor, the Google Sheet and the AI answer collector keep working;
- Bright Data's ChatGPT and Gemini scrapers (`npm run ask`, see [Answers](#answers-replacing-bright-data)):
  same row fields, so the AI answer collector reads a row as it reads a Bright Data row.

Runs on Windows (this PC); macOS works too.

## Setup

```powershell
npm install
copy .env.example .env      # then fill in the IPRoyal username and password
```

Google Chrome must be installed (the engine drives the installed Chrome, `channel: "chrome"`).

**In PowerShell, type `npm.cmd`, not `npm`, whenever options follow `--`.** PowerShell drops
the `--` from `npm run x -- --option`, npm then keeps the options for itself and the tool
never sees them. Both tools stop with this advice when that happens (src/cliArgs.ts).
`npx tsx src/answers/cli.ts <options>` works too.

## Self-test

Launches Chrome exactly as captures will and checks what websites can see.

```powershell
npm.cmd run selftest -- --sites probe   # identity probe only (fast)
npm.cmd run selftest                    # probe + CreepJS, Sannysoft, Browserscan, Pixelscan, IPHey
npm.cmd run selftest -- --use-proxy     # through IPRoyal (needs .env)
```

Options: `--tz none|emulate|env`, `--window offscreen|visible`, `--viewport native|fixed`,
`--flags "--chrome-switch ..."`, `--profile <name>`. Results go to
`output/selftest/<time>-<label>/` (report.json and one screenshot per site).

## Launch settings, and why (measured on this PC, 3 Nov 2026)

- Patchright 1.64.3 + installed Chrome 156, headed, persistent profile, **no emulated viewport**.
  v1's fixed 1280x800 viewport made sites see a 1280x800 screen holding a 1296x882 window
  and a device pixel ratio of 1.0000000149, both impossible on a real PC.
- Window 1280x816: the page is 1280 CSS px wide like v1. Screenshots use `scale: "css"`, so
  this PC's 125% display scaling doesn't change image sizes.
- Timezone by Chrome's emulation (`timezoneId`): page and workers agree. The `TZ` environment
  variable is ignored by Chrome on Windows.
- Language by Chrome's `--lang` only. Playwright's `locale` option changed the page's
  languages but not its workers' (page "en-US", worker "en-US,en").
- Windows are visible by default, so you can watch; `--window offscreen` parks them at
  -2400,-2400 instead (the page still reports itself visible and focused). On screen, Windows
  11's window frame takes 15 px of the width, so the window is widened after launch until the
  page is exactly 1280 px.
- Chrome's security sandbox is on (`chromiumSandbox: true`). Playwright turns it off by
  default (`--no-sandbox`), which also put a warning bar on the window.
- One warning bar remains, "unsupported command-line flag: --disable-blink-features=
  AutomationControlled". That is Patchright's flag and it must stay: without it
  `navigator.webdriver` is true and every detector flags the browser (measured: CreepJS 33%
  headless, Sannysoft 1 failed, Browserscan "Robot", Pixelscan "automation detected"). Pages
  cannot see the bar.

Self-test without proxy (sandbox on, visible window, this PC's own timezone): CreepJS 0%
headless / 0% stealth, Sannysoft 31/31, Browserscan Normal, Pixelscan consistent with no
automation or masking, IPHey Trustworthy. With New York time on a non-US IP IPHey says
Unreliable, which the US proxy fixes.

## Answers (replacing Bright Data)

Asks ChatGPT (chatgpt.com) and Gemini (gemini.google.com) through their own websites,
logged out, in real Chrome, one new conversation per question, and keeps one row per
answer plus a screenshot of the conversation.

```powershell
npm.cmd run ask -- --prompt "What are the best smartphones to buy in 2026?"
npm.cmd run ask -- --prompts prompts.txt --runs 3 --use-proxy       # one prompt per line
npm.cmd run ask -- --prompts prompts.jsonl --out output/answers/x   # {"id","prompt"} per line; rerun resumes
npm.cmd run inspect -- output/answers/<run>/rows/chatgpt/p001-r1.json
```

Options: `--engines chatgpt,gemini`, `--runs N`, `--use-proxy` (IPRoyal, US time; not
`--proxy`, which is npm's own setting), `--gap 20-40` (seconds between questions per app),
`--retries 2`, `--timeout 240`, `--limit N`, `--window visible|offscreen` (visible: ChatGPT's
window at the left edge, Gemini's 240 px to the right; don't click in them while they work).
Each app runs in its own Chrome profile (`answers-chatgpt`, `answers-gemini`) and, with
`--use-proxy`, its own sticky US address; the two apps run side by side, one question at a
time each.

When something goes wrong:
- ChatGPT sometimes answers a question with an error box ("ChatGPT is temporarily
  experiencing issues… [Retry]", 3 Nov 2026, not an outage). The tool presses Retry, as a
  person would, up to twice, and notes it in the row's warnings; then it gives up on that
  conversation.
- A failed attempt is tried again in a new conversation after 30-60 s (3-6 min, longer each
  time, after a bot check, a rate limit or a sign-in request), up to `--retries` times.
- Every read of the page has a time limit and each attempt as a whole has one
  (`--timeout` + 3 min); an attempt past it is recorded as an error and the app gets a fresh tab.
- After three blocked, rate-limited or sign-in attempts in a row an app is left alone for the
  rest of the run.

Output in `output/answers/<time>-<label>/`: `rows/<engine>/<id>-r<run>.json` (the row),
`screenshots/<engine>/<id>-r<run>.jpg` (the whole conversation at 1280 px),
`index.jsonl` (one line per attempt, latest per job wins) and `summary.json`.

**How each app is asked**

- ChatGPT: `https://chatgpt.com/?q=<prompt>&hints=search`, the link format ChatGPT uses
  itself, with web search on, as Bright Data's `web_search: true` did. If the link does not
  send the question within 12 s, the question is typed into the composer.
- Gemini: opens `/app`, types the question with uneven key timing, presses Enter.

**Where each field comes from** (page = what the page shows; stream = the app's own answer
stream, captured from Chrome's network layer with `Network.streamResourceContent`)

| Row field (Bright Data's name) | ChatGPT | Gemini |
|---|---|---|
| `answer_text` | page text of the answer (no "Worked for…" or action-bar text) | page text of the answer |
| `answer_text_markdown` | stream: OpenAI's own markdown (`fallbackMarkdown` for laid-out answers) | stream: Gemini's markdown |
| `citations` | stream: cited sources with publisher and date | stream: cited sources with snippet, publisher and the answer spans they back |
| `search_sources` | stream: every page the web search returned | stream: every "Searched the web" result |
| `links_attached` | page: external links in the answer | page: external links in the answer |
| `shopping`, `shopping_visible` | page: product cards (name, price as shown, merchant, label, image) | page: Google Shopping cards (not yet seen: needs a US address) |
| `web_search_triggered` | stream: search activity | stream: search block present |
| `model` | null: logged-out ChatGPT names no model; routing tags in `capture.model_detail` | page: the mode button ("Flash-Lite") |
| `ads` | page: units labelled "Sponsored" (none seen yet: needs a US address) | — |
| `answer_html`, `answer_section_html` | the page, the answer element | the page, the answer element |
| `response_raw` | the stream, minus layout snapshots superseded by a later one | the stream as received |
| `country` | the proxy's country; null without the proxy | same |

Extra, under `capture`: Gemini's own statement of where it placed us (`ip_location`, e.g.
"Saharanpur, Uttar Pradesh, India" without the proxy), ChatGPT's product entities, the
search notes ("Searched 8 websites"), Gemini's footnote count, timings, versions, the
screenshot path and `warnings` (checks every answer gets: interface text in the answer, a
search with no sources read, footnotes without citations, a location outside the requested
country, no screenshot).

Fields Bright Data returned that the collector never reads are not produced:
`is_map`, `map`, `business_locations`, `references`, `recommendations`,
`additional_prompt`, `additional_answer_text`, `answer_text_raw`, `search_sources_more`.

**Tested on this PC, 3 Nov 2026, without the proxy (Indian IP)**: 8 questions to ChatGPT and
9 to Gemini through `npm run ask`, all answered first time; median 19 s (ChatGPT) and 27 s
(Gemini) per answer. Gemini's citation spans matched its footnotes on the page (13 of 13 in
one answer, 9 of 9 in another); ChatGPT's product cards were checked against the screenshots
and re-read offline from the saved pages after the last fix. A rerun into the same folder
skipped what was already answered. Not yet tested: anything through the US proxy (answers, ads, Gemini
shopping cards, megabytes per answer), and volume (how many logged-out questions per address
each app accepts per day).

## Status

| Phase | What | State |
|---|---|---|
| 0 | Baseline v1 on a fixed test list | waiting on IPRoyal credentials |
| 1 | Browser core: launch, per-site profiles, proxy relay, identity, keep-awake, self-test | built; passes without proxy; proxy run pending credentials |
| 2 | Page pipeline and retailer profiles (Amazon, Walmart, Best Buy first) | — |
| 3 | Capture files identical to v1, stable IDs, upload retries | — |
| 4 | Run engine: lanes, per-retailer gap, resume | — |
| 5 | Side-by-side with v1, then switch | — |
| A | Answers: ChatGPT and Gemini in place of Bright Data (`npm run ask`) | built; tested without proxy; proxy and volume runs pending credentials |
