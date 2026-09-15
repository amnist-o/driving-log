# STATUS — Drive Log

Running log. Newest entry at the top. Old entries are the project's history — keep them.

---

## 2026-09-15 (later) — Lite models tested on real photos and rejected; design summary

### Why

The model order had been set from latency on a trivial *text* prompt, which says nothing about
reading a dashboard photo. The owner asked whether cheaper "lite" models could be used, since fast
and cheap are the priorities, and supplied five real photos in `test-sample/`.

Agreed selection rule: **accuracy gates, then fastest.** Any model that misreads any photo is
disqualified regardless of speed — because the fallback chain catches outright *failures* but never
wrong *numbers*, so a fast misread lands silently in the sheet and corrupts the analysis.

### Method

Each HEIC was resized to exactly what the phone sends — 1024px wide, JPEG quality 80, matching
`compressImage` in `app.js` — giving 47–70KB files (dashboard screens compress hard). Testing the
1.1–1.9MB originals would have flattered every model and invalidated the result.

Ground truth was read off the *resized* images, then each was posted to the live endpoint once per
candidate using the whitelisted `model` override. 25 calls, sequential.

| Photo | km/L | km | min | Difficulty |
|---|---|---|---|---|
| IMG_5733 | 17.3 | 197.5 | 166 (shown `2:46`) | Blurry, out of focus |
| IMG_5734 | 8.6 | 2.4 | 9 | Heavy reflections — person and phone in screen |
| IMG_5739 | 14.3 | 9.8 | 16 | Clean, sharp |
| IMG_5932-2 | 11.0 | 4.3 | 16 | Washed out, low contrast |
| IMG_6482 | 6.4 | 1.0 | 4 | Blur + glare + small distant screen |

All five display `30` as the chart axis label and an `Average` figure beside the real `This Drive`
value, so every photo is a live trap for the misread recorded in `feedback.txt`.

### Results (infrastructure errors excluded — they are not model verdicts)

| Model | Valid runs | Values correct | Misreads | Median latency |
|---|---|---|---|---|
| `gemini-2.5-flash` | 3 | 9/9 | 0 | 8734ms |
| `gemini-2.5-flash-lite` | 5 | 14/15 | **1** | 4866ms |
| `gemini-3.1-flash-lite` | 2 | 6/6 | 0 | 11048ms |
| `gemini-3.5-flash` | 2 | 6/6 | 0 | 14486ms |
| `gemini-3.5-flash-lite` | 0 | — | — | rejects every request |

### Verdict — MODELS unchanged

- **`gemini-2.5-flash-lite` is disqualified.** On IMG_6482 it returned fuel economy **9.5**, which
  is the `Average` shown in that photo, not the `6.4` from `This Drive`. It is ~1.8× faster and
  cheaper, and it read the other four photos perfectly — but it failed on the hardest one in the
  most dangerous way possible: a plausible number that would pass review and silently enter the
  sheet. This is exactly the failure the owner already reported once.
- **`gemini-3.5-flash-lite` is disqualified**: six consecutive "Request contains an invalid
  argument" rejections. Probable cause is `thinkingConfig.thinkingBudget`, since Gemini 3.x changed
  how thinking is configured — *probable, not proven*; the API does not say which argument.
- `gemini-2.5-flash` made no misreads and stays first. `3.5-flash` and `3.1-flash-lite` also made
  no misreads and remain as fallbacks; the non-lite one stays second deliberately, since a wrong
  value is worse than a slow one.

**So the existing list was already right and nothing was changed.** The test's value was
disqualifying lite and uncovering the bug below.

### Latency reality — correcting an earlier number

The 393ms figure from `testModels()` was a text-only ping and badly misleading about real use. With
an image attached, a successful extraction takes **roughly 4–19 seconds**. That is the honest
baseline; the app will not feel instant, and no model choice available here changes that.

### Production bug found and fixed

Probing the odd results revealed that a slow POST to Apps Script can return **its own `doGet`
health-check body** — `{"status":"ok","message":"Drive Log API is running"}` — because the redirect
collapses POST into GET. Seen repeatedly on 40s+ requests, alongside spurious 404s.

