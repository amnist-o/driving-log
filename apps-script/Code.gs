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
 * Extract fuel economy, distance, duration from dashboard image using Gemini
 */
function handleExtract(data) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'GEMINI_API_KEY not set in Script Properties' });
  }

  // Try models in order — fallback if quota exceeded
  // gemini-2.5-flash-lite: stable, cheapest, clean JSON output
  // gemini-3.1-flash-lite: newest generation fallback
  const models = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];

  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + model + ':generateContent?key=' + apiKey;

    const payload = {
      contents: [{
        parts: [
          {
            text: 'You are reading a car dashboard trip-summary screen photo.\n'
              + 'Read the PROMINENT DISPLAYED VALUES on the screen — NOT chart axis labels, scale markers, or decorative numbers.\n\n'
              + 'Extract these three values:\n'
              + '- fuel_economy: the large number associated with "This Drive" or a similar per-trip heading, in km/L (float). '
              + 'For a normal passenger car this is typically 5–25 km/L. If your reading falls outside that range, re-examine the image carefully.\n'
              + '- distance: Driving Distance in km (float).\n'
              + '- duration: Driving Time in minutes (integer).\n\n'
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
        maxOutputTokens: 200
      }
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (result.error) {
      // If quota exceeded and we have more models to try, continue
      if (result.error.message && result.error.message.indexOf('quota') !== -1 && m < models.length - 1) {
        Utilities.sleep(2000); // Brief pause before trying next model
        continue;
      }
      return jsonResponse({ error: result.error.message });
    }

    // Parse Gemini's response
    const text = result.candidates[0].content.parts[0].text;

    // Extract JSON from response — handles nested braces (e.g. confidence object)
    let jsonStr = null;
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        if (depth === 0) {
          jsonStr = text.substring(start, i + 1);
          break;
        }
      }
    }
    if (!jsonStr) {
      return jsonResponse({ error: 'Could not parse AI response: ' + text });
    }

    const extracted = JSON.parse(jsonStr);
    return jsonResponse(extracted);
  }

  return jsonResponse({ error: 'All models failed — quota may be exhausted. Please try again later.' });
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
