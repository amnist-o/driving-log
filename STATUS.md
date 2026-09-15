# STATUS — Drive Log

Running log. Newest entry at the top. Old entries are the project's history — keep them.

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
