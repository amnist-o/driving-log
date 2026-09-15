/* ==========================================
   DRIVE LOG — Extraction Module
   
   Interface: extractData(imageBase64, mimeType, scriptUrl) → ExtractionResult
   
   ExtractionResult = {
     values: { fuel_economy: number|null, distance: number|null, duration: number|null },
     confidence: { fuel_economy: number|null, distance: number|null, duration: number|null },
     source: 'gemini' | 'tesseract'
   }
   
   Two adapters behind the seam:
     1. Gemini (server-side, via Apps Script)
     2. Tesseract.js (client-side fallback OCR)
   ========================================== */

/**
 * Extract driving data from a dashboard photo.
 * Tries Gemini server-side extraction first; falls back to Tesseract.js client-side OCR.
 *
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g. 'image/jpeg')
 * @param {string} scriptUrl - Google Apps Script deployment URL
 * @returns {Promise<{values, confidence, source}>}
 * @throws {Error} if both adapters fail
 */
export async function extractData(imageBase64, mimeType, scriptUrl) {
  let serverErr;
  try {
    return await geminiAdapter(imageBase64, mimeType, scriptUrl);
  } catch (err) {
    serverErr = err;
  }

  // Gemini failed — try Tesseract.js fallback
  try {
    return await tesseractAdapter(imageBase64, mimeType);
  } catch (ocrErr) {
    const ocrMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr || 'unknown error');
    const error = new Error(
      `Server extraction failed (${serverErr.message}). Local OCR also failed (${ocrMsg}).`
    );

    // Attach structured report for the error-report UI
    error.report = {
      timestamp: new Date().toISOString(),
      server: {
        message: serverErr.message,
        attempts: serverErr.debug?.attempts || []
      },
      ocr: {
        message: ocrMsg,
        rawText: ocrErr.ocrText || null
      }
    };

    throw error;
  }
}

// ===== GEMINI ADAPTER =====

/**
 * Apps Script fails ~24% of heavy image POSTs on Google's side — measured
 * 2026-09-15: 7 failures in 29 real calls, split between HTTP 404 error pages
 * and the script's own doGet body coming back because the redirect collapses
 * POST into GET. None of that is a model problem, and all of it succeeds on a
 * second try, so one retry takes the failure rate to roughly 6%.
 *
 * Only INFRASTRUCTURE failures are retried. A genuine Gemini refusal (quota,
 * overload, unreadable photo) is returned in the body with an `error` field and
 * is thrown immediately — the server already tried every model in its list, so
 * retrying would just spend another 5-20s to be told the same thing.
 */
async function geminiAdapter(imageBase64, mimeType, scriptUrl) {
  const ATTEMPTS = 2;
  let lastErr;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await geminiAttempt(imageBase64, mimeType, scriptUrl);
    } catch (err) {
      if (!err.retryable) throw err;
      lastErr = err;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 800));
    }
  }

  throw lastErr;
}

/** One attempt. Marks infrastructure failures `retryable` so the caller knows. */
async function geminiAttempt(imageBase64, mimeType, scriptUrl) {
  const infra = (message) => {
    const err = new Error(message);
    err.retryable = true;
    return err;
  };

  let response;
  try {
    response = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // Without a limit a stalled backend spins the spinner forever
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        action: 'extract',
        image: imageBase64,
        mimeType: mimeType
      })
    });
  } catch (netErr) {
    // Offline, DNS, or the 45s abort firing
    throw infra(`Network error: ${netErr.message}`);
  }

  if (!response.ok) throw infra(`Server error: ${response.status}`);

  let result;
  try {
    result = await response.json();
  } catch {
    // Apps Script served an HTML error page with a 200
    throw infra('Server returned a non-JSON reply');
  }

  if (result.error) {
    const err = new Error(result.error);
    err.debug = result.debug || null;   // Preserve server diagnostics
    throw err;                          // NOT retryable — Gemini genuinely refused
  }

  // The doGet health-check body ({"status":"ok","message":"..."}) arriving in
  // answer to a POST. No `error` field, so without this the form silently fills
  // with nothing and the user is told nothing at all.
  if (result.fuel_economy == null && result.distance == null && result.duration == null) {
    throw infra('Server did not return any values. Raw reply: '
      + JSON.stringify(result).slice(0, 140));
  }

  return {
    values: {
      fuel_economy: result.fuel_economy ?? null,
      distance: result.distance ?? null,
      duration: result.duration ?? null
    },
    confidence: {
      fuel_economy: result.confidence?.fuel_economy ?? null,
      distance: result.confidence?.distance ?? null,
      duration: result.confidence?.duration ?? null
    },
    source: 'gemini'
  };
}

// ===== TESSERACT ADAPTER =====

async function tesseractAdapter(imageBase64, mimeType) {
  const CDN_BASE = 'https://cdn.jsdelivr.net/npm/tesseract.js@5';

  // Dynamically load Tesseract.js if not already loaded
  if (!window.Tesseract) {
    const script = document.createElement('script');
    script.src = `${CDN_BASE}/dist/tesseract.min.js`;
    document.head.appendChild(script);
    await Promise.race([
      new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load OCR library'));
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OCR library load timed out')), 15000)
      )
    ]);
  }

  // Convert base64 → Blob → Object URL (iOS Safari chokes on large data: URLs in Workers)
  const byteString = atob(imageBase64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);

  try {
    // Wrap recognition in a timeout so it doesn't hang
    const { data } = await Promise.race([
      Tesseract.recognize(blobUrl, 'eng', {
        logger: () => {},
        // Explicit paths prevent iOS worker resolution failures
        workerPath: `${CDN_BASE}/dist/worker.min.js`,
        corePath: `${CDN_BASE}/dist/tesseract-core-simd-lstm.wasm.js`,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OCR recognition timed out')), 30000)
      )
    ]);

    const parsed = parseOcrText(data.text);

    return {
      values: parsed,
      confidence: {
        fuel_economy: parsed.fuel_economy != null ? 0.3 : null,
        distance: parsed.distance != null ? 0.3 : null,
        duration: parsed.duration != null ? 0.3 : null
      },
      source: 'tesseract'
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Parse raw OCR text to extract driving data values.
 * Looks for numbers near domain keywords (km/L, km, min, h/m).
 */
function parseOcrText(text) {
  const result = { fuel_economy: null, distance: null, duration: null };

  // Fuel economy: number near "km/L"
  const fuelMatch = text.match(/(\d+\.?\d*)\s*km\s*\/\s*[lL]/);
  if (fuelMatch) result.fuel_economy = parseFloat(fuelMatch[1]);

  // Distance: number near "km" (but not "km/L")
  const distMatches = [...text.matchAll(/(\d+\.?\d*)\s*km(?!\s*\/)/gi)];
  if (distMatches.length > 0) {
    result.distance = Math.max(...distMatches.map(m => parseFloat(m[1])));
  }

  // Duration: number near "min" or "Xh Ym" pattern
  const durMinMatch = text.match(/(\d+)\s*min/i);
  if (durMinMatch) {
    result.duration = parseInt(durMinMatch[1]);
  } else {
    const durHmMatch = text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
    if (durHmMatch) {
      result.duration = parseInt(durHmMatch[1]) * 60 + parseInt(durHmMatch[2]);
    }
  }

  return result;
}
