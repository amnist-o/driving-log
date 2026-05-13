/* ==========================================
   DRIVE LOG — App Logic
   ========================================== */

// ===== CONFIGURATION =====
// After deploying the Apps Script, paste the web app URL here:
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwI9U13m2D-F_T7j48R8f8t21sRzWz41d8Fv648sP02X7oH1GkU1o249i7k29m/exec',
  MAX_IMAGE_WIDTH: 1024,
  JPEG_QUALITY: 0.8
};

// ===== STATE =====
let currentScreen = 0;
let imageBase64 = null;
let imageMimeType = null;

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
  previewImage.src = blobUrl;
  previewImage.classList.remove('hidden');
  previewPlaceholder.classList.add('hidden');
  clearImageBtn.classList.remove('hidden');
  previewZone.classList.add('has-image');

  // Read as ArrayBuffer for MIME detection + base64 encoding
  const reader = new FileReader();
  reader.onload = async (evt) => {
    const arrayBuffer = evt.target.result;

    // Detect real MIME type from file bytes (don't trust file.type)
    const detectedMime = detectMimeType(arrayBuffer) || file.type || 'image/jpeg';

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
  if (previewImage.src && previewImage.src.startsWith('blob:')) {
    URL.revokeObjectURL(previewImage.src);
  }
  imageBase64 = null;
  imageMimeType = null;
  previewImage.src = '';
  previewImage.classList.add('hidden');
  previewPlaceholder.classList.remove('hidden');
  clearImageBtn.classList.add('hidden');
  previewZone.classList.remove('has-image');
  extractBtn.disabled = true;
  cameraInput.value = '';
  uploadInput.value = '';
}

// ===== EXTRACT DATA =====
async function handleExtract() {
  if (!imageBase64 || !CONFIG.SCRIPT_URL) {
    if (!CONFIG.SCRIPT_URL) {
      showToast('Please set the Apps Script URL in app.js', 'error');
    }
    return;
  }

  setButtonLoading(extractBtn, extractSpinner, true);

  try {
    const response = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'extract',
        image: imageBase64,
        mimeType: imageMimeType
      })
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);

    const result = await response.json();

    if (result.error) throw new Error(result.error);

    // Populate extracted fields
    fields.fuelEconomy.value = result.fuel_economy ?? '';
    fields.distance.value = result.distance ?? '';
    fields.duration.value = result.duration ?? '';

    // Auto-fill date & time
    const now = new Date();
    fields.tripDate.value = formatDate(now);
    fields.arrivalTime.value = formatTime(now);

    goToScreen(1);
  } catch (err) {
    showToast('Extraction failed: ' + err.message, 'error');
  } finally {
    setButtonLoading(extractBtn, extractSpinner, false);
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

  try {
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

    const response = await fetch(CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);

    const result = await response.json();

    if (result.error) throw new Error(result.error);

    // Show success with summary
    const summary = $('#successSummary');
    summary.innerHTML = `
      <strong>${payload.date}</strong> at ${payload.arrivalTime}<br>
      📏 ${payload.distance} km &nbsp;·&nbsp; ⛽ ${payload.fuelEconomy} km/L &nbsp;·&nbsp; ⏱ ${payload.duration} min<br>
      ${payload.from ? `📍 ${payload.from} → ${payload.destination}` : ''}
      ${payload.purpose ? `<br>📝 ${payload.purpose}` : ''}
    `;

    goToScreen(2);
  } catch (err) {
    showToast('Submit failed: ' + err.message, 'error');
  } finally {
    setButtonLoading(submitBtn, submitSpinner, false);
  }
}

// ===== NEW TRIP =====
function handleNewTrip() {
  clearImage();
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
  return `${h}:${m}`;
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
