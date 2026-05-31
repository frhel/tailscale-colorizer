// ─── Tailscale Tag Colorizer — Background Service Worker ──────────────────
// Minimal worker that ensures storage is healthy and provides a recovery
// path if the popup or content script gets into a broken state.

'use strict';

const DEFAULTS = {
  enabled: true,
  sortEnabled: false,
  sortMode: 'frequency',
  rules: [],
  highlightMode: 'border-left',
  bgOpacity: 0.10,
};

// ── Storage helpers ───────────────────────────────────────────────────────

async function getSettings() {
  try {
    const stored = await chrome.storage.local.get('tsColorizerSettings');
    return stored.tsColorizerSettings;
  } catch (_) {
    return null;
  }
}

async function ensureValidSettings() {
  try {
    const raw = await getSettings();
    // If storage is missing, corrupt, or wrong shape — reset to defaults
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      await chrome.storage.local.set({ tsColorizerSettings: { ...DEFAULTS } });
      return;
    }
    // Sanitize known fields; spread raw to future-proof against new keys
    const clean = {
      ...raw,
      enabled:       raw.enabled !== false,
      sortEnabled:   raw.sortEnabled === true,
      sortMode:      raw.sortMode || 'frequency',
      rules:         Array.isArray(raw.rules) ? raw.rules : [],
      highlightMode: raw.highlightMode || 'border-left',
      bgOpacity:     typeof raw.bgOpacity === 'number' ? raw.bgOpacity : 0.10,
    };
    await chrome.storage.local.set({ tsColorizerSettings: clean });
  } catch (err) {
    console.warn('TS Colorizer: storage validation failed, resetting.', err);
    try { await chrome.storage.local.set({ tsColorizerSettings: { ...DEFAULTS } }); } catch (_) {}
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function (details) {
  ensureValidSettings();

  // When extension updates, nudge all open Tailscale tabs to rescan
  if (details.reason === 'update') {
    signalRescan();
  }
});

chrome.runtime.onStartup.addListener(function () {
  ensureValidSettings();
});

// ── Rescan signaling (storage-based, works without tabs permission) ────────

function signalRescan() {
  try {
    chrome.storage.local.set({ tsRescanRequest: Date.now() });
  } catch (_) {}
}

// ── External commands from popup ──────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.action === 'rescan') {
    signalRescan();
    sendResponse({ ok: true });
  }
  // Also handle validate-settings so popup can ask the SW to fix storage
  if (msg.action === 'validateSettings') {
    ensureValidSettings().then(function () {
      sendResponse({ ok: true });
    });
    return true; // async response
  }
});
