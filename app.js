/* ==========================================
   DRIVE LOG — App Orchestrator
   ========================================== */

import { extractData } from './extraction.js';
import { logEvent, getDiaryText, clearDiary, newRequestId } from './diary.js';

const APP_VERSION = 'v1.3.0';
// Past this the phone gives up and queues the trip. Long enough to cover Apps
// Script's slow start after days of no use, short enough not to feel frozen.
const SUBMIT_TIMEOUT_MS = 25000;

// ===== CONFIGURATION =====
// After deploying the Apps Script, paste the web app URL here:
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbz4LL-zv29ETvpJkwX71PDl849kCuxWDxRitH1ZSgbFY0aofQz3fzFowuhiDnx-Xkty6Q/exec',
  MAX_IMAGE_WIDTH: 1024,
  JPEG_QUALITY: 0.8
};

// ===== STATE =====
let currentScreen = 0;
let imageBase64 = null;
let imageMimeType = null;
let cachedLastDestination = ''; // Auto-fill "From" with previous trip's destination
let exifDateTime = null; // EXIF DateTimeOriginal from the photo
let currentBlobUrl = null; // Track blob URL for the current image

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const screens = $$('.screen');
const steps = $$('.step');
const cameraInput = $('#cameraInput');
const uploadInput = $('#uploadInput');
const previewImage = $('#previewImage');
const previewPlaceholder = $('#previewPlaceholder');
const previewZone = $('#previewZone');
const clearImageBtn = $('#clearImageBtn');
const extractBtn = $('#extractBtn');
const extractSpinner = $('#extractSpinner');
const submitBtn = $('#submitBtn');
const submitSpinner = $('#submitSpinner');
const backBtn = $('#backBtn');
const newTripBtn = $('#newTripBtn');
const toast = $('#toast');
const toastMessage = $('#toastMessage');
const skipBtn = $('#skipBtn');

// Photo preview on review screen
const photoPreviewBar = $('#photoPreviewBar');
const photoPreviewExpanded = $('#photoPreviewExpanded');
const reviewThumbnail = $('#reviewThumbnail');
const reviewFullImage = $('#reviewFullImage');

// Sync badge & pending panel
const syncBadge = $('#syncBadge');
const syncCount = $('#syncCount');
const pendingPanel = $('#pendingPanel');
const pendingPanelList = $('#pendingPanelList');
const closePanelBtn = $('#closePanelBtn');

// Error report overlay
const errorReportOverlay = $('#errorReportOverlay');
const errorReportBody = $('#errorReportBody');
const errorReportClose = $('#errorReportClose');
const errorReportDismiss = $('#errorReportDismiss');
const errorReportTitle = $('#errorReportTitle');
const errorReportCopy = $('#errorReportCopy');
const errorReportClear = $('#errorReportClear');
const diagBtn = $('#diagBtn');

// Form fields
const fields = {
  fuelEconomy: $('#fuelEconomy'),
  distance: $('#distance'),
  duration: $('#duration'),
  tripDate: $('#tripDate'),
  arrivalTime: $('#arrivalTime'),
  tripFrom: $('#tripFrom'),
  tripDestination: $('#tripDestination'),
  tripPurpose: $('#tripPurpose')
};

// ===== EVENT LISTENERS =====
cameraInput.addEventListener('change', handleImageSelect);
uploadInput.addEventListener('change', handleImageSelect);
clearImageBtn.addEventListener('click', clearImage);
extractBtn.addEventListener('click', handleExtract);
backBtn.addEventListener('click', () => goToScreen(0));
submitBtn.addEventListener('click', handleSubmit);
newTripBtn.addEventListener('click', handleNewTrip);

// Skip — Enter Manually
skipBtn.addEventListener('click', () => {
  transitionToReview(null);
});

