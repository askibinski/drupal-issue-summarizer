# Drupal Issue Summarizer

A Chrome extension that uses Claude AI to summarize Drupal.org issue pages. Drupal issues can grow to hundreds of comments — this extension injects a collapsible summary panel directly into the page so you can understand the current state in seconds.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Claude AI](https://img.shields.io/badge/Powered%20by-Claude%20AI-CC785C)

## Features

- **Automatic summarization** — panel appears on any Drupal.org issue page
- **Structured output** — TL;DR, current status, key discussion points, action items, and notable context
- **Caching** — summaries are cached locally for instant re-display
- **Re-analyze** — one-click refresh when an issue gets new activity
- **Model selection** — choose between Haiku (fast/cheap), Sonnet (balanced), or Opus (most capable)
- **Collapsible panel** — stays out of your way when you don't need it
- **Privacy-first** — your API key stays in local storage, never synced to Google's servers

## Installation

1. Clone or download this repository:
   ```
   git clone git@github.com:askibinski/drupal-issue-summarizer.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `drupal-issue-summarizer` directory
5. Click the extension icon and enter your Claude API key from [console.anthropic.com](https://console.anthropic.com/)

## Usage

1. Navigate to any Drupal.org issue page (e.g., `https://www.drupal.org/project/drupal/issues/3575467`)
2. The summary panel appears automatically at the top of the issue content
3. Wait a few seconds for Claude to analyze the issue
4. On subsequent visits, the cached summary loads instantly (shown with a "Cached" badge)
5. Click **Re-analyze** to generate a fresh summary

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐     ┌───────────┐
│ Content      │────>│ Background       │────>│ Drupal.org   │     │ Claude    │
│ Script       │     │ Service Worker   │     │ REST API     │     │ API       │
│              │<────│                  │<────│              │     │           │
│ Renders      │     │ Cache check      │     │ Issue + all  │     │ Summarize │
│ panel in     │     │ Fetch issue data │────>│ comments     │────>│ with      │
│ page DOM     │     │ Build prompt     │     │              │     │ structured│
│              │     │ Call Claude      │<────│              │<────│ output    │
│              │     │ Cache result     │     │              │     │           │
└─────────────┘     └──────────────────┘     └──────────────┘     └───────────┘
```

### Data Sources

- **Issue data:** `GET https://www.drupal.org/api-d7/node/{ID}.json` (public, no auth)
- **Comments:** `GET https://www.drupal.org/api-d7/comment.json?node={ID}` (paginated, up to 500 comments)

### Token Budget

To keep API costs minimal (~$0.001/summary with Haiku):
- Issue body: max 10,000 characters
- Each comment: max 1,000 characters
- Large issues (60k+ chars): keeps first 5 + last 15 comments for context
- Total prompt: capped at 80,000 characters (~20k tokens)

## File Structure

```
drupal-issue-summarizer/
├── manifest.json     # Manifest V3 configuration
├── background.js     # Service worker: API calls, caching, prompt building
├── content.js        # Injected UI: summary panel, markdown renderer
├── popup.html        # Settings popup: API key, model picker, cache management
├── popup.js          # Settings logic
├── styles.css        # Panel styling (dis- prefixed to avoid CSS conflicts)
└── icons/            # Extension icons (16, 48, 128px)
```

## Configuration

Open the extension popup to configure:

| Setting | Options | Default |
|---------|---------|---------|
| API Key | Your Claude API key (`sk-ant-...`) | — |
| Model | Haiku 4.5 / Sonnet 4.6 / Opus 4.6 | Haiku 4.5 |

Model preference syncs across Chrome devices. The API key stays local.

## Privacy & Security

- **API key storage:** Stored in `chrome.storage.local` (sandboxed per-extension, never synced)
- **Permissions:** Minimal — only `storage` + two host endpoints (`drupal.org/api-d7/*`, `api.anthropic.com/v1/messages`)
- **No tracking:** No analytics, no telemetry, no data collection
- **Issue data:** Fetched from Drupal.org's public REST API, sent to Claude for summarization, cached locally

## Development

This is a standard Chrome Manifest V3 extension with no build step. Edit the files directly and reload the extension at `chrome://extensions`.

To test:
1. Load the extension unpacked
2. Set your API key
3. Visit a Drupal.org issue page
4. Check the browser console for any errors (`F12` > Console tab)

## License

MIT