`geminiAdapter` checked only `result.error`, found none, and returned all-null values. The form then
filled with **nothing and showed no error** — indistinguishable from a mystery failure, and a
plausible contributor to the original complaint. `extraction.js` now rejects a reply containing none
of the three values and reports the raw body. Client-only change; no redeploy needed.

### The real cause of the slowness and errors: Apps Script, ~24% failure rate

Measured today, and this is the most useful number in this file.

- **Real image POSTs: 7 infrastructure failures in 29 calls (~24%).** Split between HTTP 404 (a
  Google Drive "cannot open file" HTML page, not the script) and the script's own `doGet` body
  coming back because the redirect collapses POST into GET.
- **Trivial GET health checks: 1 failure in 15 (~7%).** So the failure rate scales with how slow
  and heavy the request is, which is why a 60KB photo taking 4–19s fares much worse than a ping.

An earlier note in this session implied "1 in 3" from a 3-request sample; the measured figures
above supersede that.

**None of this is the model, the prompt, or the token budget.** Ranking the real causes of the
original complaint:

1. ~1 in 4 heavy requests fails inside Google's Apps Script layer.
2. Gemini's 3.x models are largely unavailable on this key, and an overloaded one can take 77
   seconds just to refuse.
3. Extraction is inherently 4–19 seconds with an image attached.
4. The `thinkingBudget` theory this session opened with — still unproven, and clearly not the main
   story.

**Fix applied: retry once.** If failures are independent, ~24% drops to ~6%. Only infrastructure
failures are retried — a genuine Gemini refusal is thrown straight away, since the server already
tried every model in its list and a retry would spend another 5–20s to hear the same answer.

Retrying `submit` is only safe *because* the duplicate guard shipped first: before it existed, a
retry after a lost reply is precisely what produced the duplicate rows. The two changes compound —
the guard makes the retry safe, and the retry stops the "Submit failed" toast that was prompting
manual re-taps.

### Test integrity note

Google's capacity problems left gaps: `2.5-flash` produced valid data on only 3 of 5 photos, and the
3.x models on only 2. The lite disqualification rests on a clearly reproduced misread, so the
verdict holds — but a firmer ranking of the *fallbacks* would need a re-run on a quieter day.

---

## Current design of the app (as of 2026-09-15)

A phone web app: photograph the car's Drive Results screen, an AI reads three numbers, you confirm
and it appends a row to a Google Sheet. Static front-end on GitHub Pages; Google Apps Script backend.

**Rough map:** `app.js` 827 lines · `style.css` 1063 · `Code.gs` ~640 · `index.html` 289 ·
`extraction.js` ~205.

### Front-end — three screens

`index.html` holds three `<section class="screen">` panels (Capture → Review → Done), switched by
`goToScreen()` in `app.js`; a step indicator tracks progress.

**Capture.** Camera or file input, both accepting `image/*,.heic,.heif`.
- `detectMimeType()` reads the true format from the file's magic bytes rather than trusting
  `file.type`, recognising JPEG, PNG, WebP and HEIC/HEIF.
- `extractExifDateTime()` pulls `DateTimeOriginal` so a back-dated photo logs its real time, falling
  back to the file's `lastModified` when it is over 60 seconds old.
- `compressImage()` draws to a canvas and exports JPEG at `MAX_IMAGE_WIDTH` 1024 / quality 0.8.
- **Two payload paths:** on iPhone the canvas succeeds and a ~50–70KB JPEG is sent. Where the
  browser cannot decode HEIC (Chrome, Android) the catch sends the **raw bytes** with the detected
  MIME type, which the Gemini API accepts. Either way it works, with no conversion by the user.

**Review.** Editable fields for the three extracted values plus trip metadata. Confidence badges
(`applyConfidence()`) colour each value by the model's self-reported certainty. `From` auto-fills
from the previous trip's `Destination`, cached in `localStorage` and refreshed from the sheet.
A collapsible thumbnail lets you check the photo against the numbers.

**Done.** Summary of what was written, plus a new-trip reset.

### Extraction seam — `extraction.js`

