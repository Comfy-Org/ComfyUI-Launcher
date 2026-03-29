/**
 * Returns a self-contained JavaScript string to be injected into ComfyUI
 * webview pages via webContents.executeJavaScript().
 *
 * The script intercepts model downloads triggered by the "Missing Models"
 * dialog or the right side panel Errors tab and routes them through the
 * Launcher's download manager (exposed as window.__comfyDesktop2 by
 * comfyPreload.ts) so that model files land in the correct shared-models
 * subdirectory.
 *
 * It supports the legacy dialog (PrimeVue Listbox with class
 * "comfy-missing-models"), the newer redesigned dialog, and the right side
 * panel's Missing Models error section.
 */
export function getModelDownloadContentScript(): string {
  return `(function() {
  'use strict';
  if (window.__comfyDesktop2Injected || typeof window.__comfyDesktop2 === 'undefined') return;
  window.__comfyDesktop2Injected = true;

  // Inject scrollbar styles for the download card list
  var dlStyle = document.createElement('style');
  dlStyle.textContent = '#__comfy-dl-cardlist{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.15) transparent;}#__comfy-dl-cardlist::-webkit-scrollbar{width:6px;}#__comfy-dl-cardlist::-webkit-scrollbar-track{background:transparent;}#__comfy-dl-cardlist::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:3px;}#__comfy-dl-cardlist::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.25);}';
  document.head.appendChild(dlStyle);

  var modelCache = {};
  var modelNameCache = {};

  // ---- Badge-text → directory reverse map (new dialog) ----
  var BADGE_TO_DIR = {
    'VAE': 'vae',
    'DIFFUSION': 'diffusion_models',
    'TEXT ENCODER': 'text_encoders',
    'LORA': 'loras',
    'CHECKPOINT': 'checkpoints'
  };

  function reverseBadge(text) {
    return BADGE_TO_DIR[text] || text.toLowerCase().replace(/\\s+/g, '_');
  }

  // ---- Scrape the legacy dialog (.comfy-missing-models) ----
  function scrapeLegacyDialog() {
    var items = document.querySelectorAll('.comfy-missing-models .p-listbox-option');
    for (var i = 0; i < items.length; i++) {
      var span = items[i].querySelector('span[title]');
      if (!span) continue;
      var url = span.getAttribute('title');
      if (!url || url.indexOf('http') !== 0) continue;
      var text = span.textContent.trim();
      var sep = text.indexOf(' / ');
      if (sep === -1) continue;
      var directory = text.substring(0, sep).trim();
      modelCache[url] = directory;
    }
  }

  // ---- Scrape the redesigned dialog (badge-based) ----
  function scrapeNewDialog() {
    var dialog = document.querySelector(
      '[aria-labelledby="global-missing-models-warning"]'
    );
    if (!dialog) return;

    // Strategy 1: per-model buttons with URL in title (older frontend versions)
    var buttons = dialog.querySelectorAll('button[title]');
    for (var i = 0; i < buttons.length; i++) {
      var url = buttons[i].getAttribute('title');
      if (!url || url.indexOf('http') !== 0) continue;
      if (modelCache[url]) continue;
      var row =
        buttons[i].closest('[class*="justify-between"]') ||
        buttons[i].closest('[class*="items-center"]');
      if (!row) continue;
      var badge = row.querySelector('[class*="rounded-full"]');
      if (badge) {
        modelCache[url] = reverseBadge(badge.textContent.trim());
      }
    }

    // Strategy 2: model name spans paired with badges (newer frontend versions
    // that may only have a "Download all" button instead of per-model buttons)
    var rows = dialog.querySelectorAll('[class*="justify-between"]');
    for (var r = 0; r < rows.length; r++) {
      var nameSpan = rows[r].querySelector('span[title]');
      var badge2 = rows[r].querySelector('[class*="rounded-full"]');
      if (!nameSpan || !badge2) continue;
      var name = nameSpan.getAttribute('title');
      if (!name) continue;
      var dir = reverseBadge(badge2.textContent.trim().toUpperCase());
      if (dir) {
        modelNameCache[name] = dir;
      }
    }
  }

  // ---- Scrape the right side panel Errors tab (Missing Models section) ----
  function scrapeErrorsTab() {
    var panel = document.querySelector('[data-testid="properties-panel"]');
    if (!panel) return;

    // Find category containers: each holds a directory header + model rows.
    // MissingModelCard.vue renders these with a distinctive class set.
    var categories = panel.querySelectorAll(
      '.flex.w-full.flex-col.border-t.border-interface-stroke.py-2,' +
      '.flex.w-full.flex-col.border-t.border-interface-stroke.py-2.first\\\\:border-t-0'
    );
    // Fallback: also match first category which has first:border-t-0 first:pt-0
    if (categories.length === 0) {
      categories = panel.querySelectorAll(
        '[class*="flex"][class*="w-full"][class*="flex-col"][class*="border-t"][class*="py-2"]'
      );
    }

    for (var c = 0; c < categories.length; c++) {
      var cat = categories[c];
      // Extract directory name from the category header span
      // e.g. "clip_vision (1)" → "clip_vision"
      var headerSpan = cat.querySelector('p[class*="text-destructive-background-hover"] span');
      if (!headerSpan) continue;
      var headerText = headerSpan.textContent.trim();
      // Strip the trailing count e.g. " (1)" or " (3)"
      var dirMatch = headerText.match(/^(.+?)\\s*\\(\\d+\\)\\s*$/);
      var directory = dirMatch ? dirMatch[1].trim() : headerText;
      if (!directory) continue;

      // Find all model name elements within this category
      var modelNames = cat.querySelectorAll('p[title][class*="text-foreground"]');
      for (var m = 0; m < modelNames.length; m++) {
        var name = modelNames[m].getAttribute('title');
        if (name && !modelNameCache[name]) {
          modelNameCache[name] = directory;
        }
      }
    }
  }

  var dialogWasOpen = false;
  var errorsTabWasOpen = false;

  function updateMissingModelsCache() {
    var legacyOpen = !!document.querySelector('.comfy-missing-models');
    var newOpen = !!document.querySelector('[aria-labelledby="global-missing-models-warning"]');
    var isOpen = legacyOpen || newOpen;

    // Check if the right side panel Errors tab has missing models
    var panel = document.querySelector('[data-testid="properties-panel"]');
    var errorsTabOpen = false;
    if (panel) {
      // The Missing Models section title contains "Missing Models" in a
      // span with the destructive-background-hover style, but we need a
      // more specific check: look for a download button with aria-label
      // starting with "Download " inside the panel, which only appears in
      // the missing models section.
      var downloadBtns = panel.querySelectorAll('button[aria-label^="Download "]');
      errorsTabOpen = downloadBtns.length > 0;
    }

    if (isOpen) {
      dialogWasOpen = true;
      if (legacyOpen) scrapeLegacyDialog();
      scrapeNewDialog();
    } else if (dialogWasOpen) {
      // Dialog just closed — clear dialog-sourced cache entries
      dialogWasOpen = false;
      modelCache = {};
      // Only clear modelNameCache if errors tab is also not providing data
      if (!errorsTabOpen) {
        modelNameCache = {};
      }
    }

    if (errorsTabOpen) {
      errorsTabWasOpen = true;
      scrapeErrorsTab();
    } else if (errorsTabWasOpen) {
      errorsTabWasOpen = false;
      // Only clear modelNameCache if dialog is also not providing data
      if (!dialogWasOpen) {
        modelNameCache = {};
      }
    }
  }

  // ---- MutationObserver: populate cache when the dialog or errors tab appears ----
  function startObserver() {
    var target = document.body || document.documentElement;
    var observer = new MutationObserver(function() { updateMissingModelsCache(); });
    observer.observe(target, { childList: true, subtree: true });
  }

  // Only observe missing models UI and intercept downloads for local sessions
  if (!window.__comfyDesktop2Remote) {
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener('DOMContentLoaded', startObserver);
    }
  }

  // ---- Override document.createElement to intercept <a>.click() ----
  // For remote/cloud sessions model downloads should not be captured (no local models dir).
  var origCreate = document.createElement.bind(document);
  if (!window.__comfyDesktop2Remote) {
    document.createElement = function(tag, options) {
      var el = origCreate(tag, options);
      if (typeof tag === 'string' && tag.toLowerCase() === 'a' &&
          (Object.keys(modelCache).length > 0 || Object.keys(modelNameCache).length > 0)) {
        var origClick = el.click;
        el.click = function() {
          if (this.download && this.href && window.__comfyDesktop2) {
            var cleanName = this.download.split('?')[0];
            var directory = modelCache[this.href] || modelNameCache[cleanName];
            if (directory) {
              window.__comfyDesktop2.downloadModel(
                this.href,
                cleanName,
                directory
              ).catch(function() {});
              return;
            }
          }
          return origClick.call(this);
        };
      }
      return el;
    };
  }

  // ---- Auto-download outputs for remote/cloud sessions ----
  // Intercept WebSocket messages to detect completed workflow outputs.
  // For cloud sessions, fetch files with page credentials (Bearer auth) and
  // send the blob to the main process.  For plain remote sessions, pass the
  // URL so Electron can download it directly (session cookies suffice).
  if (window.__comfyDesktop2Remote && window.__comfyDesktop2 && window.__comfyDesktop2.downloadAsset) {
    var _useBlobDownload = !!window.__comfyDesktop2.downloadAssetBlob;

    function _buildViewUrl(baseUrl, item) {
      var params = 'filename=' + encodeURIComponent(item.filename);
      if (item.subfolder) params += '&subfolder=' + encodeURIComponent(item.subfolder);
      if (item.type) params += '&type=' + encodeURIComponent(item.type);
      return baseUrl + '/api/view?' + params;
    }

    function _parseContentDispositionFilename(header) {
      if (!header) return null;
      // Try filename*= (RFC 5987 encoded)
      var starMatch = header.match(/filename\\*\\s*=\\s*(?:UTF-8''|utf-8'')([^;\\s]+)/i);
      if (starMatch) {
        try { return decodeURIComponent(starMatch[1]); } catch(e) {}
      }
      // Try filename="..." or filename=...
      var match = header.match(/filename\\s*=\\s*"([^"]+)"/i) || header.match(/filename\\s*=\\s*([^;\\s]+)/i);
      return match ? match[1] : null;
    }

    function _downloadItem(baseUrl, authToken, item) {
      if (!item || !item.filename) return;
      // Skip temporary preview outputs (PreviewImage, etc.)
      if (item.type === 'temp') return;
      // Prefer display_name from the executed message (human-readable name)
      var preferredName = item.display_name || null;
      var viewUrl = _buildViewUrl(baseUrl, item);
      if (_useBlobDownload) {
        // Cloud path: fetch with auth token, send blob to main process.
        // Use same-origin credentials (default) — cloud redirects to a
        // pre-signed GCS URL that rejects credentials: 'include'.
        var fetchOpts = {};
        if (authToken) {
          fetchOpts.headers = { 'Authorization': 'Bearer ' + authToken };
        }
        fetch(viewUrl, fetchOpts)
          .then(function(res) {
            if (!res.ok) return null;
            // Extract real filename from Content-Disposition header if available
            if (!preferredName) {
              var cd = res.headers.get('content-disposition');
              preferredName = _parseContentDispositionFilename(cd);
            }
            // Also try the redirected URL's response-content-disposition param
            if (!preferredName) {
              try {
                var rUrl = new URL(res.url);
                var rcd = rUrl.searchParams.get('response-content-disposition');
                preferredName = _parseContentDispositionFilename(rcd);
              } catch(e) {}
            }
            return res.arrayBuffer();
          })
          .then(function(buf) {
            var saveName = preferredName || item.filename;
            if (buf) window.__comfyDesktop2.downloadAssetBlob(saveName, buf).catch(function() {});
          })
          .catch(function() {});
      } else {
        var saveName = preferredName || item.filename;
        window.__comfyDesktop2.downloadAsset(viewUrl, saveName).catch(function() {});
      }
    }

    var OrigWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      var ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      var wsUrl = typeof url === 'string' ? url : url.toString();
      var httpBase = wsUrl.replace(/^ws(s?):/, 'http$1:').replace(/\\/ws(\\?.*)?$/, '');
      // Extract auth token from WebSocket URL query params (cloud passes ?token=...)
      var _authToken = null;
      try {
        var urlObj = new URL(wsUrl);
        _authToken = urlObj.searchParams.get('token');
      } catch(e) {}

      ws.addEventListener('message', function(event) {
        if (typeof event.data !== 'string') return;
        try {
          var msg = JSON.parse(event.data);
          if (msg.type !== 'executed' || !msg.data || !msg.data.output) return;
          var output = msg.data.output;
          // Process all known output arrays: images, gifs, audio, video
          var keys = ['images', 'gifs', 'audio', 'video'];
          for (var k = 0; k < keys.length; k++) {
            var items = output[keys[k]];
            if (!items || !items.length) continue;
            for (var i = 0; i < items.length; i++) {
              _downloadItem(httpBase, _authToken, items[i]);
            }
          }
        } catch(e) {}
      });

      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  }

  // ---- Theme integration ----
  // Read ComfyUI's CSS variables and derive toast colors
  var theme = {
    panelBg: 'rgba(16,16,18,0.95)',
    cardBg: 'rgba(24,24,27,0.96)',
    borderColor: 'rgba(255,255,255,0.08)',
    textPrimary: '#e4e4e7',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
    trackBg: 'rgba(255,255,255,0.08)',
    btnBorder: 'rgba(255,255,255,0.1)',
    btnBorderHover: 'rgba(255,255,255,0.25)',
    scrollThumb: 'rgba(255,255,255,0.15)',
    scrollThumbHover: 'rgba(255,255,255,0.25)',
    isLight: false
  };

  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    var menuBg = cs.getPropertyValue('--comfy-menu-bg').trim();
    var fgColor = cs.getPropertyValue('--fg-color').trim();
    var borderCol = cs.getPropertyValue('--border-color').trim();
    var descText = cs.getPropertyValue('--descrip-text').trim();
    var inputText = cs.getPropertyValue('--input-text').trim();
    var bodyDark = document.body.classList.contains('dark-theme');

    if (!menuBg) return;

    // Detect light vs dark theme
    var light = false;
    if (!bodyDark && fgColor) {
      // Parse fg-color to check luminance; dark fg = light theme
      var tmp = origCreate('div');
      tmp.style.color = fgColor;
      document.body.appendChild(tmp);
      var parsed = getComputedStyle(tmp).color;
      document.body.removeChild(tmp);
      var m = parsed.match(/\\d+/g);
      if (m && m.length >= 3) {
        var lum = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
        light = lum < 140;
      }
    }
    theme.isLight = light;

    theme.panelBg = menuBg;
    theme.textPrimary = fgColor || theme.textPrimary;
    theme.textSecondary = descText || theme.textSecondary;
    theme.textMuted = descText || theme.textMuted;
    theme.borderColor = borderCol ? borderCol : (light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)');

    // Derive card background slightly lighter/darker than panel
    var cardTmp = origCreate('div');
    cardTmp.style.color = menuBg;
    document.body.appendChild(cardTmp);
    var parsedBg = getComputedStyle(cardTmp).color;
    document.body.removeChild(cardTmp);
    var bgm = parsedBg.match(/\\d+/g);
    if (bgm && bgm.length >= 3) {
      var r = parseInt(bgm[0]), g = parseInt(bgm[1]), b = parseInt(bgm[2]);
      if (light) {
        theme.cardBg = 'rgb(' + Math.max(0, r - 8) + ',' + Math.max(0, g - 8) + ',' + Math.max(0, b - 8) + ')';
      } else {
        theme.cardBg = 'rgb(' + Math.min(255, r + 10) + ',' + Math.min(255, g + 10) + ',' + Math.min(255, b + 10) + ')';
      }
    }

    theme.trackBg = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    theme.btnBorder = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)';
    theme.btnBorderHover = light ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)';
    theme.scrollThumb = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)';
    theme.scrollThumbHover = light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)';
  }

  function applyTheme() {
    readTheme();
    // Update scrollbar styles
    if (dlStyle) {
      dlStyle.textContent = '#__comfy-dl-cardlist{scrollbar-width:thin;scrollbar-color:' + theme.scrollThumb + ' transparent;}#__comfy-dl-cardlist::-webkit-scrollbar{width:6px;}#__comfy-dl-cardlist::-webkit-scrollbar-track{background:transparent;}#__comfy-dl-cardlist::-webkit-scrollbar-thumb{background:' + theme.scrollThumb + ';border-radius:3px;}#__comfy-dl-cardlist::-webkit-scrollbar-thumb:hover{background:' + theme.scrollThumbHover + ';}';
    }
    // Update existing elements
    if (dlTab) {
      dlTab.style.background = theme.panelBg;
      dlTab.style.borderColor = theme.borderColor;
      var tabLabel = dlTab.querySelector('#__comfy-dl-tab-label');
      if (tabLabel) tabLabel.style.color = theme.textSecondary;
      var tabBarBg = dlTab.querySelector('#__comfy-dl-tab-bar');
      if (tabBarBg && tabBarBg.parentNode) tabBarBg.parentNode.style.background = theme.trackBg;
    }
    if (dlContainer) {
      var hdr = dlContainer.querySelector('div');
      if (hdr) {
        hdr.style.background = theme.panelBg;
        hdr.style.borderColor = theme.borderColor;
      }
      var cardListEl = dlContainer.querySelector('#__comfy-dl-cardlist');
      if (cardListEl) cardListEl.style.background = theme.cardBg;
      var cards = dlContainer.querySelectorAll('#__comfy-dl-cardlist > div');
      for (var i = 0; i < cards.length; i++) {
        cards[i].style.background = theme.cardBg;
        cards[i].style.borderColor = theme.borderColor;
        cards[i].style.color = theme.textPrimary;
      }
    }
    // Update brand label and close button
    if (dlContainer) {
      var spans = dlContainer.querySelectorAll('span');
      for (var s = 0; s < spans.length; s++) {
        var sp = spans[s];
        if (sp.textContent === 'ComfyUI Desktop 2.0') sp.style.color = theme.textSecondary;
      }
      var closeButtons = dlContainer.querySelectorAll('button[title="Close"]');
      for (var c = 0; c < closeButtons.length; c++) {
        closeButtons[c].style.color = theme.textMuted;
      }
    }
  }

  // Watch for theme changes on document.documentElement
  var themeObserver = new MutationObserver(function() { applyTheme(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  themeObserver.observe(document.body || document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // Initial theme read (deferred to let ComfyUI finish loading)
  setTimeout(function() { applyTheme(); }, 1000);

  // ---- Download progress toast UI ----
  var dlCards = {};
  var dlContainer = null;
  var dlTab = null;
  var dlPanelOpen = false;
  var dragState = null;
  var isDocked = true;
  var dockZone = null;
  var DOCK_LEFT = 62;
  var DOCK_BOTTOM = 4;
  var DOCK_SNAP_DIST = 80;
  var tabFadeTimer = null;

  // ---- Persistent tab (bottom-left, visible when panel is closed) ----
  function ensureTab() {
    if (dlTab && document.body.contains(dlTab)) return dlTab;
    dlTab = origCreate('div');
    dlTab.id = '__comfy-dl-tab';
    dlTab.style.cssText = 'position:fixed;bottom:-4px;left:' + DOCK_LEFT + 'px;z-index:99999;background:' + theme.panelBg + ';border:1px solid ' + theme.borderColor + ';border-bottom:none;border-radius:6px 6px 0 0;padding:4px 12px 8px 12px;cursor:pointer;user-select:none;transition:transform 0.15s ease,opacity 0.5s ease;transform:translateY(0);opacity:1;pointer-events:auto;';
    dlTab.onmouseenter = function() { dlTab.style.transform = 'translateY(-4px)'; };
    dlTab.onmouseleave = function() { dlTab.style.transform = 'translateY(0)'; };
    dlTab.onclick = function() { showPanel(); };

    var tabTop = origCreate('div');
    tabTop.style.cssText = 'display:flex;align-items:center;gap:4px;';

    var tabIcon = origCreate('span');
    tabIcon.id = '__comfy-dl-tab-icon';
    tabIcon.textContent = '\\u2193 ';
    tabIcon.style.cssText = 'color:#3b82f6;font-size:12px;';

    var tabLabel = origCreate('span');
    tabLabel.id = '__comfy-dl-tab-label';
    tabLabel.textContent = 'Downloads';
    tabLabel.style.cssText = "color:" + theme.textSecondary + ";font-size:11px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    tabTop.appendChild(tabIcon);
    tabTop.appendChild(tabLabel);

    var tabBarBg = origCreate('div');
    tabBarBg.style.cssText = 'height:2px;background:' + theme.trackBg + ';border-radius:1px;overflow:hidden;margin-top:3px;';
    var tabBarFill = origCreate('div');
    tabBarFill.id = '__comfy-dl-tab-bar';
    tabBarFill.style.cssText = 'height:100%;width:0%;border-radius:1px;background:#3b82f6;transition:width 0.3s ease;';
    tabBarBg.appendChild(tabBarFill);

    dlTab.appendChild(tabTop);
    dlTab.appendChild(tabBarBg);
    document.body.appendChild(dlTab);
    return dlTab;
  }

  function updateTabProgress() {
    if (!dlTab) return;
    var label = dlTab.querySelector('#__comfy-dl-tab-label');
    var bar = dlTab.querySelector('#__comfy-dl-tab-bar');
    var icon = dlTab.querySelector('#__comfy-dl-tab-icon');
    if (!label || !bar) return;

    var keys = Object.keys(dlCards);
    var activeCount = 0;
    var totalProgress = 0;
    for (var i = 0; i < keys.length; i++) {
      var entry = dlCards[keys[i]];
      var s = entry.status;
      if (s === 'downloading' || s === 'pending' || s === 'paused') {
        activeCount++;
        totalProgress += parseFloat(entry.barFill.style.width) || 0;
      }
    }

    if (activeCount === 0) {
      var hasFinished = keys.length > 0;
      if (hasFinished) {
        label.textContent = 'Complete';
        bar.style.width = '100%';
        bar.style.background = '#3b82f6';
        if (icon) { icon.textContent = '\\u2713 '; icon.style.color = '#3b82f6'; }
      } else {
        label.textContent = 'Downloads';
        bar.style.width = '0%';
        bar.style.background = '#3b82f6';
        if (icon) { icon.textContent = '\\u2193 '; icon.style.color = '#3b82f6'; }
      }
      // Fade out the tab after a short delay when no downloads are active
      if (!dlPanelOpen && dlTab && !tabFadeTimer) {
        tabFadeTimer = setTimeout(function() {
          if (dlTab) {
            dlTab.style.opacity = '0';
            dlTab.style.pointerEvents = 'none';
            setTimeout(function() {
              if (dlTab) { dlTab.style.display = 'none'; }
              tabFadeTimer = null;
            }, 500);
          } else {
            tabFadeTimer = null;
          }
        }, 2000);
      }
    } else {
      // Cancel any pending fade if new active downloads appear
      if (tabFadeTimer) { clearTimeout(tabFadeTimer); tabFadeTimer = null; }
      if (dlTab) { dlTab.style.opacity = '1'; dlTab.style.pointerEvents = 'auto'; }
      if (icon) { icon.textContent = '\\u2193 '; icon.style.color = '#3b82f6'; }
      var avgPct = Math.round(totalProgress / activeCount);
      label.textContent = activeCount + ' download' + (activeCount > 1 ? 's' : '') + ' \\u00b7 ' + avgPct + '%';
      bar.style.width = avgPct + '%';
      bar.style.background = '#3b82f6';
    }
  }

  function showPanel() {
    dlPanelOpen = true;
    if (dlContainer) dlContainer.style.display = '';
    if (dlTab) dlTab.style.display = 'none';
  }

  function hidePanel() {
    dlPanelOpen = false;
    if (tabFadeTimer) { clearTimeout(tabFadeTimer); tabFadeTimer = null; }
    if (dlContainer) dlContainer.style.display = 'none';
    var tab = ensureTab();
    tab.style.display = '';
    tab.style.opacity = '1';
    tab.style.pointerEvents = 'auto';
    tab.style.transform = 'translateY(0)';
  }

  // ---- Dock / undock helpers ----
  function applyDockedPosition() {
    if (!dlContainer) return;
    dlContainer.style.left = DOCK_LEFT + 'px';
    dlContainer.style.bottom = DOCK_BOTTOM + 'px';
    dlContainer.style.top = 'auto';
    dlContainer.style.right = 'auto';
  }

  function applyUndockedPosition(left, top) {
    if (!dlContainer) return;
    var maxLeft = Math.max(0, window.innerWidth - 100);
    var maxTop = Math.max(0, window.innerHeight - 40);
    dlContainer.style.left = Math.max(0, Math.min(maxLeft, left)) + 'px';
    dlContainer.style.top = Math.max(0, Math.min(maxTop, top)) + 'px';
    dlContainer.style.bottom = 'auto';
    dlContainer.style.right = 'auto';
  }

  function saveDockState() {
    try {
      if (isDocked) {
        localStorage.setItem('__comfy-dl-pos', JSON.stringify({ docked: true }));
      } else {
        localStorage.setItem('__comfy-dl-pos', JSON.stringify({
          docked: false,
          left: parseInt(dlContainer.style.left),
          top: parseInt(dlContainer.style.top)
        }));
      }
    } catch(e) {}
  }

  function isInDockZone(x, y) {
    // Rectangle hit test matching the visible dock zone (280x60) with padding
    var pad = 30;
    var zoneLeft = DOCK_LEFT - pad;
    var zoneRight = DOCK_LEFT + 280 + pad;
    var zoneTop = window.innerHeight - 60 - pad;
    var zoneBottom = window.innerHeight + pad;
    return x >= zoneLeft && x <= zoneRight && y >= zoneTop && y <= zoneBottom;
  }

  // ---- Dock zone highlight ----
  function ensureDockZone() {
    if (dockZone && document.body.contains(dockZone)) return dockZone;
    dockZone = origCreate('div');
    dockZone.id = '__comfy-dl-dock';
    dockZone.style.cssText = 'position:fixed;bottom:0;left:' + DOCK_LEFT + 'px;width:280px;height:60px;z-index:99998;border:2px dashed rgba(59,130,246,0.5);border-radius:8px;background:rgba(59,130,246,0.08);display:none;pointer-events:none;transition:opacity 0.15s ease;';
    document.body.appendChild(dockZone);
    return dockZone;
  }

  function showDockZone(highlight) {
    var zone = ensureDockZone();
    zone.style.display = '';
    zone.style.borderColor = highlight ? 'rgba(59,130,246,0.9)' : 'rgba(59,130,246,0.4)';
    zone.style.background = highlight ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.06)';
  }

  function hideDockZone() {
    if (dockZone) dockZone.style.display = 'none';
  }

  function getDlContainer() {
    if (dlContainer && document.body.contains(dlContainer)) return dlContainer;
    dlContainer = origCreate('div');
    dlContainer.id = '__comfy-dl-toasts';
    dlContainer.style.cssText = "position:fixed;z-index:99999;display:flex;flex-direction:column;gap:0;max-width:340px;min-width:280px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;";

    // Restore saved position or default to docked
    try {
      var pos = JSON.parse(localStorage.getItem('__comfy-dl-pos') || '{}');
      if (pos.docked === false && pos.left != null && pos.top != null) {
        isDocked = false;
        applyUndockedPosition(pos.left, pos.top);
      } else {
        isDocked = true;
        applyDockedPosition();
      }
    } catch(e) {
      isDocked = true;
      applyDockedPosition();
    }

    // Header bar
    var header = origCreate('div');
    header.style.cssText = 'display:flex;align-items:center;padding:6px 10px;background:' + theme.panelBg + ';border:1px solid ' + theme.borderColor + ';border-bottom:none;border-radius:8px 8px 0 0;cursor:grab;user-select:none;';

    var brandLabel = origCreate('span');
    brandLabel.textContent = 'ComfyUI Desktop 2.0';
    brandLabel.style.cssText = 'flex:1;color:' + theme.textSecondary + ';font-size:11px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;';

    var closeBtn = origCreate('button');
    closeBtn.textContent = '\\u00d7';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:none;border:none;color:' + theme.textMuted + ';cursor:pointer;font-size:14px;padding:0 4px;line-height:1;';
    closeBtn.onmouseenter = function() { this.style.color = theme.textPrimary; };
    closeBtn.onmouseleave = function() { this.style.color = theme.textMuted; };
    closeBtn.onclick = function(e) {
      e.stopPropagation();
      isDocked = true;
      applyDockedPosition();
      saveDockState();
      hidePanel();
    };

    header.appendChild(brandLabel);
    header.appendChild(closeBtn);

    // Drag handling with dock/undock support
    header.addEventListener('mousedown', function(e) {
      if (e.target === closeBtn) return;
      e.preventDefault();
      header.style.cursor = 'grabbing';
      var rect = dlContainer.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, wasDocked: isDocked, moved: false };
      dlContainer.style.willChange = 'left,top';
      dlContainer.style.transition = 'none';
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      if (!dragState.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      dragState.moved = true;

      // Once dragging starts, switch to absolute positioning
      if (isDocked) {
        isDocked = false;
      }
      applyUndockedPosition(dragState.origLeft + dx, dragState.origTop + dy);

      // Show dock zone and highlight if cursor is near
      if (isInDockZone(e.clientX, e.clientY)) {
        showDockZone(true);
      } else {
        showDockZone(false);
      }
    });
    document.addEventListener('mouseup', function(e) {
      if (!dragState) return;
      var wasMoved = dragState.moved;
      dragState = null;
      header.style.cursor = 'grab';
      dlContainer.style.willChange = '';
      dlContainer.style.transition = '';
      hideDockZone();
      if (!wasMoved) return;

      // Check if we should snap to dock
      if (isInDockZone(e.clientX, e.clientY)) {
        isDocked = true;
        applyDockedPosition();
      }
      saveDockState();
    });

    // Card list container
    var cardList = origCreate('div');
    cardList.id = '__comfy-dl-cardlist';
    cardList.style.cssText = 'display:flex;flex-direction:column;gap:1px;background:' + theme.cardBg + ';border-radius:0 0 8px 8px;overflow-x:hidden;overflow-y:auto;max-height:320px;';

    dlContainer.appendChild(header);
    dlContainer.appendChild(cardList);
    document.body.appendChild(dlContainer);
    return dlContainer;
  }

  function getCardList() {
    var cont = getDlContainer();
    return cont.querySelector('#__comfy-dl-cardlist');
  }

  function fmtBytes(b) {
    if (!b || b <= 0) return '';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  function fmtSpeed(bps) {
    if (bps < 1048576) return (bps / 1024).toFixed(0) + ' KB/s';
    return (bps / 1048576).toFixed(1) + ' MB/s';
  }

  function fmtEta(sec) {
    if (sec < 60) return Math.ceil(sec) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + Math.ceil(sec % 60) + 's';
    var h = Math.floor(sec / 3600);
    var m = Math.ceil((sec % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  function fmtStatus(data) {
    if (data.status === 'pending') return 'Starting\\u2026';
    if (data.status === 'completed') return 'Complete';
    if (data.status === 'cancelled') return 'Cancelled';
    if (data.status === 'error') return data.error || 'Download failed';
    var pct = Math.round(data.progress * 100) + '%';
    var parts = [];
    if (data.status === 'paused') parts.push('Paused');
    if (data.totalBytes > 0) {
      parts.push(fmtBytes(data.receivedBytes) + ' / ' + fmtBytes(data.totalBytes));
    }
    parts.push(pct);
    if (data.status !== 'paused' && data.speedBytesPerSec > 0) {
      parts.push(fmtSpeed(data.speedBytesPerSec));
    }
    if (data.status !== 'paused' && data.etaSeconds > 0 && isFinite(data.etaSeconds)) {
      parts.push(fmtEta(data.etaSeconds));
    }
    return parts.join(' \\u00b7 ');
  }

  function makeBtn(label, title, onClick) {
    var btn = origCreate('button');
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = 'background:none;border:1px solid ' + theme.btnBorder + ';border-radius:4px;color:' + theme.textSecondary + ';cursor:pointer;font-size:11px;padding:2px 8px;line-height:1.4;';
    btn.onmouseenter = function() { this.style.borderColor = theme.btnBorderHover; this.style.color = theme.textPrimary; };
    btn.onmouseleave = function() { this.style.borderColor = theme.btnBorder; this.style.color = theme.textSecondary; };
    btn.onclick = function(e) { e.stopPropagation(); onClick(); };
    return btn;
  }

  function createDlCard(data) {
    var list = getCardList();
    var card = origCreate('div');
    card.style.cssText = 'background:' + theme.cardBg + ';border:1px solid ' + theme.borderColor + ';border-radius:0;padding:10px 12px;color:' + theme.textPrimary + ';pointer-events:auto;transition:opacity 0.3s,transform 0.3s;opacity:0;transform:translateY(8px);';

    var header = origCreate('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';

    var icon = origCreate('span');
    icon.style.cssText = 'flex-shrink:0;font-size:14px;';

    var fname = origCreate('span');
    fname.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:12px;';
    fname.textContent = data.filename || '';
    fname.title = data.filename || '';

    header.appendChild(icon);
    header.appendChild(fname);

    var dirLine = origCreate('div');
    dirLine.style.cssText = 'color:' + theme.textMuted + ';font-size:11px;margin-bottom:6px;';
    dirLine.textContent = data.directory || '';

    var barBg = origCreate('div');
    barBg.style.cssText = 'height:3px;background:' + theme.trackBg + ';border-radius:2px;overflow:hidden;margin-bottom:6px;';

    var barFill = origCreate('div');
    barFill.style.cssText = 'height:100%;width:0%;border-radius:2px;transition:width 0.3s ease;';
    barBg.appendChild(barFill);

    var statusLine = origCreate('div');
    statusLine.style.cssText = 'color:' + theme.textSecondary + ';font-size:11px;';

    // Control buttons row — hidden by default, shown only for active states
    var controls = origCreate('div');
    controls.style.cssText = 'display:none;gap:6px;margin-top:6px;';

    var pauseBtn = makeBtn('\\u23f8 Pause', 'Pause download', function() {
      window.__comfyDesktop2.pauseDownload(data.url);
    });
    var resumeBtn = makeBtn('\\u25b6 Resume', 'Resume download', function() {
      window.__comfyDesktop2.resumeDownload(data.url);
    });
    var cancelBtn = makeBtn('\\u00d7 Cancel', 'Cancel download', function() {
      window.__comfyDesktop2.cancelDownload(data.url);
    });

    controls.appendChild(pauseBtn);
    controls.appendChild(resumeBtn);
    controls.appendChild(cancelBtn);

    card.appendChild(header);
    card.appendChild(dirLine);
    card.appendChild(barBg);
    card.appendChild(statusLine);
    card.appendChild(controls);
    list.appendChild(card);

    requestAnimationFrame(function() {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    });

    var entry = {
      el: card, icon: icon, fname: fname, dirLine: dirLine,
      barFill: barFill, statusLine: statusLine, controls: controls,
      pauseBtn: pauseBtn, resumeBtn: resumeBtn, cancelBtn: cancelBtn,
      timer: null, url: data.url, status: data.status || 'pending'
    };
    dlCards[data.url] = entry;
    return entry;
  }

  function updateControls(entry, status) {
    var active = status === 'downloading' || status === 'pending' || status === 'paused';
    entry.controls.style.display = active ? 'flex' : 'none';
    entry.pauseBtn.style.display = status === 'downloading' ? '' : 'none';
    entry.resumeBtn.style.display = status === 'paused' ? '' : 'none';
    entry.cancelBtn.style.display = active ? '' : 'none';
  }

  function updateDlCard(data) {
    var isNew = !dlCards[data.url];
    var entry = dlCards[data.url] || createDlCard(data);
    var pct = Math.round(data.progress * 100);
    entry.barFill.style.width = pct + '%';
    entry.statusLine.textContent = fmtStatus(data);
    if (data.directory) entry.dirLine.textContent = data.directory;
    entry.url = data.url;
    entry.status = data.status;

    updateControls(entry, data.status);

    if (data.status === 'pending' || data.status === 'downloading') {
      entry.icon.textContent = '\\u2193';
      entry.icon.style.color = '#3b82f6';
      entry.barFill.style.background = '#3b82f6';
      entry.statusLine.style.color = theme.textSecondary;
    } else if (data.status === 'paused') {
      entry.icon.textContent = '\\u23f8';
      entry.icon.style.color = '#f59e0b';
      entry.barFill.style.background = '#f59e0b';
      entry.statusLine.style.color = '#f59e0b';
    } else if (data.status === 'completed') {
      entry.barFill.style.width = '100%';
      entry.barFill.style.background = '#22c55e';
      entry.icon.textContent = '\\u2713';
      entry.icon.style.color = '#22c55e';
      entry.statusLine.style.color = '#22c55e';
      if (!entry.timer) entry.timer = setTimeout(function() { removeDlCard(data.url); }, 4000);
    } else if (data.status === 'error') {
      entry.barFill.style.background = '#ef4444';
      entry.icon.textContent = '\\u2717';
      entry.icon.style.color = '#ef4444';
      entry.statusLine.style.color = '#ef4444';
    } else if (data.status === 'cancelled') {
      entry.icon.textContent = '\\u2014';
      entry.icon.style.color = theme.textMuted;
      entry.statusLine.style.color = theme.textMuted;
      if (!entry.timer) entry.timer = setTimeout(function() { removeDlCard(data.url); }, 3000);
    }

    // When a brand-new download appears, show the tab (not the full panel)
    if (isNew && !dlPanelOpen) {
      if (tabFadeTimer) { clearTimeout(tabFadeTimer); tabFadeTimer = null; }
      ensureTab();
      if (dlTab) { dlTab.style.display = ''; dlTab.style.opacity = '1'; dlTab.style.pointerEvents = 'auto'; }
      if (dlContainer) dlContainer.style.display = 'none';
    }

    updateTabProgress();
  }

  function removeDlCard(url) {
    var entry = dlCards[url];
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.style.opacity = '0';
    entry.el.style.transform = 'translateY(8px)';
    setTimeout(function() {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
      delete dlCards[url];
      updateTabProgress();
      if (Object.keys(dlCards).length === 0) {
        dlPanelOpen = false;
        if (dlContainer) dlContainer.style.display = 'none';
        if (dlTab) dlTab.style.display = 'none';
      }
    }, 300);
  }

  // Click outside the toast while docked → collapse to tab
  // Use pointerdown to catch LiteGraph canvas interactions too
  document.addEventListener('pointerdown', function(e) {
    if (!dlPanelOpen || !isDocked || !dlContainer) return;
    if (dlContainer.contains(e.target)) return;
    hidePanel();
  }, true);

  window.__comfyDesktop2.onDownloadProgress(function(data) {
    updateDlCard(data);
  });
})();`
}