// Error report dismiss
errorReportClose.addEventListener('click', () => errorReportOverlay.classList.add('hidden'));
errorReportDismiss.addEventListener('click', () => errorReportOverlay.classList.add('hidden'));
errorReportCopy.addEventListener('click', copyReportText);
errorReportClear.addEventListener('click', () => {
  clearDiary();
  showDiagnostics();
});
diagBtn.addEventListener('click', showDiagnostics);

// Photo preview toggle
photoPreviewBar.addEventListener('click', () => {
  const isExpanded = photoPreviewBar.classList.contains('expanded');
  if (isExpanded) {
    photoPreviewBar.classList.remove('expanded');
    photoPreviewExpanded.classList.add('hidden');
  } else {
    photoPreviewBar.classList.add('expanded');
    photoPreviewExpanded.classList.remove('hidden');
  }
});

// Sync badge → toggle pending panel
syncBadge.addEventListener('click', () => {
  const isVisible = !pendingPanel.classList.contains('hidden');
  if (isVisible) {
    pendingPanel.classList.add('hidden');
  } else {
    renderPendingPanel();
    pendingPanel.classList.remove('hidden');
  }
});

closePanelBtn.addEventListener('click', () => {
  pendingPanel.classList.add('hidden');
});

// Auto-sync when coming back online
window.addEventListener('online', syncPendingTrips);
// A home-screen app is usually resumed, not reloaded, so also sync on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) syncPendingTrips();
});

// ===== INITIALIZATION =====
logEvent('app-open', { version: APP_VERSION, online: navigator.onLine });
// Load cached lastDestination immediately (works offline)
const cachedDest = localStorage.getItem('lastDestination');
if (cachedDest) {
  cachedLastDestination = cachedDest;
}
// Then fetch from server to update cache
fetchLastDestination();

// Show sync badge if pending trips exist
updateSyncBadge();

// Try syncing on load if online
if (navigator.onLine) {
  syncPendingTrips();
}

// ===== EXIF EXTRACTION =====

/**
 * Extract DateTimeOriginal from JPEG EXIF data.
 * Parses the TIFF header, IFD0, finds ExifIFD pointer, then reads tag 0x9003.
 * Returns a Date object or null.
 */
function extractExifDateTime(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);

    // Check JPEG SOI marker
    if (view.getUint16(0) !== 0xFFD8) return null;

    let offset = 2;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      offset += 2;

      // APP1 marker (EXIF)
      if (marker === 0xFFE1) {
        const segLen = view.getUint16(offset);
        // Check "Exif\0\0" header
        const exifHeader = view.getUint32(offset + 2);
        if (exifHeader !== 0x45786966) return null; // "Exif"

        const tiffOffset = offset + 8; // Start of TIFF header
        const byteOrder = view.getUint16(tiffOffset);
        const littleEndian = byteOrder === 0x4949; // "II"

        // Verify TIFF magic number
        if (view.getUint16(tiffOffset + 2, littleEndian) !== 0x002A) return null;

        // Get offset to IFD0
        const ifd0Offset = view.getUint32(tiffOffset + 4, littleEndian);

        // Read IFD0 to find ExifIFD pointer (tag 0x8769)
        const exifIfdPointer = findTagInIFD(view, tiffOffset, tiffOffset + ifd0Offset, littleEndian, 0x8769);
        if (exifIfdPointer === null) return null;

        // Read ExifIFD to find DateTimeOriginal (tag 0x9003)
        const dateTimeValue = findTagInIFD(view, tiffOffset, tiffOffset + exifIfdPointer, littleEndian, 0x9003, true);
        if (!dateTimeValue) return null;

        // Parse "YYYY:MM:DD HH:MM:SS"
        return parseExifDateString(dateTimeValue);
      }

      // Skip other segments
      if ((marker & 0xFF00) === 0xFF00) {
        const len = view.getUint16(offset);
        offset += len;
      } else {
        break;
      }
    }
  } catch {
    // EXIF parsing failed — not critical
  }
  return null;
}

/**
 * Find a tag value in an IFD.
 * If asString is true, reads the value as an ASCII string.
 */
