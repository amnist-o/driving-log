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
  try {
    return await geminiAdapter(imageBase64, mimeType, scriptUrl);
  } catch (serverErr) {
    try {
      return await tesseractAdapter(imageBase64, mimeType);
    } catch (ocrErr) {
      throw new Error(`Extraction failed: ${serverErr.message}`);
    }
  }
}

// ===== GEMINI ADAPTER =====

async function geminiAdapter(imageBase64, mimeType, scriptUrl) {
  const response = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'extract',
      image: imageBase64,
      mimeType: mimeType
    })
  });

  if (!response.ok) throw new Error(`Server error: ${response.status}`);

  const result = await response.json();

  if (result.error) throw new Error(result.error);

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
  // Dynamically load Tesseract.js if not already loaded
  if (!window.Tesseract) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    document.head.appendChild(script);
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load OCR library'));
    });
  }

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const { data } = await Tesseract.recognize(dataUrl, 'eng', {
    logger: () => {} // Silent
  });

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
