# Tailscale Tag Colorizer

A Chrome extension (Manifest V3) that colorizes machines on the [Tailscale admin console](https://login.tailscale.com/admin/machines) by their tags. Tag-based colorization for Tailscale fleets.

---

## Features

- **Automatic tag discovery** — scans the Machines page for tag pills and detects every tag in use. No manual tag registration needed.

- **Deterministic color palette** — each tag string is hashed to one of 12 well-spaced colors. The same tag always gets the same color across sessions, machines, and reloads.

- **Four highlight modes** — choose how machines are visually marked (see [Colorization modes](#colorization-modes)).

- **Adjustable opacity** — fine-tune the background tint intensity from 3% to 20%.

- **Enable/disable toggle** — flip all colorization on or off instantly from the popup. Disabling preserves all rules and settings.

- **Sort by tag** — reorder the machines table so rows with the same tag cluster together. Supports two sort strategies and per-tag exclusion (see [Sorting](#sorting)).

- **Multi-tag machines** — machines with multiple tags get per-pill coloring *plus* stacked left-border stripes with separators, or an averaged background tint depending on mode.

- **Self-healing storage** — the background service worker validates and repairs corrupted settings on browser startup and extension update.

- **Context invalidation guard** — if the extension is reloaded or updated while a Tailscale tab is open, the content script detects the dead context and gracefully tears itself down.

- **Defensive DOM observation** — a busy flag and cooldown timer prevent MutationObserver-driven scan feedback loops when the extension itself modifies the DOM.

---

## Architecture Overview

### File map

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Manifest V3): permissions, content script injection, background service worker, popup |
| `background.js` | Service worker — validates storage on startup/install/update, handles `rescan` messages from popup |
| `content.js` | Injected into `login.tailscale.com` — discovers tags, colorizes rows/pills, handles sorting, observes DOM mutations |
| `popup.html` | Popup UI structure — toggles, mode selectors, rules list, footer buttons |
| `popup.js` | Popup logic — reads/writes settings to `chrome.storage.local`, renders rule rows, broadcasts rescans |
| `popup.css` | Popup styles — dark theme with CSS custom properties |
| `icons/` | Extension icons at 16×16, 48×48, and 128×128 |

### Data flow

```
┌─────────┐  write  ┌──────────────────┐  onChanged  ┌──────────────┐
│ popup.js │ ──────▶│ chrome.storage.   │ ──────────▶│  content.js  │
│          │        │   local           │             │              │
│  ┌───────│◀────── │                   │             │  scanAnd     │
│  │render │ read   │ tsColorizer       │             │  Colorize()  │
│  └───────│        │ Settings          │             │              │
└─────────┘        └──────────────────┘             │  ┌─────────┐ │
                       ▲                             │  │ DOM     │ │
                       │ validate                    │  │ colori- │ │
                 ┌─────┴──────┐                      │  │ zation  │ │
                 │ background │                      │  └─────────┘ │
                 │    .js     │                      └──────────────┘
                 └────────────┘
```

1. **Popup writes** to `chrome.storage.local` under the key `tsColorizerSettings`.
2. **Content script listens** for `chrome.storage.onChanged` and reloads settings, then re-runs `scanAndColorize()`.
3. **Background service worker** validates storage on install/startup/update and can be asked to fix corrupted settings.
4. **Rescan requests** from the popup travel via `chrome.tabs.sendMessage` when a Tailscale tab is open, or via a storage key (`tsRescanRequest`) as a fallback — the content script watches both.

This is a **storage-based broadcast pattern** — the popup never sends settings directly to the content script. All settings changes are written to storage; the content script picks them up through its `onChanged` listener. This avoids fragile direct messaging and keeps the content script as the single source of truth for what the DOM should look like.

### Content script lifecycle

```
init()
  ├── injectStyles()          ← CSS for row borders, SVG icon fixes
  ├── loadSettings()          ← read from chrome.storage.local
  ├── scanAndColorize()       ← initial scan
  └── startObserver()         ← watch for new rows / table swaps

onChanged → removeAllColorization() → scanAndColorize()
onChanged (tsRescanRequest) → rescan() → loadSettings() → scanAndColorize()
```

### Observer pattern

A `MutationObserver` on `table.tb` (and a second observer on `document.body` for table replacement) triggers `debouncedScan()` whenever child nodes are added. The debounce (300ms) coalesces rapid DOM changes (e.g., a batch of rows changing at once after filtering or pagination).

Two guards protect against feedback loops:

- **Busy flag** (`busy = true` during `scanAndColorize`): the observer ignores mutations triggered by the extension's own DOM modifications.
- **Cooldown** (`Date.now() - lastScanTime < 1000`): prevents more than one full scan per second, blocking any rapid-fire mutations from causing a storm.

### Context invalidation guard

When a Chrome extension is reloaded or updated, all previously-injected content scripts lose their `chrome.runtime` context. Any `chrome.*` API call throws `"Extension context invalidated"`. The content script detects this through:

```
isAlive() → checks chrome.runtime.id → if dead, sets `dead = true`, calls teardown()
teardown() → disconnects observer, clears timers, removes all colorization
```

Every async entry point (`loadSettings`, `saveSettings`, `scanAndColorize`, `rescan`, message listener, storage listener) gates on `isAlive()` before proceeding.

---

## Colorization Modes

The extension works at two levels:

### Pill level (always active)

Every tag pill (the `rounded-full` container) gets:
- A **colored border** (`border-color` set to the tag's rule color, `important`)
- A **tinted background** (`rgba(r,g,b,0.12)`, `important`)

These are tracked via the `data-ts-pill` attribute and are always applied regardless of highlight mode.

### Row level (mode-dependent)

Controlled by the **Mode** dropdown in the popup:

| Mode | Behavior |
|------|----------|
| **Border (left)** | Stacked color stripes on the left edge of the row. Each tag gets a 4px colored stripe, with 1px black separators between them. Multi-tag machines show multiple stripes. |
| **Background tint** | Averages all tag colors and applies a translucent background to the entire row. Opacity controlled by the tint slider. |
| **Both** | Combines left-border stripes *and* background tint simultaneously. |
| **Pill only** | No row-level colorization. Only the pills themselves are colored. Useful when you want subtle visual cues without altering the table layout. |

### Multi-tag row rendering

When a machine has multiple tags (e.g., `tag:prod` and `tag:us-east`):

- **Pills**: each tag pill is colored independently with its own tag's color.
- **Border mode**: stacked `box-shadow` stripes. For example, with two tags you'd see a 4px red stripe, a 1px black separator, and a 4px green stripe. The row's `padding-left` is increased to accommodate the total stripe width.
- **Background tint**: the RGB values of all tags' colors are averaged together before applying the background tint, producing a blended color.

Row colorization is tracked via the `data-ts-colorized` attribute, which stores the comma-separated list of tag names for that row.

---

## Sorting

### Enable/disable

The **Sort by tag** toggle in the popup controls whether the machines table is reordered. When toggled **off**, rows are restored to their original order (as captured when sorting was first enabled).

### Sort modes

| Mode | Behavior |
|------|----------|
| **Grouping (shared tags)** | Each machine picks its most-shared sortable tag (the one with the highest frequency across all machines). Rows are sorted by frequency descending, then by tag name ascending. Machines with the same "best" tag cluster together. |
| **Alphabetical (first tag)** | Each machine sorts by its first sortable tag alphabetically. |

### Per-tag sort exclusion

Each tag rule has a `sortable` property (default `true`). In the popup, each tag row shows a sort-toggle button (▼). Clicking it marks the tag as excluded from sorting (⊘). Machines whose *only* sortable tags are all excluded fall to the bottom of the table alongside untagged machines.

### Snapshot and restore

When sorting is first activated, the extension snapshots every row's position by writing a `data-ts-original-pos` attribute. When sorting is toggled off, rows are restored to this original order. Rows added after the snapshot (e.g., by the page loading more data) fall to the bottom during restore.

---

## Multi-Tag Support

Machines in Tailscale can carry multiple tags (e.g., `tag:prod`, `tag:us-east`, `tag:web`). The extension handles this at two independent layers:

1. **Pill coloring** — each individual tag pill on the page gets its own color, determined by the rule for that tag. This is always applied.

2. **Row coloring** — the highlight mode determines how multiple tags translate to a single row appearance:
   - **border-left**: stacked stripes with separators (see [Colorization modes](#colorization-modes)).
   - **bg-tint**: RGB values are averaged across all tags for a blended tint.
   - **both**: stacked stripes + blended background.
   - **pill-only**: no row-level effect; only pills are colored.

All tags for a machine are collected by grouping pill hits by their enclosing `<tr>` inside `table.tb`. The `data-ts-colorized` attribute on the row stores the full comma-separated tag list (e.g., `tag:prod,tag:us-east`), enabling sort logic to consider every tag a machine carries.

---

## Defensive Patterns

### Storage wrapper availability checks

Both `popup.js` and `content.js` guard against `chrome.storage` being undefined (which can happen in corrupted browser profiles or during extension reload races).

`popup.js` wraps storage in a `storage` object with an `available` getter:

```js
const storage = {
  get available() {
    return !!(chrome && chrome.storage && chrome.storage.local);
  },
  async get(keys) { ... },
  set(obj) { ... }
};
```

### Retry logic

The popup's initialization uses a `retry()` helper that attempts `loadSettings` up to 3 times with exponential backoff (200ms, 400ms, 600ms). If all attempts fail, a **fallback UI** is rendered instead of a blank popup:

```
Something went wrong
The popup could not be loaded.
[Retry]
```

The fallback includes a "Retry" button that reloads the popup.

### Context invalidation guard

Covered in [Architecture Overview](#context-invalidation-guard). The `isAlive()` / `teardown()` pattern is the first check in every code path that touches `chrome.*` APIs.

### Busy guard + cooldown

Covered in [Observer pattern](#observer-pattern). The combination of the `busy` flag and the 1000ms cooldown prevents the MutationObserver from triggering scans while the extension is modifying the DOM or from firing rapid successive scans.

### Debounced scanning

DOM mutations trigger `debouncedScan()`, which waits 300ms of inactivity before running the full scan. This prevents multiple cascading scans from a single user action (e.g., paginating to a new page of machines).

---

## Settings Schema

All settings are stored under the key `tsColorizerSettings` in `chrome.storage.local`. The schema is defined by the `DEFAULT_SETTINGS` constant in `content.js`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master toggle. When `false`, no colorization or scanning occurs. |
| `sortEnabled` | `boolean` | `false` | Whether to reorder the machines table by tag. |
| `sortMode` | `string` | `"frequency"` | Sort strategy. `"frequency"` groups by most-shared sortable tag; `"alphabetical"` sorts by first sortable tag. |
| `rules` | `array` | `[]` | Array of tag rule objects. Each has shape `{ tag: string, color: string, sortable: boolean }`. Auto-populated by discovery; colors can be customized in the popup. |
| `highlightMode` | `string` | `"border-left"` | Row-level colorization mode. One of `"border-left"`, `"bg-tint"`, `"both"`, `"pill-only"`. |
| `bgOpacity` | `number` | `0.10` | Background tint opacity, range 0.03–0.20 (controlled by a slider mapping 3–20). |

### Rule object schema

Each element in the `rules` array:

```json
{
  "tag": "tag:prod",
  "color": "#ef4444",
  "sortable": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tag` | `string` | Full tag name including the `tag:` prefix (e.g., `"tag:prod"`). |
| `color` | `string` | Hex color string with leading `#` (e.g., `"#ef4444"`). Assigned by the deterministic palette on discovery; editable in the popup. |
| `sortable` | `boolean` | Whether this tag participates in sorting. Default `true` on auto-created rules. |

### Storage validation in background.js

The background service worker validates settings on every startup and update. It:

1. Checks that `tsColorizerSettings` exists and is a plain object (not `null`, not an array).
2. Coerces each known field to its correct type (`enabled` to boolean, `rules` to array, `bgOpacity` to number, etc.).
3. Spreads unknown keys through so future settings additions aren't lost.
4. Falls back to defaults if validation fails entirely.

A separate storage key `tsRescanRequest` (a timestamp) is used as a signal for the content script to rescan. This allows rescans to be triggered even when no Tailscale tabs are open (via storage) and without requiring the `tabs` permission for direct messaging.

---

## Installation

### Load as an unpacked extension

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the project directory (the folder containing `manifest.json`).

No build step, package manager, or compilation is required. The extension is pure JavaScript, HTML, and CSS.

### Permissions explained

| Permission | Reason |
|-----------|--------|
| `storage` | Read/write settings and rescan signals via `chrome.storage.local`. |
| `tabs` | Query open Tailscale tabs to broadcast rescan messages directly. |
| `host_permissions: https://login.tailscale.com/*` | Inject `content.js` into the Tailscale admin console. |

---

## Development

### File layout

```
tailscale-extension/
├── manifest.json       # Extension manifest (Manifest V3)
├── background.js       # Service worker
├── content.js          # Content script (injected into Tailscale admin)
├── popup.html          # Popup UI
├── popup.js            # Popup logic
├── popup.css           # Popup styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
└── .gitignore
```

### No build step

The extension loads directly from source. To test changes:

1. Make your edits.
2. Go to `chrome://extensions`.
3. Click the **reload** icon (↻) on the extension card.
4. Refresh any open Tailscale admin tabs.

### Coding conventions

- All files use `'use strict'`.
- The content script is wrapped in an IIFE to avoid polluting the page's global scope.
- CSS custom properties in `:root` define the popup's design tokens.
- Settings are always sanitized on read — no field is trusted to be the right type or to exist.

---

## Known Limitations & Edge Cases

- **Page structure dependency**: Tag discovery relies on specific CSS classes (`span.text-text-muted`, `[class*="rounded-full"]`) and the `table.tb` selector. If Tailscale changes their admin console markup, the extension may stop discovering tags until the selectors are updated.

- **Single-page behavior**: The extension only operates on `https://login.tailscale.com/*`. Other Tailscale deployments (self-hosted coordination servers, custom domains) are not supported without modifying `host_permissions` and content script matches in `manifest.json`.

- **No cross-tab tag sharing**: Each tab discovers tags independently. If you open two Tailscale admin tabs and manually add a tag rule in one popup, the rules are shared via storage, but scanning in one tab does not automatically scan the other — the other tab picks up the new settings via `onChanged` and rescans.

- **Sorting with dynamic content**: When new rows are added after sorting is enabled (e.g., infinite scroll loads more machines), they will appear at the natural DOM position, not in sorted order, until the next scan. The MutationObserver will detect the new rows and trigger a rescan, which will re-sort.

- **Large tables**: Scanning and sorting very large machine tables (hundreds or thousands of rows) may cause a brief visual flicker as the DOM is rewritten. The busy flag prevents observer feedback loops during this time, but the operation itself is synchronous DOM manipulation.

- **Extension update races**: When the extension updates while a Tailscale tab is open, the content script's context is invalidated. The `isAlive()` guard prevents errors, but the user must **refresh the tab** to re-inject the new content script. A future enhancement could auto-refresh or prompt the user.

- **No data persistence for removed machines**: If a machine is deleted from Tailscale, its rule persists in settings. Rules are only cleaned up manually via the "Clear all rules" button or by deleting individual rules. There is no automatic garbage collection of unused rules.

- **`chrome.tabs.sendMessage` can fail silently**: When no Tailscale tab is open, `broadcast()` catches the error and falls back to the storage-based rescan signal (`tsRescanRequest`). This is intentional but might cause a slight delay if the user opens the tab after changing settings.

---

## License

MIT