function findTagInIFD(view, tiffStart, ifdStart, littleEndian, targetTag, asString = false) {
  try {
    const entryCount = view.getUint16(ifdStart, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdStart + 2 + (i * 12);
      const tag = view.getUint16(entryOffset, littleEndian);

      if (tag === targetTag) {
        const type = view.getUint16(entryOffset + 2, littleEndian);
        const count = view.getUint32(entryOffset + 4, littleEndian);
        const valueOffset = entryOffset + 8;

        if (asString) {
          // String values > 4 bytes are stored at an offset
          const strOffset = count > 4
            ? tiffStart + view.getUint32(valueOffset, littleEndian)
            : valueOffset;
          let str = '';
          for (let j = 0; j < count - 1; j++) { // -1 to skip null terminator
            str += String.fromCharCode(view.getUint8(strOffset + j));
          }
          return str;
        }

        // Return the 4-byte value as uint32 (for IFD pointers)
        return view.getUint32(valueOffset, littleEndian);
      }
    }
  } catch {
    // Tag not found or read error
  }
  return null;
}

/**
 * Parse EXIF date string "YYYY:MM:DD HH:MM:SS" to a Date object.
 */
function parseExifDateString(str) {
  // Format: "2024:03:15 14:30:45"
  const match = str.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return new Date(
    parseInt(match[1]),
    parseInt(match[2]) - 1,
    parseInt(match[3]),
    parseInt(match[4]),
    parseInt(match[5]),
    parseInt(match[6])
  );
}

// ===== IMAGE HANDLING =====

/**
 * Detect real MIME type from file header bytes (magic numbers).
 * Handles JPEG, PNG, HEIC/HEIF, and WebP.
 */
function detectMimeType(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 12));
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  // WebP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  // HEIC/HEIF: check for ftyp box containing 'heic', 'heix', 'mif1'
  const ftypStr = String.fromCharCode(...bytes.slice(4, 12));
  if (ftypStr.startsWith('ftyp')) {
    const brand = ftypStr.slice(4);
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
  }
  return null; // Unknown
}

/**
 * Convert ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Use blob URL for preview — works for HEIC on iOS Safari natively
  const blobUrl = URL.createObjectURL(file);
  currentBlobUrl = blobUrl;
  previewImage.src = blobUrl;
  previewImage.classList.remove('hidden');
  previewPlaceholder.classList.add('hidden');
  clearImageBtn.classList.remove('hidden');
  previewZone.classList.add('has-image');

  // Read as ArrayBuffer for MIME detection + base64 encoding + EXIF
  const reader = new FileReader();
  reader.onload = async (evt) => {
    const arrayBuffer = evt.target.result;

    // Detect real MIME type from file bytes (don't trust file.type)
    const detectedMime = detectMimeType(arrayBuffer) || file.type || 'image/jpeg';

    // Extract EXIF DateTimeOriginal (JPEG only; HEIC falls back to file.lastModified)
    exifDateTime = extractExifDateTime(arrayBuffer);
    if (!exifDateTime && file.lastModified) {
      // Use file's lastModified as a fallback (OS-level timestamp)
      const lm = new Date(file.lastModified);
      // Only use if the file is older than 60 seconds (i.e., not just taken)
      if (Date.now() - lm.getTime() > 60000) {
        exifDateTime = lm;
      }
    }

    // Try to compress via canvas (JPEG output, smaller payload)
    try {
      const result = await compressImage(blobUrl);
      imageBase64 = result.base64;
      imageMimeType = 'image/jpeg';
    } catch {
      // Canvas can't decode this format (HEIC on Chrome/Android)
      // Send raw bytes — Gemini API supports HEIC natively
      imageBase64 = arrayBufferToBase64(arrayBuffer);
      imageMimeType = detectedMime;
    }

    extractBtn.disabled = false;
  };
  reader.readAsArrayBuffer(file);
}

/**
 * Compress image via canvas → JPEG.
 * Works for JPEG, PNG, WebP on all browsers.
 * Works for HEIC on iOS Safari (native HEIC decoding).
 * Throws on browsers that can't decode the source format.
 */
