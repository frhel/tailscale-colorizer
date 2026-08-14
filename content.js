// ─── Tailscale Tag Colorizer — Content Script ─────────────────────────────
// Injected into console.tailscale.com/admin/machines. Auto-discovers machine tags in the
// admin console and colors rows using a deterministic palette. No hardcoded
// defaults — finds whatever tags are on the page.

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────
  const COLORIZED_ATTR = 'data-ts-colorized';
  const PILL_ATTR       = 'data-ts-pill';

  // 12-colour rotating palette (Tailwind palette, well-spaced)
  const AUTO_PALETTE = [
    '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
    '#e11d48', '#84cc16',
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    sortEnabled: false,
    sortMode: 'frequency',
    rules: [],            // { tag, color, sortable? }[] — populated by discovery
    highlightMode: 'border-left',
    bgOpacity: 0.10,
  };

  // ── State ──────────────────────────────────────────────────────────────
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let scanTimer = null;
  let pendingSave = false;
  let dead = false;
  let busy = false;           // true while we're doing our own DOM work
  let lastScanTime = 0;       // timestamp of last scanAndColorize completion

  // ── Context guard ───────────────────────────────────────────────────────
  // After extension reload/update, chrome.runtime.id becomes undefined.
  // Any chrome.* API call will throw "Extension context invalidated".
  // We detect this once and permanently disable ourselves.

  function isAlive() {
    if (dead) return false;
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        dead = true;
        teardown();
        return false;
      }
      return true;
    } catch (_) {
      dead = true;
      teardown();
      return false;
    }
  }

  function teardown() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(scanTimer);
    removeAllColorization();
  }

  // ── Settings I/O ───────────────────────────────────────────────────────

  async function loadSettings() {
    if (!isAlive()) return;
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
      sortEnabled:   raw.sortEnabled === true,
      sortMode:      raw.sortMode || 'frequency',
      rules:         Array.isArray(raw.rules) ? raw.rules : [],
      highlightMode: raw.highlightMode || 'border-left',
      bgOpacity:     typeof raw.bgOpacity === 'number' ? raw.bgOpacity : 0.10,
    };
  }

  function saveSettings() {
    if (!isAlive()) return;
    if (pendingSave) return;
    pendingSave = true;
    setTimeout(async () => {
      if (!isAlive()) { pendingSave = false; return; }
      try {
        await chrome.storage.local.set({ tsColorizerSettings: settings });
      } catch (_) { /* context lost */ }
      pendingSave = false;
    }, 300);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!isAlive()) return;
    if (area === 'local' && changes.tsColorizerSettings) {
      var wasSortEnabled = settings.sortEnabled;
      settings = changes.tsColorizerSettings.newValue || { ...DEFAULT_SETTINGS };
      removeAllColorization();
      if (settings.enabled) {
        scanAndColorize();
        // Restore original order if user toggled sort off
        if (!settings.sortEnabled && wasSortEnabled) {
          restoreOriginalOrder();
        }
      }
    }
    if (area === 'local' && changes.tsRescanRequest) {
      rescan().catch(function () {});  // context might be dead
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
        settings.rules.push({ tag, color: paletteColor(tag), sortable: true });
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

  // ── Pill-level colorization (per-tag, always applied) ──────────────────

  function colorizePill(pill, rule) {
    if (pill.hasAttribute(PILL_ATTR)) return;
    pill.setAttribute(PILL_ATTR, rule.tag);
    pill.style.setProperty('border-color', rule.color, 'important');
    pill.style.setProperty('border-width', '1px', 'important');
    const { r, g, b } = hexToRgb(rule.color);
    pill.style.setProperty('background-color', `rgba(${r}, ${g}, ${b}, 0.12)`, 'important');
  }

  function uncolorizePill(pill) {
    pill.removeAttribute(PILL_ATTR);
    pill.style.removeProperty('border-color');
    pill.style.removeProperty('border-width');
    pill.style.removeProperty('background-color');
  }

  // ── Row-level colorization (handles single-tag and multi-tag rows) ─────

  function applyRowColorization(row, tags, ruleMap) {
    row.setAttribute(COLORIZED_ATTR, tags.join(','));

    const mode = settings.highlightMode || 'border-left';
    const opacity = settings.bgOpacity || 0.10;

    if (mode === 'border-left' || mode === 'both') {
      // Pre-filter tags that actually have rules so offsets stay clean
      var colors = [];
      for (var i = 0; i < tags.length; i++) {
        var rule = ruleMap.get(tags[i].toLowerCase());
        if (rule) colors.push(rule.color);
      }

      if (colors.length > 0) {
        // Build stacked left-side stripes: 4px colour + 1px black separator between each
        var boxShadow = '';
        var offset = 4;  // first stripe starts 4px from row edge
        for (var i = 0; i < colors.length; i++) {
          boxShadow += (boxShadow ? ', ' : '') + '-' + offset + 'px 0 0 0 ' + colors[i];
          offset += 4;
          if (i < colors.length - 1) {
            // 1px black line between this colour and the next
            boxShadow += ', -' + offset + 'px 0 0 0 #000';
            offset += 1;
          }
        }
        row.style.setProperty('box-shadow', boxShadow, 'important');
        row.style.setProperty('padding-left', offset + 'px', 'important');
      }
    }

    if (mode === 'bg-tint' || mode === 'both') {
      // No border bars, but still need some breathing room from the left edge
      if (mode === 'bg-tint') {
        row.style.setProperty('padding-left', '8px', 'important');
      }
      // Average all tag colours for a blended background tint
      var r = 0, g = 0, b = 0, count = 0;
      for (var i = 0; i < tags.length; i++) {
        var rule = ruleMap.get(tags[i].toLowerCase());
        if (!rule) continue;
        var rgb = hexToRgb(rule.color);
        r += rgb.r; g += rgb.g; b += rgb.b;
        count++;
      }
      if (count > 0) {
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        row.style.setProperty(
          'background-color', `rgba(${r}, ${g}, ${b}, ${opacity})`, 'important'
        );
      }
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  function removeRowColorization(row) {
    row.removeAttribute(COLORIZED_ATTR);
    row.style.removeProperty('border-left');
    row.style.removeProperty('padding-left');
    row.style.removeProperty('background-color');
    row.style.removeProperty('box-shadow');
  }

  function removeAllColorization() {
    document.querySelectorAll(`[${COLORIZED_ATTR}]`).forEach(removeRowColorization);
    document.querySelectorAll(`[${PILL_ATTR}]`).forEach(uncolorizePill);
    document.documentElement.classList.remove('ts-bg-highlight');
  }

  // ── Sorting ─────────────────────────────────────────────────────────────

  /** Snapshot the current DOM row order so we can restore it later. */
  function snapshotRowOrder(tbody) {
    var rows = tbody.querySelectorAll('tr');
    var alreadyDone = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].hasAttribute('data-ts-original-pos')) { alreadyDone = true; break; }
    }
    if (alreadyDone) return;  // only snapshot once
    for (var j = 0; j < rows.length; j++) {
      rows[j].setAttribute('data-ts-original-pos', j);
    }
  }

  /** Restore rows to their snapshot-d original order.
      Rows added after the snapshot (e.g. via observer) fall to the bottom. */
  function restoreOriginalOrder() {
    var tbody = document.querySelector('table.tb tbody');
    if (!tbody) return;
    var rows = Array.from(tbody.querySelectorAll('tr'));
    var hasPos = rows.some(function (r) { return r.hasAttribute('data-ts-original-pos'); });
    if (!hasPos) return;
    // Fallback position for rows added after the snapshot
    var maxPos = rows.length;
    rows.sort(function (a, b) {
      var pa = a.hasAttribute('data-ts-original-pos') ? parseInt(a.getAttribute('data-ts-original-pos')) : maxPos;
      var pb = b.hasAttribute('data-ts-original-pos') ? parseInt(b.getAttribute('data-ts-original-pos')) : maxPos;
      return pa - pb;
    });
    for (var i = 0; i < rows.length; i++) {
      tbody.appendChild(rows[i]);
    }
  }

  /** Sort all rows in table.tb by tag according to settings.sortMode.
      - 'frequency': each machine picks its most-shared sortable tag, then
        rows sort by share-count (desc) → tag name (asc).
      - 'alphabetical': sort by the first sortable tag alphabetically.
      Tags with sortable=false are excluded from sort-key selection.
      Untagged / fully-excluded rows go to the bottom.
      Snapshot-s original order first. */
  function sortRowsByTag() {
    var tbody = document.querySelector('table.tb tbody');
    if (!tbody) return;
    snapshotRowOrder(tbody);
    var rows = Array.from(tbody.querySelectorAll('tr'));
    if (rows.length < 2) return;

    var ruleMap = buildRuleMap();
    var mode = settings.sortMode || 'frequency';

    // ── Pass 1: collect per-row sortable tag sets and frequency ────────────
    var tagFreq = new Map();   // tag → occurrence count (sortable tags only)
    var rowTags = [];          // { row, tags[] } for tagged rows
    var untagged = [];         // rows with no colorized (or all-excluded) tags

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var attr = r.getAttribute(COLORIZED_ATTR);
      if (!attr) { untagged.push(r); continue; }
      var allTags = attr.split(',').map(function (t) { return t.toLowerCase().trim(); });
      // Filter to sortable tags only
      var sortableTags = [];
      for (var j = 0; j < allTags.length; j++) {
        var t = allTags[j];
        var rule = ruleMap.get(t);
        if (rule && rule.sortable !== false) {
          sortableTags.push(t);
          tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
        }
      }
      if (sortableTags.length === 0) {
        untagged.push(r);  // all tags excluded → treat as untagged
      } else {
        rowTags.push({ row: r, tags: sortableTags });
      }
    }

    if (rowTags.length < 2) return;  // nothing to sort

    // ── Pass 2: pick sort key per machine ─────────────────────────────────
    if (mode === 'frequency') {
      // Best grouping tag = highest frequency → tiebreak alphabetical
      for (var k = 0; k < rowTags.length; k++) {
        var entry = rowTags[k];
        var bestTag = entry.tags[0];
        var bestFreq = tagFreq.get(bestTag) || 0;
        for (var m = 1; m < entry.tags.length; m++) {
          var t = entry.tags[m];
          var f = tagFreq.get(t) || 0;
          if (f > bestFreq || (f === bestFreq && t < bestTag)) {
            bestTag = t;
            bestFreq = f;
          }
        }
        entry.sortKey = bestTag;
        entry.sortFreq = bestFreq;
      }
    } else {
      // Alphabetical: first sortable tag is the key
      for (var k = 0; k < rowTags.length; k++) {
        rowTags[k].sortKey = rowTags[k].tags[0];
        rowTags[k].sortFreq = 0; // unused
      }
    }

    // ── Pass 3: sort tagged rows ──────────────────────────────────────────
    if (mode === 'frequency') {
      rowTags.sort(function (a, b) {
        if (a.sortFreq !== b.sortFreq) return b.sortFreq - a.sortFreq;
        if (a.sortKey  !== b.sortKey)  return a.sortKey.localeCompare(b.sortKey);
        return a.tags.join(',').localeCompare(b.tags.join(','));
      });
    } else {
      rowTags.sort(function (a, b) {
        if (a.sortKey !== b.sortKey) return a.sortKey.localeCompare(b.sortKey);
        return a.tags.join(',').localeCompare(b.tags.join(','));
      });
    }

    // ── Pass 4: reorder DOM (tagged first, then untagged) ──────────────────
    for (var n = 0; n < rows.length; n++) { tbody.removeChild(rows[n]); }
    for (var p = 0; p < rowTags.length; p++) { tbody.appendChild(rowTags[p].row); }
    for (var q = 0; q < untagged.length; q++) { tbody.appendChild(untagged[q]); }
  }

  // ── Tag discovery ─────────────────────────────────────────────────────

  function findTagElements(root) {
    // The Tailscale admin console renders tags as:
    //   <div class="...rounded-full...">            ← pill container
    //     <span class="text-text-muted">tag:</span> ← label
    //     <span class="font-medium">tagname</span>  ← value
    //   </div>
    // We find label spans, grab the adjacent value span, and walk up
    // to the pill container for per-pill coloring.
    const results = [];
    const labels = root.querySelectorAll('span.text-text-muted');
    for (const label of labels) {
      const text = label.textContent.trim();
      if (!/^tag:?$/i.test(text)) continue;
      const valueEl = label.nextElementSibling;
      if (!valueEl) continue;
      const val = valueEl.textContent.trim();
      if (!val || val.length > 64) continue;
      // Walk up to the rounded-full pill container
      const pill = label.closest('[class*="rounded-full"]');
      results.push({
        tag: 'tag:' + val.toLowerCase(),
        el: valueEl,
        pill: pill || label.parentElement,  // fallback to direct parent
      });
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
    if (busy) return;                         // already doing our own work
    if (Date.now() - lastScanTime < 1000) return;  // cooldown: max 1 scan/sec

    busy = true;

    // Toggle CSS hook for bg-tint-dependent styles
    const useBg = settings.highlightMode === 'bg-tint' || settings.highlightMode === 'both';
    document.documentElement.classList.toggle('ts-bg-highlight', useBg);

    // 1. Discover all tag pills on the page
    const hits = findTagElements(document.body);
    if (hits.length === 0) { busy = false; return; }

    // 2. Collect unique tags & ensure they have rules
    const discovered = [...new Set(hits.map(function (h) { return h.tag; }))];
    ensureRulesForTags(discovered);

    // 3. Rebuild rule map (may have new entries from ensureRulesForTags)
    const ruleMap = buildRuleMap();

    // 4. Group hits by row so multi-tag machines are handled together
    const rowMap = new Map();  // row -> { tags: Set, pills: [{pill, rule}] }
    for (var i = 0; i < hits.length; i++) {
      var hit = hits[i];
      var rule = ruleMap.get(hit.tag.toLowerCase());
      if (!rule) continue;
      var row = findRow(hit.el);
      if (!row) continue;

      if (!rowMap.has(row)) {
        rowMap.set(row, { tags: new Set(), pills: [] });
      }
      var entry = rowMap.get(row);
      entry.tags.add(rule.tag);
      entry.pills.push({ pill: hit.pill, rule: rule });
    }

    // 5. Apply colorization — pills first, then rows (if mode allows)
    var pillOnly = settings.highlightMode === 'pill-only';
    rowMap.forEach(function (entry, row) {
      // Color each pill individually (pill coloring always visible)
      for (var p = 0; p < entry.pills.length; p++) {
        var pr = entry.pills[p];
        colorizePill(pr.pill, pr.rule);
      }
      // Row coloring: skip in pill-only mode
      if (!pillOnly) {
        var tagsArr = Array.from(entry.tags);
        applyRowColorization(row, tagsArr, ruleMap);
      }
    });

    // 5. Auto-sort if the sort toggle is enabled
    if (settings.sortEnabled) sortRowsByTag();
    busy = false;
    lastScanTime = Date.now();
  }

  function debouncedScan() {
    if (!isAlive()) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      if (isAlive()) scanAndColorize();
    }, 300);
  }

  // ── MutationObserver ───────────────────────────────────────────────────

  function startObserver() {
    if (observer) observer.disconnect();
    const table = document.querySelector('table.tb');
    const root = table || document.body;

    observer = new MutationObserver((mutations) => {
      if (busy) return;  // our own DOM work is in progress — ignore
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
        if (busy) return;
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
    if (!isAlive()) return;
    await loadSettings();
    removeAllColorization();
    if (settings.enabled) scanAndColorize();
  }

  // ── Message handling ───────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isAlive()) return;
    if (msg.action === 'rescan') {
      rescan().then(() => sendResponse({ ok: true }));
      return true;  // keep channel open for async response
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────

  // ── Injected styles ─────────────────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'ts-colorizer-styles';
    style.textContent = `
      table.tb tbody tr {
        border-bottom: 1px solid #000 !important;
      }

      /* Update-link SVGs need to be white on dark background tints */
      html.ts-bg-highlight table.tb a[href*="/update/"] svg {
        color: #fff !important;
      }
    `;
    document.head.appendChild(style);
  }

  async function init() {
    if (!isAlive()) return;
    injectStyles();
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
