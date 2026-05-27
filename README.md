# 🚗 Drive Log

A mobile-first web app that extracts driving data from your car's dashboard photo using AI and logs it to Google Sheets.

**Take a photo → AI reads the numbers → Verify & fill in trip info → Done.**

## Features

- 📷 Snap or upload a dashboard photo
- 🤖 Gemini Flash AI extracts fuel economy, distance, and duration with confidence scores
- 🔄 Tesseract.js fallback OCR when AI is unavailable (runs entirely in-browser)
- ✏️ "Skip — Enter Manually" option to bypass AI entirely
- 🖼️ Collapsible photo preview on the review screen for cross-checking extracted values
- 📅 Auto-fills date and time from photo EXIF metadata (with `hh:mm:ss` precision)
- 📍 Auto-fills "From" with the previous trip's destination
- 📝 Simple form for From, Destination, and Purpose
- 📊 Submits directly to your Google Sheet
- 📡 Offline support — queues trips locally and auto-syncs when back online
- 🔢 Pending trips badge with sync status panel

## Architecture

```
Phone Browser (GitHub Pages)
  ↓ photo (base64)
Google Apps Script (doPost)
  ↓ calls Gemini Flash API (4-model fallback chain)
  ↓ returns extracted JSON + confidence scores
Phone Browser
  ↓ user verifies data (with photo reference + confidence indicators)
  ↓ form submission
Google Apps Script
  ↓ appends row
Google Sheets ✅

Offline path:
  Phone Browser → localStorage queue → auto-sync on reconnect → Google Sheets ✅
  
Fallback extraction:
  Gemini fails → Tesseract.js (client-side OCR) → manual entry
```

## Setup Guide

### Step 1: Deploy the Apps Script Backend

1. Open your [Google Sheet](https://docs.google.com/spreadsheets/d/1P-2VtlTPO5jost2Db30kAzXZJe_W3pWECM_i-gPP5EY/edit)
2. Go to **Extensions → Apps Script**
3. Delete any existing code in the editor
4. Copy the entire contents of [`apps-script/Code.gs`](apps-script/Code.gs) and paste it in
5. Click the **⚙️ gear icon** (Project Settings) in the left sidebar
6. Scroll down to **Script Properties** → click **Add script property**
   - Property: `GEMINI_API_KEY`
   - Value: your Gemini API key from [aistudio.google.com](https://aistudio.google.com/apikey)
7. Click **Save**
8. Go back to the editor, click **Deploy → New deployment**
9. Click the gear icon next to "Select type" → choose **Web app**
10. Set **Execute as**: `Me`
11. Set **Who has access**: `Anyone`
12. Click **Deploy**
13. **Copy the Web App URL** — you'll need it in Step 2

### Step 2: Configure the Web App

1. Open `app.js`
2. Find the `CONFIG` object at the top:
   ```javascript
   const CONFIG = {
     SCRIPT_URL: '', // ← Paste your Apps Script deployment URL here
   };
   ```
3. Paste the URL from Step 1 inside the quotes
4. Save the file and commit/push to GitHub

### Step 3: Open on Your Phone

1. Visit `https://<your-username>.github.io/driving-log/`
2. Tap **Share → Add to Home Screen** for an app-like experience

## How It Works

### AI Extraction
The backend tries up to 4 Gemini models in sequence (`gemini-2.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-2.0-flash` → `gemini-1.5-flash`). If all fail (quota exhaustion), the app falls back to Tesseract.js client-side OCR or lets you enter data manually.

### Confidence Indicators
Each extracted value gets a confidence score from the AI. High confidence (≥ 0.8) shows a green ✓, low confidence shows an amber ⚠ with a highlighted border so you know to double-check.

### EXIF Time Extraction
When you upload an old photo, the app reads the EXIF `DateTimeOriginal` timestamp (second precision) and auto-fills the date and time from when the photo was actually taken — not from the current time.

### Offline Support
If you're offline, trips are saved to `localStorage` and a pending badge appears in the header. When you come back online, the app automatically syncs all queued trips and shows a confirmation toast.

## Updating the Apps Script

If you update `Code.gs`, you need to create a **new deployment version**:
1. Open Apps Script
2. Click **Deploy → Manage deployments**
3. Click the **pencil icon** on your deployment
4. Change **Version** to **New version**
5. Click **Deploy**

## Cost

The backend uses Gemini Flash Lite models by default (cheapest). Each extraction costs a fraction of a cent. With Google AI Studio's free tier, you have generous limits. The Tesseract.js fallback runs entirely in-browser at zero cost.

## License

MIT