function compressImage(blobUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(CONFIG.MAX_IMAGE_WIDTH / img.width, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const compressed = canvas.toDataURL('image/jpeg', CONFIG.JPEG_QUALITY);
        resolve({
          base64: compressed.split(',')[1],
          mimeType: 'image/jpeg'
        });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = blobUrl;
  });
}

function clearImage() {
  // Revoke blob URL to free memory
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  imageBase64 = null;
  imageMimeType = null;
  exifDateTime = null;
  previewImage.src = '';
  previewImage.classList.add('hidden');
  previewPlaceholder.classList.remove('hidden');
  clearImageBtn.classList.add('hidden');
  previewZone.classList.remove('has-image');
  extractBtn.disabled = true;
  cameraInput.value = '';
  uploadInput.value = '';
}

// ===== CONFIDENCE BADGES =====

function applyConfidence(badgeId, score) {
  const badge = $(`#${badgeId}`);
  if (!badge) return;

  const wrapper = badge.closest('.input-wrapper');
  // Remove previous states
  wrapper.classList.remove('confidence-low', 'confidence-high');
  badge.classList.remove('high', 'low', 'visible');

  if (score == null) return;

  const isHigh = score >= 0.8;
  badge.textContent = isHigh ? '✓' : '⚠ verify';
  badge.classList.add(isHigh ? 'high' : 'low', 'visible');
  wrapper.classList.add(isHigh ? 'confidence-high' : 'confidence-low');
}

function clearConfidenceBadges() {
  ['confFuelEconomy', 'confDistance', 'confDuration'].forEach(id => {
    const badge = $(`#${id}`);
    if (!badge) return;
    badge.classList.remove('high', 'low', 'visible');
    badge.textContent = '';
    const wrapper = badge.closest('.input-wrapper');
    if (wrapper) wrapper.classList.remove('confidence-low', 'confidence-high');
  });
}

// ===== TRANSITION TO REVIEW (unified) =====

/**
 * Transition to the Review screen.
 * If extractionResult is provided, populate fields and apply confidence.
 * If null (manual entry / skip), clear confidence and leave fields empty.
 *
 * @param {Object|null} extractionResult - Result from extractData(), or null for manual entry
 */
function transitionToReview(extractionResult) {
  if (extractionResult) {
    // Populate extracted values
    fields.fuelEconomy.value = extractionResult.values.fuel_economy ?? '';
    fields.distance.value = extractionResult.values.distance ?? '';
    fields.duration.value = extractionResult.values.duration ?? '';

    // Apply confidence indicators
    applyConfidence('confFuelEconomy', extractionResult.confidence.fuel_economy);
    applyConfidence('confDistance', extractionResult.confidence.distance);
    applyConfidence('confDuration', extractionResult.confidence.duration);

    if (extractionResult.source === 'tesseract') {
      showToast('Used local OCR — please verify values', 'info');
    }
  } else {
    clearConfidenceBadges();
  }

  // Auto-fill date & time from EXIF or current time
  const timeSource = exifDateTime || new Date();
  fields.tripDate.value = formatDate(timeSource);
  fields.arrivalTime.value = formatTime(timeSource);

  // Auto-fill "From" with the last trip's destination
  if (cachedLastDestination) {
    fields.tripFrom.value = cachedLastDestination;
  }

  // Set photo preview on review screen
  if (currentBlobUrl) {
    reviewThumbnail.src = currentBlobUrl;
    reviewFullImage.src = currentBlobUrl;
    photoPreviewBar.style.display = '';
  } else {
    photoPreviewBar.style.display = 'none';
  }
  // Reset to collapsed state
  photoPreviewBar.classList.remove('expanded');
  photoPreviewExpanded.classList.add('hidden');

  goToScreen(1);
}

// ===== EXTRACT DATA =====

