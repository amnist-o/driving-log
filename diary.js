/* ==========================================
   DRIVE LOG — Diary (on-phone diagnostics log)
   ========================================== */

// Lives in the home-screen app's own storage. Never sent anywhere — the owner
// copies it from the Diagnostics panel and pastes it to whoever is helping.
// Capped so it never grows: a few weeks of entries at ~3 trips a day.

const KEY = 'diary';
const MAX_ENTRIES = 300;

function readEntries() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

export function logEvent(name, details = {}) {
  try {
    const entries = readEntries();
    entries.push({ t: new Date().toISOString(), e: name, ...details });
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // A diary problem must never break the app
  }
}

export function getDiaryText() {
  const entries = readEntries();
  if (entries.length === 0) return '(diary is empty)';
  return entries.map(({ t, e, ...rest }) => {
    const extra = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' ');
    return `${t} ${e}${extra ? ' ' + extra : ''}`;
  }).join('\n');
}

export function clearDiary() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// Short id so a diary line can be matched to Google's Executions page
export function newRequestId() {
  return Math.random().toString(36).slice(2, 8);
}