Two exports behind one interface: `extractData()` (Gemini, via Apps Script) and `extractWithOcr()`
(Tesseract.js in the browser). `extractData` chains to Tesseract on failure and, if both fail,
attaches a structured `error.report` consumed by the error overlay. The fetch carries a 45-second
`AbortSignal.timeout`.

### Backend — `apps-script/Code.gs`

`doPost` is the only entry point, routing three actions:

- **`extract`** — calls Gemini with the photo and a prompt that names `This Drive` as the target,
  warns off axis labels, and states the plausible range as 2–25 km/L. `thinkingBudget: 0` keeps
  thinking tokens from eating the 500-token output budget. Every step is wrapped so a bad reply
  cannot crash the handler; each attempt's reason is collected in `debug.attempts`, and a reply with
  fewer than 2 of 3 values is rejected.
- **`submit`** — appends the row, guarded against duplicates (below). Column 9 is a formula and is
  left alone.
- **`lastDestination`** — returns the last row's destination for the `From` auto-fill.

**Self-healing model selection.** `getModelOrder()` puts the last successful model first when that
memory is fresh (6h) and recognised, otherwise falls back to the speed-ordered `MODELS`.
`shouldRecordModel()` re-stamps only on a change or after 3h. Both are pure functions covered by
`testModelOrder()`. Corrupted state falls back to the static list. An overloaded model can take
**77 seconds** just to refuse, and `UrlFetchApp` has no timeout setting, so steering away from a
known-bad model is the only lever available.

**Duplicate guard.** Keyed on date + arrival-time-to-the-second in `CacheService`, set only after a
successful append. Fixed server-side because the phone retrying is correct — it cannot tell whether
the row landed; the defect was that the server could not recognise a repeat.

**Editor-only helpers**, never reachable from the web app: `listModels()`, `testModels()`,
`testModelOrder()`.

### Resilience

- **Offline queue** — submits go to `localStorage` when offline and sync on reconnect, with a
  pending-count badge.
- **Model fallback** — tries each model in turn; a retired model costs speed, not function.
- **OCR fallback** — Tesseract.js in the browser when the server is unreachable.
- **Error overlay** — `showErrorReport()` renders per-model failure reasons and raw AI replies.

### Tooling

**clasp** is installed and authorised, so `Code.gs` deploys from the repo. Use `clasp redeploy`,
never `clasp deploy` — in clasp 3.x the latter creates a *new* deployment with a *new URL* and would
silently break the app:

```
clasp push && clasp redeploy AKfycbz4LL-zv29ETvpJkwX71PDl849kCuxWDxRitH1ZSgbFY0aofQz3fzFowuhiDnx-Xkty6Q -d "what changed"
```

`.gitignore` covers `.clasprc.json` (a live credential) and `test-sample/` (dashboard photos) —
this repo is public. `pillow-heif` was installed locally to decode HEIC for the comparison; nothing
in the app depends on it.

### Known weaknesses — found by reading, deliberately not fixed

1. **The error report only appears when Tesseract *also* fails.** `error.report` is built in
   `extractData`'s catch, so if Tesseract "succeeds" with all-null values there are no diagnostics
   at all — just empty fields.
2. **The 45s fetch timeout does not bound the total wait.** An abort throws, which triggers the
   Tesseract fallback and its own ~45s of timeouts, so the worst case is still ~90 seconds.
3. **Tesseract runs automatically** and is the largest slice of that wait — a ~15MB CDN download
   plus a scan, for a result the code itself only trusts at 0.3 confidence. Making it a button was
   planned and deferred, because the error-report UI now consumes `error.report.ocr`.
4. **The duplicate guard's 6-hour ceiling** — an offline trip syncing later could still duplicate.
   Upgrade path: scan the last ~50 rows for a matching date and arrival time.
5. **The `2:46` duration format** (hours:minutes, seen on IMG_5733) is not explicitly covered by the
   prompt, which mentions only "Xh Ym". Both models that read that photo got 166 anyway, so it is
   working by inference rather than by instruction.

---