async function handleExtract() {
  if (!imageBase64) return;

  if (!CONFIG.SCRIPT_URL) {
    showToast('Please set the Apps Script URL in app.js', 'error');
    return;
  }

  setButtonLoading(extractBtn, extractSpinner, true);
  const started = Date.now();
  logEvent('extract-start', { kb: Math.round(imageBase64.length * 0.75 / 1024) });

  try {
    const result = await extractData(imageBase64, imageMimeType, CONFIG.SCRIPT_URL);
    logEvent('extract-ok', { ms: Date.now() - started, source: result.source });
    transitionToReview(result);
  } catch (err) {
    logEvent('extract-fail', { ms: Date.now() - started, error: err.message });
    showErrorReport(err, '⚠ Extraction Failed');
  } finally {
    setButtonLoading(extractBtn, extractSpinner, false);
  }
}

// ===== FETCH LAST DESTINATION =====
async function fetchLastDestination() {
  if (!CONFIG.SCRIPT_URL) return;

  // Usually the first request after days of no use, so its time shows how slow
  // Google's cold start is
  const id = newRequestId();
  const started = Date.now();
  try {
    const { result, serverMs } = await postToScript({ action: 'lastDestination', requestId: id });
    logEvent('last-dest-ok', { id, ms: Date.now() - started, serverMs });
    if (result.lastDestination) {
      cachedLastDestination = result.lastDestination;
      localStorage.setItem('lastDestination', result.lastDestination);
    }
  } catch (err) {
    // Silent for the user — we already have the localStorage cache
    logEvent('last-dest-fail', { id, ms: Date.now() - started, error: describeError(err) });
  }
}

// ===== NETWORK HELPERS =====

/**
 * POST to the Apps Script with a time limit. Resolves { result, serverMs };
 * throws on timeout, lost connection, HTTP error, or a non-JSON reply.
 */
