# AGENTS.md — Tailscale Colorizer

Chrome extension (Manifest V3) that colorizes machines on `login.tailscale.com/admin/machines` by tag.

## File map

| File | Role |
|------|------|
| `manifest.json` | Manifest V3: permissions, content script match, service worker, popup |
| `background.js` | Service worker — validates/sanitizes storage on install/startup/update |
| `content.js` | Injected into Tailscale — discovers tags, colorizes rows/pills, sorts, observes DOM |
| `popup.html` | Popup UI: enable toggle, mode dropdown, tint slider, sort toggle, sort mode, tag rules list |
| `popup.js` | Popup logic: storage read/write, rules CRUD, broadcast rescan |
| `popup.css` | Dark-themed popup styles using CSS custom properties on `:root` |
| `icons/` | icon16.png, icon48.png, icon128.png — 3×3 colored dot grid on dark bg |

## Architecture

**Data flow**: Popup writes `tsColorizerSettings` to `chrome.storage.local` → content script `onChanged` listener picks it up → `removeAllColorization()` then `scanAndColorize()`. No direct messaging for settings.

**Rescan requests**: Popup tries `chrome.tabs.sendMessage` first; falls back to writing `tsRescanRequest` timestamp to storage (content script watches both).

**Background.js**: `ensureValidSettings()` runs on `runtime.onInstalled` and `runtime.onStartup`. Spreads `...raw` to preserve unknown keys. Coerces known fields to correct types.

## Key patterns (content.js)

- **`isAlive()` / `teardown()`**: Every `chrome.*` API call gates on `isAlive()` which checks `chrome.runtime.id`. On death, sets `dead = true`, disconnects observer, clears timer, removes all colorization.
- **`busy` flag**: Set during `scanAndColorize()`. Both mutation observers skip all events while `busy` is true — prevents our own DOM mutations from triggering re-scans.
- **`lastScanTime` cooldown**: 1-second minimum between `scanAndColorize()` calls.
- **`debouncedScan()`**: 300ms debounce on MutationObserver-triggered scans.
- **`snapshotRowOrder()` / `restoreOriginalOrder()`**: One-time snapshot of `data-ts-original-pos` for sort toggle off → restore.
- **`sortRowsByTag()`**: Frequency mode (grouping by most-shared tag) or alphabetical (first sortable tag). Respects per-rule `sortable` boolean.
- **`ensureRulesForTags()`**: Auto-creates rules with deterministic `paletteColor()` hash (12-color palette). Sets `sortable: true`.

## Colorization layers

1. **Pill level** (always): `colorizePill()` / `uncolorizePill()` — border-color + rgba(12%) background on `[class*="rounded-full"]` containers. Tracked via `data-ts-pill`.
2. **Row level** (mode-dependent): `applyRowColorization()` — box-shadow stripes (border-left/both), averaged background tint (bg-tint/both), or none (pill-only). Tracked via `data-ts-colorized`.

Multi-tag rows: pills colored individually. Row gets stacked box-shadow stripes with 1px `#000` separators, or averaged RGB tint.

## Settings schema

```json
{
  "enabled": true,
  "sortEnabled": false,
  "sortMode": "frequency",
  "rules": [{ "tag": "tag:prod", "color": "#ef4444", "sortable": true }],
  "highlightMode": "border-left",
  "bgOpacity": 0.10
}
```

Rules are auto-discovered. `sortable` defaults to `true` and is checked with `!== false` for backward compat.

## Injected CSS

`injectStyles()` appends a `<style id="ts-colorizer-styles">` to `<head>`:
- `table.tb tbody tr { border-bottom: 1px solid #000 !important; }`
- `html.ts-bg-highlight table.tb a[href*="/update/"] svg { color: #fff !important; }` (SVG icons on bg-tint)

`ts-bg-highlight` class toggled on `<html>` in `scanAndColorize()` when mode is `bg-tint` or `both`.

## Conventions

- All files `'use strict'`
- Content script in IIFE
- No build step, no dependencies
- Version bumps: `x.y.z` for releases, `x.y.z.N` for non-publish changes
- Zip files: `tailscale-colorizer-x.y.z.zip`, not committed (`.gitignore` covers `*.zip`)
- License: MIT (from OSI)

## Observer details

Two `MutationObserver` instances:
1. On `table.tb` (or `document.body` if no table yet): `childList + subtree`. Triggers `debouncedScan()` on any `addedNodes`.
2. On `document.body`: watches for new `table.tb` insertion (table replacement detection).

Both skip mutations when `busy` is true.

## Permissions

`storage` (settings), `tabs` (direct messaging to open Tailscale tabs), `host: login.tailscale.com/*` (content script injection).
