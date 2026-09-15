/* ==========================================
   DRIVE LOG — Google Apps Script Backend
   
   This script handles two actions:
   1. "extract" — Sends dashboard photo to Gemini Flash, returns extracted values
   2. "submit"  — Appends a row to the Google Sheet
   
   SETUP:
   1. Open your Google Sheet
   2. Go to Extensions → Apps Script
   3. Paste this entire file into the editor (replace any existing code)
   4. Click the gear icon (Project Settings)
   5. Under "Script Properties", add:
      - GEMINI_API_KEY = your Gemini API key
   6. Click Deploy → New deployment
   7. Type: Web app
   8. Execute as: Me
   9. Who has access: Anyone
   10. Click Deploy and copy the URL
   11. Paste that URL into app.js CONFIG.SCRIPT_URL
   ========================================== */

// ===== CONFIGURATION =====
const SHEET_GID = 353772877; // Your sheet tab's gid

// Preference order: FASTEST FIRST, measured by testModels(), not newest-first.
// Measured 2026-09-15: 2.5-flash 393ms; 3.5-flash 9708ms; 3.6/3.7/3.8/flash-latest
// all rejected with "high demand" on this key. Newer is NOT better here.
// Re-run testModels() and reorder if extraction starts feeling slow.
const MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];

// Self-healing: remember which model last worked so a model that is down does
// not cost a slow failure on every single trip. An overloaded model can take
// over a minute just to say no (measured: 77s), and UrlFetchApp has no timeout
// setting, so avoiding a known-bad model is the only lever available.
// Models the public endpoint will accept as a one-off `model` override, for
// comparing candidates against a real dashboard photo. Whitelisted so a public
// endpoint cannot be talked into spending the owner's quota on any model.
const TESTABLE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite'
];

const LAST_GOOD_KEY = 'lastGoodModel';
const LAST_GOOD_TTL_MS = 6 * 60 * 60 * 1000;   // after this, re-probe MODELS[0]
const LAST_GOOD_REFRESH_MS = 3 * 60 * 60 * 1000; // re-stamp a still-winning model

/**
 * Build the order to try models in: last known good first (if fresh and known),
 * then the measured preference order, deduplicated.
 *
 * Pure function of its inputs so it can be tested — see testModelOrder().
 *
 * @param {string|null} stored - raw property value, "model|timestampMs"
 * @param {number} nowMs
 * @returns {string[]}
 */
function getModelOrder(stored, nowMs) {
  const preferred = MODELS.slice();
  if (!stored) return preferred;

  const parts = String(stored).split('|');
  const model = parts[0];
  const at = parseInt(parts[1], 10);

  if (!model || !at || isNaN(at)) return preferred;      // malformed
  if (nowMs - at > LAST_GOOD_TTL_MS) return preferred;   // stale: re-probe the fast one
  if (preferred.indexOf(model) === -1) return preferred; // not a model we know

  return [model].concat(preferred.filter(function (m) { return m !== model; }));
}

/**
 * Should we write the winning model back? Avoids a property write on every
 * single extraction while keeping the stamp fresh enough that a persistently
 * down primary is not retried on every trip.
 */
function shouldRecordModel(stored, model, nowMs) {
  if (!stored) return true;
  const parts = String(stored).split('|');
  if (parts[0] !== model) return true;
  const at = parseInt(parts[1], 10);
  if (!at || isNaN(at)) return true;
  return (nowMs - at) > LAST_GOOD_REFRESH_MS;
}

/**
 * Handle GET requests (just a health check)
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'Drive Log API is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle POST requests
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.action === 'extract') {
      return handleExtract(data);
    } else if (data.action === 'submit') {
      return handleSubmit(data);
    } else if (data.action === 'lastDestination') {
      return handleLastDestination();
    } else {
      return jsonResponse({ error: 'Unknown action: ' + data.action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

/**
 * Extract fuel economy, distance, duration from dashboard image using Gemini.
 * On failure, returns { error, debug: { attempts[] } } for client-side diagnostics.
 */