async function postToScript(payload) {
  const response = await fetch(CONFIG.SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Server error: ${response.status}`);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Server returned a non-JSON reply');
  }
  return { result, serverMs: result.serverMs };
}

/**
 * Timeout or lost connection: the request may or may not have reached Google.
 * Judged by error type, not wording — iPhone says "Load failed", Chrome says
 * "Failed to fetch", Firefox "NetworkError", and all of them are TypeErrors.
 */
function isConnectionError(err) {
  return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError';
}

function describeError(err) {
  return err.name === 'TimeoutError' || err.name === 'AbortError'
    ? `timed out after ${SUBMIT_TIMEOUT_MS / 1000}s`
    : `${err.name}: ${err.message}`;
}

// A real submit reply has `row` or `duplicate`. Apps Script sometimes answers a
// POST with the doGet "API is running" body instead — that wrote nothing.
function isSubmitReply(result) {
  return Boolean(result && (result.row || result.duplicate));
}

// ===== OFFLINE SUBMISSION QUEUE =====

function getPendingTrips() {
  return JSON.parse(localStorage.getItem('pendingTrips') || '[]');
}

function savePendingTrip(payload) {
  const pending = getPendingTrips();
  pending.push({ ...payload, queuedAt: new Date().toISOString() });
  localStorage.setItem('pendingTrips', JSON.stringify(pending));

  // Cache destination locally
  if (payload.destination) {
    cachedLastDestination = payload.destination;
    localStorage.setItem('lastDestination', payload.destination);
  }

  updateSyncBadge();
}

function updateSyncBadge() {
  const pending = getPendingTrips();
  if (pending.length > 0) {
    syncBadge.classList.remove('hidden');
    syncCount.textContent = pending.length;
  } else {
    syncBadge.classList.add('hidden');
    pendingPanel.classList.add('hidden');
  }
}

function renderPendingPanel() {
  const pending = getPendingTrips();
  if (pending.length === 0) {
    pendingPanelList.innerHTML = '<div class="pending-empty">No pending trips</div>';
    return;
  }

  pendingPanelList.innerHTML = pending.map((trip, i) => `
    <div class="pending-item">
      <strong>${trip.date}</strong> at ${trip.arrivalTime}<br>
      📏 ${trip.distance} km · ⛽ ${trip.fuelEconomy} km/L · ⏱ ${trip.duration} min
      ${trip.from ? `<br>📍 ${trip.from} → ${trip.destination}` : ''}
    </div>
  `).join('');
}

let syncing = false;
async function syncPendingTrips() {
  // Load, 'online' and returning to the app can fire together
  if (syncing) return;
  const pending = getPendingTrips();
  if (pending.length === 0) return;
  syncing = true;

  let synced = 0;
  const sent = new Set();

  try {
    for (const trip of pending) {
      const { queuedAt, ...payload } = trip;
      const id = newRequestId();
      const started = Date.now();
      try {
        // fromQueue: the server also checks recent rows, because a trip queued
        // after a lost reply may already be in the sheet from days ago
        const { result, serverMs } = await postToScript({ ...payload, fromQueue: true, requestId: id });
        if (result.error) throw new Error(result.error);
        if (!isSubmitReply(result)) throw new Error('Unexpected server reply');
        logEvent('sync-ok', { id, trip: `${trip.date}T${trip.arrivalTime}`, ms: Date.now() - started, serverMs, duplicate: Boolean(result.duplicate) });
        sent.add(queuedAt);
        synced++;
      } catch (err) {
        logEvent('sync-fail', { id, trip: `${trip.date}T${trip.arrivalTime}`, ms: Date.now() - started, error: describeError(err) });
      }
    }
  } finally {
    // Re-read so a trip queued while this sync ran is not overwritten
    const remaining = getPendingTrips().filter((t) => !sent.has(t.queuedAt));
    localStorage.setItem('pendingTrips', JSON.stringify(remaining));
    syncing = false;
    updateSyncBadge();
  }

  if (synced > 0) {
    showToast(`${synced} trip${synced > 1 ? 's' : ''} synced successfully`, 'success');
  }
}

// ===== SUBMIT TO SHEET =====
async function handleSubmit() {
  // Validate required fields
  const fuelEconomy = parseFloat(fields.fuelEconomy.value);
  const distance = parseFloat(fields.distance.value);
  const duration = parseInt(fields.duration.value, 10);

  if (isNaN(fuelEconomy) || isNaN(distance) || isNaN(duration)) {
    showToast('Please fill in all extracted fields', 'error');
    return;
  }

  setButtonLoading(submitBtn, submitSpinner, true);

  const payload = {
    action: 'submit',
    date: fields.tripDate.value,
    arrivalTime: fields.arrivalTime.value,
    fuelEconomy: fuelEconomy,
    distance: distance,
    duration: duration,
    from: fields.tripFrom.value.trim(),
    destination: fields.tripDestination.value.trim(),
    purpose: fields.tripPurpose.value.trim()
  };

  // Show success summary helper
  const showSuccess = (offlineMsg = '') => {
    const summary = $('#successSummary');
    summary.innerHTML = `
      <strong>${payload.date}</strong> at ${payload.arrivalTime}<br>
      📏 ${payload.distance} km &nbsp;·&nbsp; ⛽ ${payload.fuelEconomy} km/L &nbsp;·&nbsp; ⏱ ${payload.duration} min<br>
      ${payload.from ? `📍 ${payload.from} → ${payload.destination}` : ''}
      ${payload.purpose ? `<br>📝 ${payload.purpose}` : ''}
      ${offlineMsg ? `<br><em style="color: var(--text-muted); font-size: 0.75rem;">${offlineMsg}</em>` : ''}
    `;

    // Update cached destination for the next trip
    if (payload.destination) {
      cachedLastDestination = payload.destination;
      localStorage.setItem('lastDestination', payload.destination);
    }

    const queued = offlineMsg.startsWith('📡');
    $('#doneTitle').textContent = queued ? 'Trip Saved on Phone' : 'Trip Logged!';
    $('#doneSubtitle').textContent = queued
      ? 'Not in the spreadsheet yet — it will be sent automatically.'
      : 'Your driving data has been saved to the spreadsheet.';

    goToScreen(2);
  };

  // Check if we're offline before even trying
  if (!navigator.onLine) {
    savePendingTrip(payload);
    showSuccess('📡 Saved offline — will sync when connected');
    setButtonLoading(submitBtn, submitSpinner, false);
    return;
  }

  const tripKey = `${payload.date}T${payload.arrivalTime}`;
  logEvent('submit-start', { trip: tripKey });

  // Retried because Apps Script fails ~24% of requests on Google's side, not
  // ours. This is only SAFE because the server recognises a repeat by
  // date + arrival time. A timeout or lost connection is NOT retried here: the
  // row may already have landed, and a second 25s wait is what made the app
  // look frozen. Those go to the send-later queue instead.
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const id = newRequestId();
    const started = Date.now();
    try {
      const { result, serverMs } = await postToScript({ ...payload, requestId: id });
      if (result.error) throw Object.assign(new Error(result.error), { fromServer: true });
      if (!isSubmitReply(result)) throw new Error('Unexpected server reply (nothing was written)');
      logEvent('submit-ok', { id, attempt, ms: Date.now() - started, serverMs, duplicate: Boolean(result.duplicate) });

      // Surface a suppressed duplicate rather than pretending a row was written.
      // A false positive is possible for back-dated photos whose arrival time has
      // no seconds, so it must not be silent.
      showSuccess(result.duplicate ? '✓ Already logged — no duplicate row added' : '');
      setButtonLoading(submitBtn, submitSpinner, false);
      return;
    } catch (err) {
      const ms = Date.now() - started;
      const error = describeError(err);
      logEvent('submit-fail', { id, attempt, ms, error });
      failures.push(`Try ${attempt} (request ${id}): ${error} after ${(ms / 1000).toFixed(1)}s`);

      if (!navigator.onLine || isConnectionError(err)) {
        savePendingTrip(payload);
        logEvent('submit-queued', { trip: tripKey });
        showSuccess('📡 Saved on phone — will sync automatically');
        setButtonLoading(submitBtn, submitSpinner, false);
        // Try again shortly in the background rather than waiting for next open
        setTimeout(() => navigator.onLine && syncPendingTrips(), 30000);
        return;
      }
      // A refusal from the script itself will not change on a second try
      if (err.fromServer) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }

  setButtonLoading(submitBtn, submitSpinner, false);
  showErrorReport(
    new Error(`${failures.join('\n')}\n\nTrip ${tripKey} may not have been saved. Check the sheet before submitting again.`),
    '⚠ Submit Failed'
  );
}

// ===== NEW TRIP =====
function handleNewTrip() {
  clearImage();
  clearConfidenceBadges();
  Object.values(fields).forEach((input) => (input.value = ''));
  goToScreen(0);
}

// ===== SCREEN NAVIGATION =====
function goToScreen(index) {
  screens.forEach((s, i) => {
    if (i === index) {
      s.classList.add('active');
      // Re-trigger animation
      s.style.animation = 'none';
      s.offsetHeight; // Force reflow
      s.style.animation = '';
    } else {
      s.classList.remove('active');
    }
  });

  // Update step indicator
  steps.forEach((s, i) => {
    s.classList.remove('active', 'completed');
    if (i === index) s.classList.add('active');
    else if (i < index) s.classList.add('completed');
  });

  currentScreen = index;
}

// ===== UTILITIES =====
function setButtonLoading(btn, spinner, loading) {
  if (loading) {
    btn.disabled = true;
    btn.querySelector('.btn-text').classList.add('hidden');
    const arrow = btn.querySelector('.btn-arrow');
    if (arrow) arrow.classList.add('hidden');
    const check = btn.querySelector('.btn-check');
    if (check) check.classList.add('hidden');
    spinner.classList.remove('hidden');
  } else {
    btn.disabled = false;
    btn.querySelector('.btn-text').classList.remove('hidden');
    const arrow = btn.querySelector('.btn-arrow');
    if (arrow) arrow.classList.remove('hidden');
    const check = btn.querySelector('.btn-check');
    if (check) check.classList.remove('hidden');
    spinner.classList.add('hidden');
  }
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ===== ERROR REPORT =====

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showErrorReport(error, title) {
  errorReportTitle.textContent = title;
  errorReportCopy.classList.remove('hidden');
  errorReportClear.classList.add('hidden');
  let html = '';

  if (error.report) {
    const r = error.report;

    // Timestamp
    html += `<div class="error-section">`;
    html += `<div class="error-label">Timestamp</div>`;
    html += `<div class="error-value">${escapeHtml(r.timestamp)}</div>`;
    html += `</div>`;

    // Server attempts
    html += `<div class="error-section">`;
    html += `<div class="error-label">🔴 Server (Gemini)</div>`;
    if (r.server.attempts.length > 0) {
      r.server.attempts.forEach(a => {
        html += `<div class="error-attempt">`;
        html += `<strong>${escapeHtml(a.model)}</strong>: ${escapeHtml(a.error || 'unknown')}`;
        if (a.rawText) {
          html += `<pre class="error-raw">${escapeHtml(a.rawText)}</pre>`;
        }
        if (a.rawResponse) {
          html += `<pre class="error-raw">${escapeHtml(a.rawResponse)}</pre>`;
        }
        if (a.parsed) {
          html += `<pre class="error-raw">Parsed: ${escapeHtml(JSON.stringify(a.parsed))}</pre>`;
        }
        html += `</div>`;
      });
    } else {
      html += `<div class="error-value">${escapeHtml(r.server.message)}</div>`;
    }
    html += `</div>`;

    // OCR
    html += `<div class="error-section">`;
    html += `<div class="error-label">🔴 Local OCR (Tesseract)</div>`;
    html += `<div class="error-value">${escapeHtml(r.ocr.message)}</div>`;
    if (r.ocr.rawText) {
      html += `<pre class="error-raw">${escapeHtml(r.ocr.rawText)}</pre>`;
    }
    html += `</div>`;
  } else {
    // Fallback: no structured report, show raw message
    html += `<div class="error-section">`;
    html += `<div class="error-label">Error</div>`;
    html += `<pre class="error-raw diary-text">${escapeHtml(error.message)}</pre>`;
    html += `</div>`;
  }

  errorReportBody.innerHTML = html;
  errorReportOverlay.classList.remove('hidden');
}

function showDiagnostics() {
  errorReportTitle.textContent = `Diagnostics · ${APP_VERSION}`;
  errorReportCopy.classList.remove('hidden');
  errorReportClear.classList.remove('hidden');
  errorReportBody.innerHTML = `
    <div class="error-section">
      <div class="error-label">Diary (newest last) · pending trips: ${getPendingTrips().length}</div>
      <pre class="error-raw diary-text">${escapeHtml(getDiaryText())}</pre>
    </div>`;
  errorReportOverlay.classList.remove('hidden');
  const pre = errorReportBody.querySelector('.diary-text');
  pre.scrollTop = pre.scrollHeight;
}

async function copyReportText() {
  // Error panels get the diary appended, so one paste carries the whole story
  const isDiagnostics = !errorReportClear.classList.contains('hidden');
  const text = isDiagnostics
    ? `Drive Log ${APP_VERSION} diagnostics
${getDiaryText()}`
    : `Drive Log ${APP_VERSION} — ${errorReportTitle.textContent}
${errorReportBody.innerText}

--- diary ---
${getDiaryText()}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied — paste it to your AI helper', 'success');
  } catch {
    showToast('Copy blocked — select the text and copy manually', 'error');
  }
}

// ===== TOAST =====

let toastTimeout = null;
function showToast(message, type = 'info') {
  clearTimeout(toastTimeout);
  toastMessage.textContent = message;
  toast.className = 'toast visible ' + type;
  toastTimeout = setTimeout(() => {
    toast.className = 'toast hidden';
  }, 4000);
}