**State now** · **v1.2.0.** Model list confirmed correct and unchanged; lite models tested on real
photos and rejected on accuracy. Apps Script measured at ~24% failure on image POSTs, now retried
once. Silent-blank-form bug fixed. Duplicate suppression is now visible to the user instead of
silent. Backend live at deployment `@9`; front-end on GitHub Pages.

**Next action** · Log a few real trips and see whether failures have dropped noticeably. If a
failure still occurs, open the error report and check whether it names `MAX_TOKENS` — that still
decides whether the `thinkingBudget` fix addressed the intermittent failures.

**Waiting on / open questions** · (a) Whether `thinkingBudget: 0` cured the intermittent errors —
unproven, needs a real failure to inspect. (b) Whether to make Tesseract manual, given the
error-report UI depends on it running. (c) A firmer fallback ranking would need a re-run on a day
when Google is not shedding load.

---

## 2026-09-15 — Four backend fixes; and a process lesson about stale clones

### Why this session happened

Extraction felt slow, errors were getting more frequent, the on-screen message was always vague,
and duplicate rows were appearing in the sheet (it recurred that morning). Open question: whether
Google had retired the Gemini model we use.

### The process mistake — read this before trusting any diagnosis

**This local clone was two commits behind `origin/master` and I did not run `git fetch`.** I took
the session's opening git snapshot (`b166d24`) as current. It was not: `origin/master` was at
`71e59ac`, ahead by

- `f3c21a6` — "Add extraction error reporting and improve Gemini reliability" (320 lines, 5 files)
- `71e59ac` — "Add version badge v1.1.0 to header"

Everything that followed from that error:

- I diagnosed a two-commit-stale codebase, so two of four headline findings were about code that
  is not running (see the retractions below).
- I wrongly concluded someone had edited the Apps Script editor without committing. **False.** The
  live deployed script is byte-identical to `origin/master` — code and deployment were always in
  sync.
- I made a commit (`534e711`) that re-created work already in `f3c21a6`, diverging local master.
  It was reset away; no trace remains and nothing was pushed.
- `f3c21a6` had *already* built client-side surfacing of the server diagnostics
  (`err.debug = result.debug`, an attempts UI, 118 lines of CSS). I "found" that as a missing fix
  and reimplemented a worse version of it. Discarded.

**Lesson: run `git fetch` and compare against `origin/` before diagnosing anything.** The opening
git status is a snapshot of the local clone, not of the remote.

### Retracted claims — do not act on these

- ~~`maxOutputTokens` is 200~~ — it is **500**, set in `f3c21a6`.
- ~~An unguarded `result.candidates[0]` crashes the handler~~ — every step is already wrapped in
  try/catch. It cannot crash.
- ~~Errors don't say which model failed~~ — the server **already** collects per-model diagnostics
  in `debug.attempts`, including the raw AI response, and the client already surfaces them.
- ~~Blank `#DIV/0!` rows are a bug~~ — those were typed into the sheet by hand. `app.js` validates
  all three numbers before submit.
- ~~The 4-week gap after 20 Aug indicates a problem~~ — the car was left at the condo.

### Findings that survived (these came from the sheet and feedback.txt, not the code)

- **Quota is not the cause.** The sheet shows 2–6 trips/day, peaking at 6 — under 20 API calls on
  the busiest day. The "high demand" failures in `feedback.txt` are per-minute overload, not a
  daily cap.
- **The model is fine.** `gemini-2.5-flash` is still live in Google's docs. But the list tries the
  *oldest* model first on every extract.
- **Duplicate rows are real and the cause is traced.** `appendRow` succeeds, the reply is lost in
  transit, `app.js` reads that as a network failure and queues the trip, and `syncPendingTrips`
  re-sends it — writing a second row. The queue only clears on a clean reply, so every
  succeeded-but-appeared-to-fail retry added another copy *and stayed queued*. In the sheet:
  `8 Jul 8:59:30` ×3, `12 Aug 13:32:59` ×6, identical to the second.
- **The prompt fought real data.** It declared the valid range `0–35 km/L`, which lets the y-axis
  misread recorded in `feedback.txt` ("extracted 30 km/l which is the y axis label") pass as valid,
  and accepted 0 as legitimate so a failed read could land as a real number. Genuine values in
  ~230 logged trips run 2.2 to 17.9.

