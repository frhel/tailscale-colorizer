// ─── Tailscale Tag Colorizer — Popup ──────────────────────────────────────
// Dead-simple UI. Reads tag rules from chrome.storage.local, shows them
// with color pickers and delete buttons. Content script does all the work.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ── State ──────────────────────────────────────────────────────────────
  let rules = [];               // [{ tag, color }]
  let enabled = true;
  let highlightMode = 'border-left';
  let bgOpacity = 0.10;
  let saveTimer = null;

  // ── Safe storage wrapper ───────────────────────────────────────────────
  // Guards against chrome.storage being undefined in corrupted browser states.

  const storage = {
    get available() {
      return !!(chrome && chrome.storage && chrome.storage.local);
    },
    async get(keys) {
      if (!this.available) throw new Error('chrome.storage unavailable');
      return chrome.storage.local.get(keys);
    },
    set(obj) {
      if (!this.available) return;
      chrome.storage.local.set(obj);
    }
  };

  // ── Settings I/O ───────────────────────────────────────────────────────

  async function loadSettings() {
    let raw;
    try {
      raw = (await storage.get('tsColorizerSettings')).tsColorizerSettings;
    } catch (_) { raw = null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

    rules         = Array.isArray(raw.rules) ? raw.rules : [];
    enabled       = raw.enabled !== false;
    highlightMode = raw.highlightMode || 'border-left';
    bgOpacity     = typeof raw.bgOpacity === 'number' ? raw.bgOpacity : 0.10;
  }

  function saveSettingsNow() {
    clearTimeout(saveTimer);
    try {
      storage.set({ tsColorizerSettings: { enabled, rules, highlightMode, bgOpacity } });
    } catch (_) { /* storage gone — nothing we can do */ }
  }

  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettingsNow, 300);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function render() {
    const toggle = $('enabledToggle');
    const label  = $('toggleLabel');
    const mode   = $('highlightMode');
    const slider = $('bgOpacity');
    const val    = $('opacityValue');
    const list   = $('rulesList');
    const empty  = $('emptyState');

    if (toggle) toggle.checked = enabled;
    if (label)  label.textContent = enabled ? 'Enabled' : 'Disabled';
    if (mode)   mode.value = highlightMode;
    const pct = Math.round(bgOpacity * 100);
    if (slider) slider.value = pct;
    if (val)    val.textContent = pct + '%';

    if (list) list.innerHTML = '';

    if (!rules.length) {
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      rules.forEach(function (rule, idx) {
        if (list) list.appendChild(buildRow(rule, idx));
      });
    }
  }

  function buildRow(rule, idx) {
    var d = document.createElement('div');
    d.className = 'rule-row';

    var swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = rule.color || '#888';
    swatch.title = 'Click to change color';

    var input = document.createElement('input');
    input.type = 'color';
    input.className = 'color-input';
    input.value = rule.color || '#888888';

    // Clicking the swatch opens the native color picker
    swatch.onclick = function () { input.click(); };

    // Live swatch preview while dragging the picker (no save)
    input.oninput = function () {
      swatch.style.backgroundColor = input.value;
    };

    // Only save + broadcast when the user confirms the color
    input.onchange = function () {
      rule.color = input.value;
      swatch.style.backgroundColor = input.value;
      saveSettingsNow();
      broadcast();
    };

    var tagWrap = document.createElement('div');
    tagWrap.className = 'rule-tag';
    var tagSpan = document.createElement('span');
    tagSpan.className = 'rule-tag-text';
    tagSpan.textContent = rule.tag || 'tag:name';
    tagWrap.appendChild(tagSpan);

    var del = document.createElement('button');
    del.className = 'rule-delete';
    del.innerHTML = '&#10005;';
    del.title = 'Remove rule';
    del.onclick = function () {
      rules.splice(idx, 1);
      saveSettingsNow();
      render();
      broadcast();
    };

    d.appendChild(swatch);
    d.appendChild(input);
    d.appendChild(tagWrap);
    d.appendChild(del);
    return d;
  }

  // ── Retry helper ────────────────────────────────────────────────────────

  function retry(fn, label, maxTries) {
    maxTries = maxTries || 3;
    return new Promise(function (resolve, reject) {
      var attempt = 0;
      function go() {
        attempt++;
        fn().then(resolve).catch(function (err) {
          if (attempt >= maxTries) { reject(err); return; }
          setTimeout(go, 200 * attempt);
        });
      }
      go();
    });
  }

  // ── Broadcast rescan to content script ──────────────────────────────────

  async function broadcast() {
    try {
      var tabs = await chrome.tabs.query({ url: 'https://login.tailscale.com/*' });
      for (var i = 0; i < tabs.length; i++) {
        chrome.tabs.sendMessage(tabs[i].id, { action: 'rescan' }).catch(function () {});
      }
      if (tabs.length === 0) {
        // No tabs open — signal through storage so content script picks it up later
        try { storage.set({ tsRescanRequest: Date.now() }); } catch (_) {}
      }
    } catch (_) {
      // tabs permission missing or API down — signal via storage + service worker
      try { storage.set({ tsRescanRequest: Date.now() }); } catch (_) {}
      try { chrome.runtime.sendMessage({ action: 'rescan' }).catch(function () {}); } catch (_) {}
    }
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  function wire() {
    var t = $('enabledToggle');
    if (t) t.onchange = function () {
      enabled = t.checked;
      if ($('toggleLabel')) $('toggleLabel').textContent = enabled ? 'Enabled' : 'Disabled';
      saveSettingsNow();
      broadcast();
    };

    var m = $('highlightMode');
    if (m) m.onchange = function () {
      highlightMode = m.value;
      saveSettingsNow();
      broadcast();
    };

    var s = $('bgOpacity');
    if (s) s.oninput = function () {
      bgOpacity = parseInt(s.value) / 100;
      if ($('opacityValue')) $('opacityValue').textContent = s.value + '%';
      saveSettings();
      broadcast();
    };

    var add = $('addRuleBtn');
    if (add) add.onclick = function () {
      var tag = prompt('Enter a tag (e.g. tag:mything):');
      if (tag && tag.trim()) {
        rules.push({ tag: tag.trim(), color: '#7c8aff' });
        saveSettingsNow();
        render();
        broadcast();
      }
    };

    var scan = $('scanBtn');
    if (scan) scan.onclick = function () {
      broadcast().then(function () {
        scan.textContent = 'Scanning...';
        setTimeout(async function () {
          await loadSettings();
          render();
          scan.textContent = 'Scan now';
        }, 1200);
      });
    };

    var reset = $('resetBtn');
    if (reset) reset.onclick = function () {
      if (!rules.length) return;
      if (!confirm('Clear all rules? This cannot be undone.')) return;
      rules = [];
      saveSettingsNow();
      render();
      broadcast();
    };

    var sort = $('sortBtn');
    if (sort) sort.onclick = function () {
      try {
        chrome.tabs.query({ url: 'https://login.tailscale.com/*' }, function (tabs) {
          for (var i = 0; i < tabs.length; i++) {
            chrome.tabs.sendMessage(tabs[i].id, { action: 'sort' }).catch(function () {});
          }
        });
      } catch (_) {
        try { chrome.runtime.sendMessage({ action: 'sort' }).catch(function () {}); } catch (_) {}
      }
    };
  }

  // ── Fallback UI ─────────────────────────────────────────────────────────
  // Rendered if init fails after retries so the popup is never silently blank.

  function showFallback(message) {
    try {
      document.body.innerHTML =
        '<div style="padding:32px 16px;text-align:center;color:#9090a0;font-family:sans-serif;font-size:13px;">'
        + '<p style="margin-bottom:12px;font-size:16px;font-weight:600;color:#e0e0f0;">Something went wrong</p>'
        + '<p style="margin-bottom:16px;">' + (message || 'The popup could not be loaded.') + '</p>'
        + '<button id="retryFallback" style="padding:8px 16px;background:#7c8aff;color:#fff;border:none;border-radius:6px;cursor:pointer;">Retry</button>'
        + '</div>';
      var btn = document.getElementById('retryFallback');
      if (btn) btn.onclick = function () { location.reload(); };
    } catch (_) {}
  }

  // ── Storage change listener ────────────────────────────────────────────

  try {
    if (storage.available) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.tsColorizerSettings) {
          loadSettings().then(render).catch(function () {});
        }
      });
    }
  } catch (_) {}

  // ── Init ───────────────────────────────────────────────────────────────

  retry(function () {
    return loadSettings().then(function () {
      wire();
      render();
    });
  }, 'popup-init').catch(function (e) {
    console.error('Popup init failed after retries:', e);
    showFallback('Restart your browser or reinstall the extension if this persists.');
  });

})();
