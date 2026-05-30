# Tailscale Tag Colorizer

A Chrome extension that recolors machines in the [Tailscale admin console](https://login.tailscale.com) based on their tags. Never confuse `prod` with `staging` again.

## Features

- **Auto-discovery** — scans the Machines page and finds all tags automatically
- **Deterministic palette** — each tag gets a stable color across reloads and devices
- **Three highlight modes** — border (left), background tint, or both
- **Adjustable opacity** — fine-tune the tint intensity
- **Enable/disable toggle** — flip colorization on or off instantly
- **Self-healing** — retries storage read failures and validates settings on browser startup

## Install

1. Clone or download this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repo folder

## Usage

1. Open the [Tailscale Machines page](https://login.tailscale.com/admin/machines)
2. Click the extension icon in your toolbar
3. Click **Scan now** to discover tags on the page
4. Assign colors to tags or let the auto-palette handle it
5. Choose your preferred highlight mode and opacity

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Manifest V3) |
| `popup.html` | Popup UI shown when clicking the icon |
| `popup.js` | Popup logic — settings, rendering, broadcast |
| `popup.css` | Popup styles (dark theme) |
| `content.js` | Injected into Tailscale admin — discovers tags and colorizes rows |
| `background.js` | Service worker — storage validation, rescan signaling |
| `icons/` | Extension icons (16, 48, 128 px) |

## License

MIT
