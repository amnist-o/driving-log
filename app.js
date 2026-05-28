/* ==========================================
   DRIVE LOG — App Orchestrator
   ========================================== */

import { extractData } from './extraction.js';

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

// ===== INITIALIZATION =====
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

  try {
    const result = await extractData(imageBase64, imageMimeType, CONFIG.SCRIPT_URL);
    transitionToReview(result);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setButtonLoading(extractBtn, extractSpinner, false);
  }
}

// ===== FETCH LAST DESTINATION =====
async function fetchLastDestination() {
  if (!CONFIG.SCRIPT_URL) return;

  try {
    const response = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'lastDestination' })
    });

    if (!response.ok) return;

    const result = await response.json();
    if (result.lastDestination) {
      cachedLastDestination = result.lastDestination;
      localStorage.setItem('lastDestination', result.lastDestination);
    }
  } catch {
    // Silent fail — we already have the localStorage cache
  }
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

async function syncPendingTrips() {
  const pending = getPendingTrips();
  if (pending.length === 0) return;

  let synced = 0;
  const remaining = [];

  for (const trip of pending) {
    try {
      const { queuedAt, ...payload } = trip;
      const response = await fetch(CONFIG.SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        const result = await response.json();
        if (!result.error) {
          synced++;
          continue;
        }
      }
      remaining.push(trip);
    } catch {
      remaining.push(trip);
    }
  }

  localStorage.setItem('pendingTrips', JSON.stringify(remaining));
  updateSyncBadge();

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

    goToScreen(2);
  };

  // Check if we're offline before even trying
  if (!navigator.onLine) {
    savePendingTrip(payload);
    showSuccess('📡 Saved offline — will sync when connected');
    setButtonLoading(submitBtn, submitSpinner, false);
    return;
  }

  try {
    const response = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);

    const result = await response.json();

    if (result.error) throw new Error(result.error);

    showSuccess();
  } catch (err) {
    // Network error — save offline
    if (!navigator.onLine || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      savePendingTrip(payload);
      showSuccess('📡 Saved offline — will sync when connected');
    } else {
      showToast('Submit failed: ' + err.message, 'error');
    }
  } finally {
    setButtonLoading(submitBtn, submitSpinner, false);
  }
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

let toastTimeout = null;
function showToast(message, type = 'info') {
  clearTimeout(toastTimeout);
  toastMessage.textContent = message;
  toast.className = 'toast visible ' + type;
  toastTimeout = setTimeout(() => {
    toast.className = 'toast hidden';
  }, 4000);
}
