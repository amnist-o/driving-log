# 🚗 Drive Log

A mobile-first web app that extracts driving data from your car's dashboard photo using AI and logs it to Google Sheets.

**Take a photo → AI reads the numbers → You fill in 3 fields → Done.**

## Features

- 📷 Snap or upload a dashboard photo
- 🤖 Gemini Flash AI extracts fuel economy, distance, and duration
- 📅 Auto-fills date and time
- 📝 Simple form for From, Destination, and Purpose
- 📊 Submits directly to your Google Sheet

## Architecture

```
Phone Browser (GitHub Pages)
  ↓ photo (base64)
Google Apps Script (doPost)
  ↓ calls Gemini Flash API
  ↓ returns extracted JSON
Phone Browser
  ↓ form submission
Google Apps Script
  ↓ appends row
Google Sheets ✅
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

## Date Format

The script sends dates as `DD/MM/YYYY`. If your sheet uses a different format, edit the `handleSubmit` function in `Code.gs`.

## Updating the Apps Script

If you update `Code.gs`, you need to create a **new deployment version**:
1. Open Apps Script
2. Click **Deploy → Manage deployments**
3. Click the **pencil icon** on your deployment
4. Change **Version** to **New version**
5. Click **Deploy**

## Cost

Using `gemini-2.0-flash` with a minimal prompt (image + ~50 text tokens), each extraction costs a fraction of a cent. With Google AI Pro, you have generous free limits.

## License

MIT