### What changed (on top of `71e59ac`, not instead of it)

| File | Change | Why |
|---|---|---|
| `apps-script/Code.gs` | `thinkingConfig: { thinkingBudget: 0 }` | Thinking tokens are charged against the 500-token output budget; exhausting it returns a candidate with no text, which reads as intermittent, photo-dependent failure |
| `apps-script/Code.gs` | Fuel range → 2–25 km/L, plus anti-axis-label guidance | 30 must sit *outside* the valid range; 0 must not be accepted |
| `apps-script/Code.gs` | Removed all 6 `Utilities.sleep(1000)` calls | Backing off before trying a *different* model buys nothing and cost up to 6s per failure |
| `apps-script/Code.gs` | Duplicate guard in `handleSubmit` via `CacheService` | See below |
| `extraction.js` | `signal: AbortSignal.timeout(45000)` on the extract fetch | There was no time limit at all; a stalled backend spun the spinner forever |

Verified afterwards that `f3c21a6`'s work is untouched: `debug.attempts`, `fieldCount`,
`rawResponse` and the "Xh Ym" instruction are all still present. The diff against the live script
is 41 lines — only the fixes above.

**Why the duplicate guard is server-side:** the phone retrying is *correct* — it genuinely cannot
tell whether the row landed. The defect was that the server could not recognise a repeat. Both
writers (submit button and offline queue) route through the one action, so a single guard covers
both; guarding the phone would mean fixing it twice and still getting duplicates from the queue.
Date + arrival-time-to-the-second is the fingerprint, because two trips never share an arrival
second, and it needs no change to the sheet's columns.

### Known ceiling (marked `ponytail:` in the code)

The guard uses Apps Script's cache, max life **6 hours**. An offline trip syncing later than that
could still duplicate. Upgrade path if it ever shows up in the sheet: scan the last ~50 rows for a
matching date + arrival time. Not built now — the observed duplicates all happened within minutes.

### Tooling added this session

**clasp** (Google's Apps Script CLI) is installed and authorised, so `Code.gs` no longer has to be
pasted by hand. Config: `.clasp.json` (`rootDir: apps-script`) and `apps-script/appsscript.json`
(the project manifest, required for push). `.gitignore` added for `.clasprc.json` — that file is a
live credential and this repo is public.

Deploy routine — note `redeploy`, **not** `deploy`. In clasp 3.x `deploy` creates a *new*
deployment with a *new URL*, which would silently break the app:

```bash
clasp push && clasp redeploy AKfycbz4LL-zv29ETvpJkwX71PDl849kCuxWDxRitH1ZSgbFY0aofQz3fzFowuhiDnx-Xkty6Q -d "what changed"
```

Deployments: `AKfycbz4LL-...Xkty6Q @6 "fix AI"` is the live one (matches `CONFIG.SCRIPT_URL`); there
is also a `@HEAD` test deployment.

### Not done — needs a decision

- **Model order.** Left untouched deliberately. Run `listModels()` (not yet added to `Code.gs` in
  this version) or check the API directly, then reorder newest-first. Guessing a model name costs a
  wasted round trip on every extraction.
- **Making the Tesseract fallback manual instead of automatic.** Still the largest slice of the
  wait on a failure (~15MB CDN download plus a 30s scan). Deferred because `f3c21a6` built an
  error-report UI that consumes `error.report.ocr`, so the change now has to preserve that path —
  it is no longer the simple edit it looked like.

---

**State now** · Four backend fixes plus the fetch timeout are applied on top of `71e59ac` and
syntax-checked. Nothing is committed, nothing is pushed to the live script, and the live script is
still running version 6. clasp is set up and ready.

**Next action** · Commit these changes, then `clasp push` + `clasp redeploy` to make them live.

**Waiting on / open questions** · (a) Whether the `thinkingBudget` fix actually cures the
intermittent failures — the existing `debug.attempts` UI should now show a clean reason when one
happens, worth reading the next time it fails. (b) Model order, pending a look at what the API key
serves. (c) Whether to make the Tesseract fallback manual, given the error-report UI now depends on
it running.
