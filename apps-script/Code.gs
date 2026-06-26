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

  // Try models in order — fallback if one fails (quota, deprecation, etc.)
  const models = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
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
              + 'Valid range is 0–35 km/L. A value of 0 is valid (e.g. EV mode or engine-off coasting).\n'
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
        responseMimeType: 'application/json'
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
      if (m < models.length - 1) { Utilities.sleep(1000); continue; }
      return jsonResponse({ error: 'All models failed (network)', debug: { attempts: attempts } });
    }

    // --- API error (quota, invalid key, etc.) ---
    if (result.error) {
      attempt.error = result.error.message || JSON.stringify(result.error);
      attempts.push(attempt);
      if (m < models.length - 1) { Utilities.sleep(1000); continue; }
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
      if (m < models.length - 1) { Utilities.sleep(1000); continue; }
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
        if (m < models.length - 1) { Utilities.sleep(1000); continue; }
        return jsonResponse({ error: 'Could not parse AI response', debug: { attempts: attempts } });
      }
      try {
        extracted = JSON.parse(jsonStr);
      } catch (e2) {
        attempt.error = 'Extracted JSON still invalid: ' + e2.message;
        attempts.push(attempt);
        if (m < models.length - 1) { Utilities.sleep(1000); continue; }
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
      if (m < models.length - 1) { Utilities.sleep(1000); continue; }
      return jsonResponse({
        error: 'AI could only extract ' + fieldCount + ' of 3 fields',
        debug: { attempts: attempts }
      });
    }

    // Success
    return jsonResponse(extracted);
  }

  return jsonResponse({ error: 'All models failed', debug: { attempts: attempts } });
}

/**
 * Append a row to the Google Sheet
 */
function handleSubmit(data) {
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