function handleExtract(data) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'GEMINI_API_KEY not set in Script Properties' });
  }

  // Try last-known-good first, then the measured preference order
  const props = PropertiesService.getScriptProperties();
  const storedGood = props.getProperty(LAST_GOOD_KEY);

  // Optional single-model override, for A/B testing one model against a real
  // photo (see the comparison workflow in STATUS.md). Whitelisted: this endpoint
  // is public, so an arbitrary model name here would let anyone spend the
  // owner's API quota on a model of their choosing. No fallback when overriding,
  // so a test result is unambiguously about the model asked for.
  const override = data.model && TESTABLE_MODELS.indexOf(data.model) !== -1
    ? data.model
    : null;

  const models = override ? [override] : getModelOrder(storedGood, Date.now());
  var attempts = [];

  for (var m = 0; m < models.length; m++) {
    var model = models[m];
    var attempt = { model: model };
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + model + ':generateContent?key=' + apiKey;

    var payload = {
      contents: [{
        parts: [
          {
            text: 'You are reading a car dashboard trip-summary screen photo.\n'
              + 'Read the PROMINENT DISPLAYED VALUES on the screen — NOT chart axis labels, scale markers, or decorative numbers.\n\n'
              + 'Extract these three values:\n'
              + '- fuel_economy: the large number associated with "This Drive" or a similar per-trip heading, in km/L (float). '
              + 'Short city trips legitimately read as low as 2 km/L; the highest plausible value is about 25. '
              + 'A value that exactly matches a round chart-axis number (10, 20, 30) is almost certainly an '
              + 'axis label rather than the reading — prefer the large value under the per-trip heading.\n'
              + '- distance: Driving Distance in km (float).\n'
              + '- duration: Driving Time in minutes (integer). If shown as "Xh Ym", convert to total minutes.\n\n'
              + 'For each value, also provide a confidence score between 0.0 (guess) and 1.0 (certain).\n\n'
              + 'Return ONLY valid JSON — no markdown, no explanation:\n'
              + '{"fuel_economy": <number>, "distance": <number>, "duration": <number>, '
              + '"confidence": {"fuel_economy": <0-1>, "distance": <0-1>, "duration": <0-1>}}'
          },
          {
            inline_data: {
              mime_type: data.mimeType || 'image/jpeg',
              data: data.image
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 500,
        responseMimeType: 'application/json',
        // Reading three numbers off a screen needs no internal reasoning, and
        // thinking tokens are charged against maxOutputTokens. Left on, the model
        // can spend the whole 500 thinking and return a candidate with no text —
        // which surfaces as "No usable response from AI" on a photo that would
        // otherwise read fine, i.e. intermittent and photo-dependent.
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    // --- Fetch ---
    var response, result;
    try {
      response = UrlFetchApp.fetch(url, options);
      result = JSON.parse(response.getContentText());
    } catch (fetchErr) {
      attempt.error = 'Fetch failed: ' + fetchErr.message;
      attempts.push(attempt);
      if (m < models.length - 1) { continue; }
      return jsonResponse({ error: 'All models failed (network)', debug: { attempts: attempts } });
    }

    // --- API error (quota, invalid key, etc.) ---
    if (result.error) {
      attempt.error = result.error.message || JSON.stringify(result.error);
      attempts.push(attempt);
      if (m < models.length - 1) { continue; }
      return jsonResponse({ error: attempt.error, debug: { attempts: attempts } });
    }

    // --- Extract text from candidate ---
    var text;
    try {
      text = result.candidates[0].content.parts[0].text;
      attempt.rawText = text.length > 500 ? text.substring(0, 500) + '…' : text;
    } catch (parseErr) {
      attempt.error = 'Malformed response — no candidates';
      attempt.rawResponse = JSON.stringify(result).substring(0, 300);
      attempts.push(attempt);
      if (m < models.length - 1) { continue; }
      return jsonResponse({ error: 'No usable response from AI', debug: { attempts: attempts } });
    }

    // --- Parse JSON ---
    var extracted;
    try {
      extracted = JSON.parse(text);
    } catch (_) {
      // Fallback: find the outermost balanced { ... } in the response
      var jsonStr = null;
      var start = text.indexOf('{');
      if (start !== -1) {
        var depth = 0;
        for (var i = start; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
          if (depth === 0) {
            jsonStr = text.substring(start, i + 1);
            break;
          }
        }
      }
      if (!jsonStr) {
        attempt.error = 'Could not find valid JSON in response';
        attempts.push(attempt);
        if (m < models.length - 1) { continue; }
        return jsonResponse({ error: 'Could not parse AI response', debug: { attempts: attempts } });
      }
      try {
        extracted = JSON.parse(jsonStr);
      } catch (e2) {
        attempt.error = 'Extracted JSON still invalid: ' + e2.message;
        attempts.push(attempt);
        if (m < models.length - 1) { continue; }
        return jsonResponse({ error: 'Invalid JSON in AI response', debug: { attempts: attempts } });
      }
    }

    // --- Validate: must have at least two of the three expected fields ---
    var fieldCount = (extracted.fuel_economy != null ? 1 : 0)
                   + (extracted.distance != null ? 1 : 0)
                   + (extracted.duration != null ? 1 : 0);
    if (fieldCount < 2) {
      attempt.error = 'Only extracted ' + fieldCount + '/3 fields';
      attempt.parsed = extracted;
      attempts.push(attempt);
      if (m < models.length - 1) { continue; }
      return jsonResponse({
        error: 'AI could only extract ' + fieldCount + ' of 3 fields',
        debug: { attempts: attempts }
      });
    }

    // Success — remember this model so the next trip starts here.
    // Never record during an override: a test run must not repoint real logging.
    const now = Date.now();
    if (!override && shouldRecordModel(storedGood, model, now)) {
      props.setProperty(LAST_GOOD_KEY, model + '|' + now);
    }
    if (override) extracted._model = model; // so a comparison run is self-labelling
    return jsonResponse(extracted);
  }

  return jsonResponse({ error: 'All models failed', debug: { attempts: attempts } });
}

/**
 * Append a row to the Google Sheet
 */
function handleSubmit(data) {
  // ponytail: 6h cache guard. Same date + arrival second = same trip, so a retry
  // after a lost reply is ignored instead of appending a second row. The phone
  // retrying is CORRECT (it cannot tell whether the row landed) — the defect was
  // that the server could not recognise a repeat. Both writers (submit button and
  // offline queue) route through this action, so one guard here covers both.
  // Ceiling: CacheService max TTL is 6h — an offline trip that syncs later than
  // that can still duplicate. Upgrade to scanning the last 50 rows if that happens.
  const dupKey = 'trip:' + data.date + 'T' + data.arrivalTime;
  const cache = CacheService.getScriptCache();
  if (cache.get(dupKey)) {
    return jsonResponse({ status: 'ok', duplicate: true });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheetByGid(ss, SHEET_GID);

  if (!sheet) {
    return jsonResponse({ error: 'Sheet with gid ' + SHEET_GID + ' not found' });
  }

  // Create a proper Date object so Sheets recognizes it as a date (not text)
  const dateParts = data.date.split('-');
  const dateObj = new Date(
    parseInt(dateParts[0]),      // year
    parseInt(dateParts[1]) - 1,  // month (0-indexed)
    parseInt(dateParts[2])       // day
  );

  // Build the row: Date, Arrival Time, Fuel Economy, Distance, Duration, From, Destination, Purpose
  // (Fuel Consumption is column 9 — a formula, so we leave it alone)
  const row = [
    dateObj,
    data.arrivalTime,
    data.fuelEconomy,
    data.distance,
    data.duration,
    data.from || '',
    data.destination || '',
    data.purpose || ''
  ];

  sheet.appendRow(row);

  // Mark AFTER a successful append, so the guard can only ever block a trip that
  // genuinely made it into the sheet.
  cache.put(dupKey, '1', 21600);

  return jsonResponse({ status: 'ok', row: row });
}

/**
 * Get the Destination value from the last non-empty row
 * (used to auto-fill the "From" field on the next trip)
 */
function handleLastDestination() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheetByGid(ss, SHEET_GID);

  if (!sheet) {
    return jsonResponse({ lastDestination: '' });
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    // Only header row exists
    return jsonResponse({ lastDestination: '' });
  }

  // Destination is column G (column 7)
  const destination = sheet.getRange(lastRow, 7).getValue();
  return jsonResponse({ lastDestination: destination || '' });
}

/**
 * Find a sheet by its gid
 */
function getSheetByGid(spreadsheet, gid) {
  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) {
      return sheets[i];
    }
  }
  return null;
}

/**
 * Helper to return JSON response
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== ONE-OFF EDITOR CHECKS (not used by the web app) =====

/**
 * Print the flash models this API key can actually serve, newest first.
 * Run from the editor (Run > listModels), then reorder the `models` list in
 * handleExtract to match. Do NOT guess model names — a name Google does not
 * serve costs a wasted round trip on every single extraction.
 */
function listModels() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log('GEMINI_API_KEY not set in Script Properties');
    return;
  }

  const response = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey,
    { muteHttpExceptions: true }
  );

  const body = JSON.parse(response.getContentText());

  if (body.error) {
    Logger.log('API error: ' + (body.error.message || JSON.stringify(body.error)));
    return;
  }
  if (!body.models || !body.models.length) {
    Logger.log('No models returned. Raw response: '
      + response.getContentText().substring(0, 300));
    return;
  }

  // Only models that can actually take an image and return text are usable here
  const usable = body.models.filter(function (m) {
    const methods = m.supportedGenerationMethods || [];
    return m.name.indexOf('flash') !== -1 && methods.indexOf('generateContent') !== -1;
  });

  Logger.log(usable.length + ' usable flash model(s) of ' + body.models.length + ' total:');
  usable.forEach(function (m) {
    Logger.log('  ' + m.name.replace('models/', ''));
  });
}

