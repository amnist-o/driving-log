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
const GEMINI_MODEL = 'gemini-2.0-flash';

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

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + GEMINI_MODEL + ':generateContent?key=' + apiKey;

  const payload = {
    contents: [{
      parts: [
        {
          text: 'Extract these values from the car dashboard display image:\n'
            + '- fuel_economy (the "This Drive" value in km/L, as a float)\n'
            + '- distance (Driving Distance in km, as a float)\n'
            + '- duration (Driving Time in minutes, as an integer)\n\n'
            + 'Return ONLY valid JSON, no markdown, no explanation:\n'
            + '{"fuel_economy": <number>, "distance": <number>, "duration": <number>}'
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
      maxOutputTokens: 100
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
    return jsonResponse({ error: result.error.message });
  }

  // Parse Gemini's response
  const text = result.candidates[0].content.parts[0].text;

  // Extract JSON from response (handle possible markdown wrapping)
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    return jsonResponse({ error: 'Could not parse AI response: ' + text });
  }

  const extracted = JSON.parse(jsonMatch[0]);
  return jsonResponse(extracted);
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

  // Format date from YYYY-MM-DD to the sheet's expected format
  const dateParts = data.date.split('-');
  const formattedDate = dateParts[2] + '/' + dateParts[1] + '/' + dateParts[0]; // DD/MM/YYYY

  // Build the row: Date, Arrival Time, Fuel Economy, Distance, Duration, From, Destination, Purpose
  // (Fuel Consumption is column 9 — a formula, so we leave it alone)
  const row = [
    formattedDate,
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
