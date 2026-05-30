// ─── Tailscale Tag Colorizer — Content Script ─────────────────────────────
// Injected into login.tailscale.com. Auto-discovers machine tags in the
// admin console and colors rows using a deterministic palette. No hardcoded
// defaults — finds whatever tags are on the page.

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────
  const COLORIZED_ATTR = 'data-ts-colorized';

  // 12-colour rotating palette (Tailwind palette, well-spaced)
  const AUTO_PALETTE = [
    '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
    '#e11d48', '#84cc16',
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    rules: [],            // { tag, color }[] — populated by discovery
    highlightMode: 'border-left',
    bgOpacity: 0.10,
  };

  // ── State ──────────────────────────────────────────────────────────────
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let scanTimer = null;
  let pendingSave = false;

  // ── Settings I/O ───────────────────────────────────────────────────────

  async function loadSettings() {
    let raw;
    try {
      const stored = await chrome.storage.local.get('tsColorizerSettings');
      raw = stored.tsColorizerSettings;
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    settings = {
      enabled:       raw.enabled !== false,
      rules:         Array.isArray(raw.rules) ? raw.rules : [],
      highlightMode: raw.highlightMode || 'border-left',
      bgOpacity:     typeof raw.bgOpacity === 'number' ? raw.bgOpacity : 0.10,
    };
  }

  function saveSettings() {
    if (pendingSave) return;
    pendingSave = true;
    setTimeout(async () => {
      await chrome.storage.local.set({ tsColorizerSettings: settings });
      pendingSave = false;
    }, 300);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tsColorizerSettings) {
      settings = changes.tsColorizerSettings.newValue || { ...DEFAULT_SETTINGS };
      removeAllColorization();
      if (settings.enabled) scanAndColorize();
    }
    if (area === 'local' && changes.tsRescanRequest) {
      rescan();
    }
  });

  // ── Palette assignment ─────────────────────────────────────────────────

  /** Deterministic colour for a tag string so it's stable across reloads. */
  function paletteColor(tag) {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
      hash = ((hash << 5) - hash) + tag.charCodeAt(i);
      hash |= 0;
    }
    return AUTO_PALETTE[Math.abs(hash) % AUTO_PALETTE.length];
  }

  // ── Rule lookup ────────────────────────────────────────────────────────

  function buildRuleMap() {
    const map = new Map();
    for (const rule of settings.rules) {
      if (rule.tag) map.set(rule.tag.toLowerCase(), rule);
    }
    return map;
  }

  /** Ensure every discovered tag has a rule — auto-assign if missing. */
  function ensureRulesForTags(discovered) {
    let changed = false;
    for (const tag of discovered) {
      const key = tag.toLowerCase();
      const exists = settings.rules.some(
        r => r.tag && r.tag.toLowerCase() === key
      );
      if (!exists) {
        settings.rules.push({ tag, color: paletteColor(tag) });
        changed = true;
      }
    }
    if (changed) saveSettings();
  }

  // ── Colorization ───────────────────────────────────────────────────────

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
    };
  }

  function applyColorization(row, rule) {
    if (row.hasAttribute(COLORIZED_ATTR)) return;
    row.setAttribute(COLORIZED_ATTR, rule.tag);

    const mode = settings.highlightMode || 'border-left';
    const opacity = settings.bgOpacity || 0.10;

    if (mode === 'border-left' || mode === 'both') {
      row.style.setProperty('border-left', `4px solid ${rule.color}`, 'important');
      row.style.setProperty('padding-left', '12px', 'important');
    }
    if (mode === 'bg-tint' || mode === 'both') {
      const { r, g, b } = hexToRgb(rule.color);
      row.style.setProperty(
        'background-color', `rgba(${r}, ${g}, ${b}, ${opacity})`, 'important'
      );
    }
  }

  function removeColorization(row) {
    row.removeAttribute(COLORIZED_ATTR);
    row.style.removeProperty('border-left');
    row.style.removeProperty('padding-left');
    row.style.removeProperty('background-color');
  }

  function removeAllColorization() {
    document.querySelectorAll(`[${COLORIZED_ATTR}]`).forEach(removeColorization);
  }

  // ── Tag discovery ─────────────────────────────────────────────────────

  function findTagElements(root) {
    // The Tailscale admin console renders tags as:
    //   <div class="...rounded-full...">
    //     <span class="text-text-muted">tag:</span>
    //     <span class="font-medium">tagname</span>
    //   </div>
    // We find tag-label spans and grab the adjacent value span.
    const results = [];
    const labels = root.querySelectorAll('span.text-text-muted');
    for (const label of labels) {
      const text = label.textContent.trim();
      if (!/^tag:?$/i.test(text)) continue;
      const valueEl = label.nextElementSibling;
      if (!valueEl) continue;
      const val = valueEl.textContent.trim();
      if (!val || val.length > 64) continue;
      results.push({ tag: 'tag:' + val.toLowerCase(), el: valueEl });
    }
    return results;
  }

  /** Walk up from an element to the enclosing <tr> inside table.tb. */
  function findRow(el) {
    const tr = el?.closest ? el.closest('tr') : null;
    if (!tr) return null;
    if (!tr.closest('table.tb')) return null;
    return tr;
  }

  // ── Main scan ──────────────────────────────────────────────────────────

  function scanAndColorize() {
    if (!settings.enabled) return;

    // 1. Discover all tag pills on the page
    const hits = findTagElements(document.body);
    if (hits.length === 0) return;

    // 2. Collect unique tags & ensure they have rules
    const discovered = [...new Set(hits.map(h => h.tag))];
    ensureRulesForTags(discovered);

    // 3. Rebuild rule map (may have new entries from ensureRulesForTags)
    const ruleMap = buildRuleMap();

    // 4. Color rows
    const colored = new Set();
    for (const { tag, el } of hits) {
      const rule = ruleMap.get(tag.toLowerCase());
      if (!rule) continue;
      const row = findRow(el);
      if (row && !colored.has(row)) {
        colored.add(row);
        applyColorization(row, rule);
      }
    }
  }

  function debouncedScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAndColorize, 300);
  }

  // ── MutationObserver ───────────────────────────────────────────────────

  function startObserver() {
    if (observer) observer.disconnect();
    const table = document.querySelector('table.tb');
    const root = table || document.body;

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          debouncedScan();
          return;
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    // Also watch body for table replacement
    if (root !== document.body) {
      const bodyOb = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type !== 'childList') continue;
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'TABLE' && node.classList.contains('tb')) {
              debouncedScan(); return;
            }
            if (node.querySelectorAll && node.querySelectorAll('table.tb').length) {
              debouncedScan(); return;
            }
          }
        }
      });
      bodyOb.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Rescan helper (always reloads settings from storage first) ──────────

  async function rescan() {
    await loadSettings();
    removeAllColorization();
    if (settings.enabled) scanAndColorize();
  }

  // ── Message handling ───────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'rescan') {
      rescan().then(() => sendResponse({ ok: true }));
      return true;  // keep channel open for async response
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────

  async function init() {
    await loadSettings();
    if (settings.enabled) {
      scanAndColorize();
      startObserver();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