/**
 * Self-check for getModelOrder / shouldRecordModel. Pure logic, no API calls,
 * no sheet access. Expect "PASS" in the execution log.
 */
function testModelOrder() {
  const H = 60 * 60 * 1000;
  const now = Date.now();
  const same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  const check = function (cond, label) {
    if (!cond) throw new Error('FAIL: ' + label);
  };

  check(same(getModelOrder(null, now), MODELS), 'no stored value -> preference order');
  check(same(getModelOrder('gemini-3.5-flash|' + (now - H), now),
    ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']),
    'fresh non-primary is promoted');
  check(same(getModelOrder('gemini-3.5-flash|' + (now - 7 * H), now), MODELS),
    'stale entry reverts to preference');
  check(same(getModelOrder('gemini-9.9-imaginary|' + (now - H), now), MODELS),
    'unknown model name ignored');
  check(same(getModelOrder('nonsense', now), MODELS), 'malformed value ignored');
  check(getModelOrder('junk', now).length === MODELS.length, 'no fallback lost');

  check(shouldRecordModel(null, 'gemini-2.5-flash', now), 'first write happens');
  check(!shouldRecordModel('gemini-2.5-flash|' + (now - H), 'gemini-2.5-flash', now),
    'no pointless rewrite of a fresh identical winner');
  check(shouldRecordModel('gemini-2.5-flash|' + (now - 4 * H), 'gemini-2.5-flash', now),
    'aging stamp gets refreshed');

  Logger.log('PASS: model order logic behaves correctly');
  Logger.log('Current stored value: '
    + (PropertiesService.getScriptProperties().getProperty(LAST_GOOD_KEY) || '(none yet)'));
}

/**
 * Ping each candidate model with the SAME generationConfig the app uses, and
 * report which ones accept it and how fast they answer.
 *
 * The point is thinkingConfig: Gemini 3.x changed how thinking is configured,
 * so a newer model might reject `thinkingBudget` outright. Putting such a model
 * first would make every extraction fail on attempt one and fall through —
 * slower, not faster. Measure before reordering.
 *
 * Sends 6 tiny text-only requests. Negligible cost, no image involved.
 */
function testModels() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log('GEMINI_API_KEY not set in Script Properties');
    return;
  }

  // Newest first — the order we'd WANT, if each one works
  const candidates = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-flash-latest'
  ];

  const passed = [];

  candidates.forEach(function (model) {
    const payload = {
      contents: [{ parts: [{ text: 'Reply with only this JSON: {"ok":1}' }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 500,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    const started = Date.now();
    const response = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model
        + ':generateContent?key=' + apiKey,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );
    const ms = Date.now() - started;
    const body = JSON.parse(response.getContentText());

    if (body.error) {
      Logger.log(model + ' — REJECTED: ' + (body.error.message || '?'));
      return;
    }

    const cand = body.candidates && body.candidates[0];
    const text = cand && cand.content && cand.content.parts
      && cand.content.parts[0] && cand.content.parts[0].text;

    if (!text) {
      Logger.log(model + ' — empty reply, finishReason: ' + (cand && cand.finishReason));
      return;
    }

    Logger.log(model + ' — OK, ' + ms + 'ms');
    passed.push({ model: model, ms: ms });
  });

  Logger.log('');
  if (!passed.length) {
    Logger.log('Nothing accepted the config — keep the current MODELS list.');
    return;
  }

  // Sort by SPEED, not recency. Newest-first was actively wrong here: the 3.x
  // models are largely unavailable on this key, and 3.5-flash answered 25x
  // slower than 2.5-flash.
  passed.sort(function (a, b) { return a.ms - b.ms; });

  Logger.log('Fastest first:');
  passed.forEach(function (p) { Logger.log('  ' + p.model + '  ' + p.ms + 'ms'); });
  Logger.log('');
  Logger.log('Replace the MODELS constant at the top of this file with:');
  Logger.log("  const MODELS = ['"
    + passed.slice(0, 3).map(function (p) { return p.model; }).join("', '") + "'];");
  Logger.log('');
  Logger.log('Latency here is one sample on a trivial text prompt — treat only');
  Logger.log('large gaps as real, and note it does NOT test photo accuracy.');
}
