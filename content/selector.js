(() => {
  if (globalThis.__saveShotContentLoaded) {
    return;
  }
  globalThis.__saveShotContentLoaded = true;

  const OVERLAY_HOST_ID = '__saveshot-overlay-host';
  const TOAST_HOST_ID = '__saveshot-toast-host';

  let cleanupOverlay = null;
  let toastDismissTimer = null;

  function checkRegionSupport() {
    if (
      !document.documentElement ||
      !(document.documentElement instanceof HTMLElement) ||
      document.documentElement.namespaceURI !== 'http://www.w3.org/1999/xhtml'
    ) {
      return {
        ok: false,
        code: 'UNSUPPORTED_DOM',
        reason:
          'Region selection is not available on standalone SVG/XML documents. Use "Visible Tab" instead.',
      };
    }

    if (
      document.contentType === 'application/pdf' ||
      document.querySelector('embed[type="application/x-google-chrome-pdf"]')
    ) {
      return {
        ok: false,
        code: 'PDF_VIEWER_PAGE',
        reason:
          'Region selection is not available inside Chrome\'s PDF viewer plugin. Use "Visible Tab" instead.',
      };
    }

    return { ok: true };
  }

  function removeHostElement(id) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      if (el.tagName === 'DIALOG' && el.open) {
        el.close();
      } else if (typeof el.hidePopover === 'function') {
        el.hidePopover();
      }
    } catch {
      // Ignore cleanup errors
    }
    el.remove();
  }

  function clearActiveOverlay() {
    if (typeof cleanupOverlay === 'function') {
      const fn = cleanupOverlay;
      cleanupOverlay = null;
      fn();
    }
    removeHostElement(OVERLAY_HOST_ID);
  }

  /**
   * Create a top-layer host element immune to ancestor CSS zoom, transform, filter, z-index,
   * and open modal <dialog> inertness.
   */
  function mountTopLayerHost(id, { interactiveModalFallback = false, cssBounds = '' } = {}) {
    const parentTarget =
      document.fullscreenElement instanceof HTMLElement
        ? document.fullscreenElement
        : document.documentElement;

    const ancestorZoom = Number(parentTarget.currentCSSZoom) || 1;
    const inverseZoom = ancestorZoom > 0 ? 1 / ancestorZoom : 1;

    const hasOpenModalDialog =
      interactiveModalFallback && Boolean(document.querySelector('dialog:modal'));

    if (hasOpenModalDialog) {
      const dlg = document.createElement('dialog');
      dlg.id = id;
      dlg.style.cssText =
        `all:initial;display:block !important;position:fixed !important;${cssBounds}` +
        `max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;` +
        `border:0 !important;outline:0 !important;background:transparent !important;` +
        `zoom:${inverseZoom} !important;z-index:2147483647 !important;overflow:visible !important;`;
      const shadowContainer = document.createElement('div');
      shadowContainer.style.cssText = `position:fixed;${cssBounds}`;
      const shadow = shadowContainer.attachShadow({ mode: 'open' });
      dlg.appendChild(shadowContainer);
      parentTarget.appendChild(dlg);
      try {
        dlg.showModal();
      } catch {
        // Fallback if showModal fails
      }
      return { host: dlg, shadow };
    }

    const div = document.createElement('div');
    div.id = id;
    if (typeof div.showPopover === 'function') {
      div.setAttribute('popover', 'manual');
    }
    div.style.cssText =
      `all:initial;display:block !important;position:fixed !important;${cssBounds}` +
      `max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;` +
      `border:0 !important;outline:0 !important;background:transparent !important;` +
      `zoom:${inverseZoom} !important;z-index:2147483647 !important;overflow:visible !important;`;

    const shadow = div.attachShadow({ mode: 'open' });
    parentTarget.appendChild(div);
    try {
      if (typeof div.showPopover === 'function') {
        div.showPopover();
      }
    } catch {
      // Fallback to standard fixed z-index positioning
    }
    return { host: div, shadow };
  }

  /**
   * Briefly swallow trailing mouseup/click events after releasing drag so underlying
   * links or buttons on the webpage are never accidentally clicked.
   */
  function installTrailingClickShield(durationMs = 160) {
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('auxclick', swallow, true);
    setTimeout(() => {
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('auxclick', swallow, true);
    }, durationMs);
  }

  function startRegionSelection() {
    const support = checkRegionSupport();
    if (!support.ok) {
      return support;
    }

    clearActiveOverlay();
    removeHostElement(TOAST_HOST_ID);

    const { shadow } = mountTopLayerHost(OVERLAY_HOST_ID, {
      interactiveModalFallback: true,
      cssBounds: 'inset:0 !important;width:100vw !important;height:100vh !important;pointer-events:auto !important;',
    });

    const vv = window.visualViewport;
    const vvScale = vv?.scale || 1;
    const hintTop = vv ? Math.round(vv.offsetTop + 20 / vvScale) : 20;
    const hintLeft = vv ? Math.round(vv.offsetLeft + vv.width / 2) : Math.round(window.innerWidth / 2);

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; user-select: none; -webkit-user-select: none; }
        [hidden] { display: none !important; }
        .backdrop {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          cursor: crosshair;
          background: rgba(15, 18, 24, 0.34);
          touch-action: none;
        }
        .backdrop.dragging {
          background: transparent;
        }
        .hint {
          position: fixed;
          top: ${hintTop}px;
          left: ${hintLeft}px;
          transform: translateX(-50%) scale(${1 / vvScale});
          transform-origin: top center;
          background: rgba(20, 21, 24, 0.94);
          backdrop-filter: blur(10px);
          color: #f3f4f6;
          font: 500 12.5px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif;
          height: 36px;
          padding: 0 8px 0 12px;
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
          border: 1px solid rgba(255, 255, 255, 0.12);
          display: inline-flex;
          align-items: center;
          gap: 8px;
          pointer-events: auto;
          white-space: nowrap;
          cursor: default;
        }
        .sep {
          width: 1px;
          height: 14px;
          background: rgba(255, 255, 255, 0.16);
          flex-shrink: 0;
        }
        .hud-btn {
          height: 24px;
          padding: 0 8px;
          border-radius: 7px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
          font: inherit;
          font-size: 12px;
          font-weight: 500;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .hud-btn:hover {
          background: rgba(255, 255, 255, 0.16);
          border-color: rgba(255, 255, 255, 0.28);
        }
        .hud-kbd {
          height: 18px;
          padding: 0 5px;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.1);
          color: #a6abb6;
          font-family: inherit;
          font-size: 10.5px;
          font-weight: 500;
          line-height: 16px;
          display: inline-flex;
          align-items: center;
          font-variant-numeric: tabular-nums;
        }
        .selection {
          position: fixed;
          display: none;
          border: ${Math.max(1, 1.5 / vvScale)}px solid #1a73e8;
          background: transparent;
          box-shadow: 0 0 0 9999px rgba(15, 18, 24, 0.42);
          pointer-events: none;
        }
        .dimensions {
          position: fixed;
          display: none;
          transform: scale(${1 / vvScale});
          transform-origin: top left;
          background: rgba(20, 21, 24, 0.94);
          color: #f3f4f6;
          font: 600 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-variant-numeric: tabular-nums;
          padding: 3px 8px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.28);
          pointer-events: none;
          white-space: nowrap;
        }
      </style>
      <div class="backdrop" id="backdrop">
        <div class="hint" id="hint">
          <span>Drag to select area</span>
          <span class="sep" aria-hidden="true"></span>
          <button type="button" class="hud-btn" id="full-tab-btn" title="Capture full visible tab (Enter)">
            <span>Full tab</span>
            <kbd class="hud-kbd">Enter</kbd>
          </button>
          <span class="sep" aria-hidden="true"></span>
          <kbd class="hud-kbd" title="Press Esc to cancel">Esc</kbd>
        </div>
        <div class="selection" id="selection"></div>
        <div class="dimensions" id="dimensions"></div>
      </div>
    `;

    const backdrop = shadow.getElementById('backdrop');
    const hint = shadow.getElementById('hint');
    const fullTabBtn = shadow.getElementById('full-tab-btn');
    const selectionEl = shadow.getElementById('selection');
    const dimensionsEl = shadow.getElementById('dimensions');

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let currentRect = null;

    function getVisibleBounds() {
      const v = window.visualViewport;
      if (v && v.scale > 1.001) {
        return {
          minX: v.offsetLeft,
          minY: v.offsetTop,
          maxX: v.offsetLeft + v.width,
          maxY: v.offsetTop + v.height,
        };
      }
      return {
        minX: 0,
        minY: 0,
        maxX: window.innerWidth,
        maxY: window.innerHeight,
      };
    }

    function updateBox(clientX, clientY) {
      const bounds = getVisibleBounds();
      const clampedX = Math.max(bounds.minX, Math.min(bounds.maxX, clientX));
      const clampedY = Math.max(bounds.minY, Math.min(bounds.maxY, clientY));

      const x = Math.min(startX, clampedX);
      const y = Math.min(startY, clampedY);
      const width = Math.abs(clampedX - startX);
      const height = Math.abs(clampedY - startY);

      currentRect = { x, y, width, height };

      selectionEl.style.display = 'block';
      selectionEl.style.left = `${x}px`;
      selectionEl.style.top = `${y}px`;
      selectionEl.style.width = `${width}px`;
      selectionEl.style.height = `${height}px`;

      const dpr = window.devicePixelRatio || 1;
      const vScale = window.visualViewport?.scale || 1;
      const pxW = Math.max(1, Math.round(width * dpr * vScale));
      const pxH = Math.max(1, Math.round(height * dpr * vScale));

      dimensionsEl.style.display = 'block';
      dimensionsEl.textContent = `${pxW} \u00d7 ${pxH}`;
      const badgeTop =
        y + height + 8 + 26 / vScale < bounds.maxY
          ? y + height + 8 / vScale
          : Math.max(bounds.minY + 4, y - 28 / vScale);
      const badgeLeft = Math.min(
        bounds.maxX - 96 / vScale,
        Math.max(bounds.minX + 4, x)
      );
      dimensionsEl.style.top = `${badgeTop}px`;
      dimensionsEl.style.left = `${badgeLeft}px`;
    }

    function stopEvent(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    function afterOverlayRepaint(delayMs, callback) {
      if (document.hidden) {
        callback();
        return;
      }
      let fired = false;
      const run = () => {
        if (fired) return;
        fired = true;
        callback();
      };
      const fallbackTimer = setTimeout(run, 120);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            clearTimeout(fallbackTimer);
            run();
          }, delayMs);
        });
      });
    }

    function triggerFullTabCapture() {
      installTrailingClickShield();
      clearActiveOverlay();
      afterOverlayRepaint(35, () => {
        chrome.runtime
          .sendMessage({ type: 'CAPTURE_VISIBLE_FROM_OVERLAY' })
          .catch(() => {});
      });
    }

    fullTabBtn.addEventListener('click', (e) => {
      stopEvent(e);
      triggerFullTabCapture();
    });

    function onPointerDown(e) {
      if (hint.contains(e.target)) {
        e.stopPropagation();
        return;
      }
      stopEvent(e);
      if (e.button !== 0) {
        installTrailingClickShield();
        clearActiveOverlay();
        return;
      }
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events may not have an active pointerId
      }
      backdrop.classList.add('dragging');
      hint.hidden = true;
      updateBox(e.clientX, e.clientY);
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      stopEvent(e);
      updateBox(e.clientX, e.clientY);
    }

    function onPointerUp(e) {
      if (!isDragging) return;
      stopEvent(e);
      isDragging = false;
      updateBox(e.clientX, e.clientY);

      const finalRect = currentRect;
      const v = window.visualViewport;
      const selectionPayload = finalRect
        ? {
            x: finalRect.x,
            y: finalRect.y,
            width: finalRect.width,
            height: finalRect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1,
            visualViewportOffsetLeft: v?.offsetLeft || 0,
            visualViewportOffsetTop: v?.offsetTop || 0,
            visualViewportScale: v?.scale || 1,
          }
        : null;

      installTrailingClickShield();
      clearActiveOverlay();

      const minCssSize = 6 / (v?.scale || 1);
      if (
        !selectionPayload ||
        selectionPayload.width < minCssSize ||
        selectionPayload.height < minCssSize
      ) {
        showToast({
          status: 'info',
          title: 'Selection cancelled',
          message: 'Drag across an area or press Enter to capture the full tab.',
        });
        return;
      }

      // Wait for two paint frames + short settle (with occlusion fallback) so overlay never appears in shot
      afterOverlayRepaint(35, () => {
        chrome.runtime
          .sendMessage({
            type: 'REGION_SELECTED',
            selection: selectionPayload,
          })
          .catch(() => {});
      });
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        stopEvent(e);
        clearActiveOverlay();
        return;
      }
      if (e.key === 'Enter' && !isDragging) {
        stopEvent(e);
        triggerFullTabCapture();
      }
    }

    function onCancelEvent(e) {
      stopEvent(e);
      clearActiveOverlay();
    }

    function onWheelOrTouchMove(e) {
      if (isDragging) {
        stopEvent(e);
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        clearActiveOverlay();
      }
    }

    function onMouseDownCapture(e) {
      if (e.composedPath().includes(hint)) {
        e.stopPropagation();
        return;
      }
      stopEvent(e);
    }

    backdrop.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onCancelEvent, true);
    window.addEventListener('mousedown', onMouseDownCapture, true);
    window.addEventListener('dragstart', stopEvent, true);
    window.addEventListener('selectstart', stopEvent, true);
    window.addEventListener('contextmenu', onCancelEvent, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onWheelOrTouchMove, { capture: true, passive: false });
    window.addEventListener('touchmove', onWheelOrTouchMove, { capture: true, passive: false });
    document.addEventListener('visibilitychange', onVisibilityChange, true);

    cleanupOverlay = () => {
      backdrop.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onCancelEvent, true);
      window.removeEventListener('mousedown', onMouseDownCapture, true);
      window.removeEventListener('dragstart', stopEvent, true);
      window.removeEventListener('selectstart', stopEvent, true);
      window.removeEventListener('contextmenu', onCancelEvent, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onWheelOrTouchMove, true);
      window.removeEventListener('touchmove', onWheelOrTouchMove, true);
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
    };

    return { ok: true };
  }

  function showToast(payload) {
    const support = checkRegionSupport();
    if (!support.ok && document.documentElement?.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      return;
    }

    if (toastDismissTimer) {
      clearTimeout(toastDismissTimer);
      toastDismissTimer = null;
    }
    removeHostElement(TOAST_HOST_ID);

    const {
      status = 'info',
      title = '',
      message = '',
      webViewLink = '',
      thumbnailDataUrl = '',
      autoCopyLink = false,
      canEdit = false,
      hasFallback = false,
      fallbackDataUrl = '',
      fallbackFilename = 'Screenshot.png',
      theme = 'auto',
    } = payload || {};

    const safeHttpsLink = (() => {
      if (typeof webViewLink !== 'string' || !webViewLink) return '';
      try {
        const parsed = new URL(webViewLink);
        return parsed.protocol === 'https:' ? parsed.href : '';
      } catch {
        return '';
      }
    })();

    const vv = window.visualViewport;
    const vvScale = vv?.scale || 1;
    const posCss =
      vv && vvScale > 1.001
        ? `left:${Math.round(vv.offsetLeft + vv.width - 344 / vvScale)}px !important;top:${Math.round(
            vv.offsetTop + vv.height - 132 / vvScale
          )}px !important;`
        : 'bottom:20px !important;right:20px !important;';

    const { host, shadow } = mountTopLayerHost(TOAST_HOST_ID, {
      interactiveModalFallback: false,
      cssBounds: `${posCss}width:auto !important;height:auto !important;pointer-events:auto !important;`,
    });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        .toast {
          --t-bg: #ffffff;
          --t-surface: #f5f6f8;
          --t-surface-hover: #eceef2;
          --t-border: rgba(15, 18, 24, 0.08);
          --t-border-strong: rgba(15, 18, 24, 0.15);
          --t-text: #141518;
          --t-sub: #525866;
          --t-muted: #767c89;
          --t-accent: #1a73e8;
          --t-accent-hover: #155fc4;
          --t-on-accent: #ffffff;
          --t-green: #15803d;
          --t-err: #dc2626;
          --t-shadow: 0 16px 38px rgba(15, 18, 24, 0.18), 0 1px 3px rgba(15, 18, 24, 0.08);

          width: 332px;
          transform: scale(${1 / vvScale});
          transform-origin: bottom right;
          background: var(--t-bg);
          color: var(--t-text);
          border-radius: 14px;
          border: 1px solid var(--t-border-strong);
          box-shadow: var(--t-shadow);
          padding: 12px 14px;
          font: 400 12.5px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif;
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: slideIn 150ms ease-out;
        }
        @media (prefers-color-scheme: dark) {
          .toast:not([data-theme="light"]) {
            --t-bg: #1c1d20;
            --t-surface: #25262b;
            --t-surface-hover: #2f3137;
            --t-border: rgba(255, 255, 255, 0.08);
            --t-border-strong: rgba(255, 255, 255, 0.16);
            --t-text: #f3f4f6;
            --t-sub: #a6abb6;
            --t-muted: #7c828f;
            --t-accent: #5b9df9;
            --t-accent-hover: #428bf7;
            --t-on-accent: #0d131f;
            --t-green: #4ade80;
            --t-err: #f87171;
            --t-shadow: 0 18px 42px rgba(0, 0, 0, 0.52), 0 0 0 1px rgba(255, 255, 255, 0.08);
          }
        }
        .toast[data-theme="dark"] {
          --t-bg: #1c1d20;
          --t-surface: #25262b;
          --t-surface-hover: #2f3137;
          --t-border: rgba(255, 255, 255, 0.08);
          --t-border-strong: rgba(255, 255, 255, 0.16);
          --t-text: #f3f4f6;
          --t-sub: #a6abb6;
          --t-muted: #7c828f;
          --t-accent: #5b9df9;
          --t-accent-hover: #428bf7;
          --t-on-accent: #0d131f;
          --t-green: #4ade80;
          --t-err: #f87171;
          --t-shadow: 0 18px 42px rgba(0, 0, 0, 0.52), 0 0 0 1px rgba(255, 255, 255, 0.08);
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(8px) scale(${1 / vvScale}); }
          to { opacity: 1; transform: translateY(0) scale(${1 / vvScale}); }
        }
        .row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .thumb {
          width: 46px;
          height: 34px;
          object-fit: cover;
          border-radius: 6px;
          border: 1px solid var(--t-border);
          flex-shrink: 0;
          background: var(--t-surface);
        }
        .spinner {
          width: 18px;
          height: 18px;
          border: 2px solid var(--t-border-strong);
          border-top-color: var(--t-accent);
          border-radius: 50%;
          animation: spin 700ms linear infinite;
          flex-shrink: 0;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .dot.success { background: var(--t-green); }
        .dot.error { background: var(--t-err); }
        .dot.info { background: var(--t-accent); }
        .body {
          flex: 1;
          min-width: 0;
        }
        .title {
          font-weight: 600;
          font-size: 13px;
          line-height: 18px;
          letter-spacing: -0.015em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sub {
          font-size: 12px;
          line-height: 17px;
          color: var(--t-sub);
          margin-top: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
        }
        .close {
          width: 24px;
          height: 24px;
          border-radius: 6px;
          background: transparent;
          border: none;
          color: var(--t-muted);
          font-size: 17px;
          line-height: 1;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          align-self: flex-start;
          flex-shrink: 0;
          transition: background 120ms ease, color 120ms ease;
        }
        .close:hover {
          background: var(--t-surface-hover);
          color: var(--t-text);
        }
        .actions {
          display: flex;
          gap: 6px;
        }
        .btn {
          flex: 1;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0 10px;
          border-radius: 8px;
          font-family: inherit;
          font-size: 12.5px;
          font-weight: 500;
          line-height: 18px;
          cursor: pointer;
          text-decoration: none;
          border: 1px solid transparent;
          white-space: nowrap;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .btn-compact {
          flex: 0.76;
        }
        .btn-primary {
          background: var(--t-accent);
          color: var(--t-on-accent);
        }
        .btn-primary:hover { background: var(--t-accent-hover); }
        .btn-secondary {
          background: var(--t-bg);
          color: var(--t-text);
          border-color: var(--t-border-strong);
        }
        .btn-secondary:hover { background: var(--t-surface); }
      </style>
      <div class="toast" id="toast">
        <div class="row">
          <div id="leading"></div>
          <div class="body">
            <div class="title" id="title"></div>
            <div class="sub" id="message"></div>
          </div>
          <button type="button" class="close" id="close" aria-label="Dismiss">&times;</button>
        </div>
        <div class="actions" id="actions" hidden></div>
      </div>
    `;

    const leadingEl = shadow.getElementById('leading');
    const titleEl = shadow.getElementById('title');
    const msgEl = shadow.getElementById('message');
    const closeBtn = shadow.getElementById('close');
    const actionsEl = shadow.getElementById('actions');
    const toastEl = shadow.getElementById('toast');

    if (theme === 'light' || theme === 'dark') {
      toastEl.dataset.theme = theme;
    }

    const makeStatusDot = () => {
      const dot = document.createElement('div');
      dot.className = `dot ${status}`;
      return dot;
    };

    if (typeof thumbnailDataUrl === 'string' && thumbnailDataUrl.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = thumbnailDataUrl;
      img.alt = 'Screenshot preview';
      img.addEventListener('error', () => {
        img.replaceWith(makeStatusDot());
      });
      leadingEl.replaceWith(img);
    } else if (status === 'uploading') {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      leadingEl.replaceWith(spinner);
    } else {
      leadingEl.replaceWith(makeStatusDot());
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.hidden = !message;

    const dismiss = () => {
      if (toastDismissTimer) {
        clearTimeout(toastDismissTimer);
        toastDismissTimer = null;
      }
      removeHostElement(TOAST_HOST_ID);
    };

    if (status === 'success' && safeHttpsLink) {
      actionsEl.hidden = false;
      const defaultCopyLabel = canEdit ? 'Copy link' : 'Copy Drive link';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-primary';
      copyBtn.textContent = defaultCopyLabel;

      let copyResetTimer = null;
      const flashCopyText = (label, ms) => {
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyBtn.textContent = label;
        copyResetTimer = setTimeout(() => {
          copyBtn.textContent = defaultCopyLabel;
          copyResetTimer = null;
        }, ms);
      };

      // Best-effort auto-copy when page has focus and setting is enabled
      if (autoCopyLink && document.hasFocus() && navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(safeHttpsLink)
          .then(() => flashCopyText('Link copied!', 2000))
          .catch(() => {});
      }

      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(safeHttpsLink);
          flashCopyText('Copied!', 1800);
        } catch {
          copyBtn.textContent = 'Copy failed';
        }
      });

      actionsEl.append(copyBtn);

      if (canEdit) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-secondary btn-compact';
        editBtn.textContent = 'Edit';
        editBtn.title = 'Annotate, redact, rotate, or rename in Google Drive';
        editBtn.addEventListener('click', () => {
          editBtn.disabled = true;
          chrome.runtime.sendMessage({ type: 'OPEN_LAST_CAPTURE_EDITOR' }, () => {
            void chrome.runtime.lastError;
            dismiss();
          });
        });
        actionsEl.append(editBtn);
      }

      const openLink = document.createElement('a');
      openLink.className = canEdit ? 'btn btn-secondary btn-compact' : 'btn btn-secondary';
      openLink.href = safeHttpsLink;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.textContent = canEdit ? 'Open' : 'Open in Drive';

      actionsEl.append(openLink);
    } else if (status === 'error' && (hasFallback || fallbackDataUrl)) {
      actionsEl.hidden = false;
      if (typeof fallbackDataUrl === 'string' && fallbackDataUrl.startsWith('data:image/')) {
        const saveLocalLink = document.createElement('a');
        saveLocalLink.className = 'btn btn-primary';
        saveLocalLink.href = fallbackDataUrl;
        saveLocalLink.download = fallbackFilename;
        saveLocalLink.textContent = 'Save PNG locally';
        actionsEl.append(saveLocalLink);
      } else {
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-primary';
        saveBtn.textContent = 'Save PNG locally';
        saveBtn.addEventListener('click', () => {
          saveBtn.disabled = true;
          chrome.runtime.sendMessage({ type: 'GET_FALLBACK_PNG' }, (res) => {
            if (!chrome.runtime.lastError && res?.ok && res.dataUrl) {
              const a = document.createElement('a');
              a.href = res.dataUrl;
              a.download = res.filename || fallbackFilename;
              a.click();
              saveBtn.textContent = 'Saved!';
            } else {
              saveBtn.textContent = 'Expired';
            }
          });
        });
        actionsEl.append(saveBtn);
      }
    }

    closeBtn.addEventListener('click', dismiss);

    const autoMs =
      status === 'uploading'
        ? 0
        : hasFallback || fallbackDataUrl
        ? 18000
        : status === 'success'
        ? 7500
        : 5500;

    if (autoMs > 0) {
      const schedule = () => {
        toastDismissTimer = setTimeout(dismiss, autoMs);
      };
      schedule();
      toastEl.addEventListener('mouseenter', () => {
        if (toastDismissTimer) clearTimeout(toastDismissTimer);
      });
      toastEl.addEventListener('mouseleave', schedule);
    }

    void host;
  }

  /* -------------------------------------------------------------------------
     Full-Page Scrolling Capture Controller (v1.3.0)
     ------------------------------------------------------------------------- */
  const FULLPAGE_STYLE_ID = '__saveshot-fullpage-style';
  const FULLPAGE_PILL_HOST_ID = '__saveshot-fullpage-pill-host';

  let fullPageSession = null;

  function waitNextPaint(extraMs = 0) {
    return new Promise((resolve) => {
      if (document.hidden) {
        setTimeout(resolve, Math.max(0, extraMs));
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fallback = setTimeout(done, Math.max(140, extraMs + 120));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            clearTimeout(fallback);
            done();
          }, extraMs);
        });
      });
    });
  }

  function detectFullPageScrollTarget() {
    const docEl = document.scrollingElement || document.documentElement;
    const vpW = window.innerWidth || docEl.clientWidth || 1;
    const vpH = window.innerHeight || docEl.clientHeight || 1;

    if (docEl && docEl.scrollHeight > vpH + 4) {
      return {
        element: docEl,
        isWindow: true,
        containerRect: null,
      };
    }

    // Fallback for modern SPAs (Notion, Slack, dashboards) where body is overflow:hidden
    // and an inner main/div container scrolls vertically.
    let bestEl = null;
    let bestScore = 0;
    const candidates = document.querySelectorAll('main, article, section, div');
    const limit = Math.min(candidates.length, 400);
    for (let i = 0; i < limit; i += 1) {
      const el = candidates[i];
      if (!el || el.id === OVERLAY_HOST_ID || el.id === TOAST_HOST_ID || el.id === FULLPAGE_PILL_HOST_ID) {
        continue;
      }
      if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < vpH * 0.5) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < vpW * 0.55 || rect.height < vpH * 0.5) {
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll' && cs.overflowY !== 'overlay') {
        continue;
      }
      const score = rect.width * rect.height + (el.scrollHeight - el.clientHeight);
      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    if (bestEl) {
      const r = bestEl.getBoundingClientRect();
      return {
        element: bestEl,
        isWindow: false,
        containerRect: {
          left: Math.max(0, r.left),
          top: Math.max(0, r.top),
          width: Math.max(1, Math.min(vpW - Math.max(0, r.left), r.width)),
          height: Math.max(1, Math.min(vpH - Math.max(0, r.top), r.height)),
        },
      };
    }

    return {
      element: docEl,
      isWindow: true,
      containerRect: null,
    };
  }

  function scrollTargetInstant(session, left, top) {
    try {
      if (session.isWindow) {
        window.scrollTo({ left, top, behavior: 'instant' });
      } else if (session.element) {
        if (typeof session.element.scrollTo === 'function') {
          session.element.scrollTo({ left, top, behavior: 'instant' });
        } else {
          session.element.scrollLeft = left;
          session.element.scrollTop = top;
        }
      }
    } catch {
      try {
        if (session.isWindow) {
          window.scrollTo(left, top);
        } else if (session.element) {
          session.element.scrollLeft = left;
          session.element.scrollTop = top;
        }
      } catch {
        // Ignore scroll errors
      }
    }
  }

  function readScrollMetrics(session) {
    const vpW = window.innerWidth || document.documentElement.clientWidth || 1;
    const vpH = window.innerHeight || document.documentElement.clientHeight || 1;
    const vv = window.visualViewport;
    if (session.isWindow) {
      const docEl = document.scrollingElement || document.documentElement;
      return {
        viewportWidth: vpW,
        viewportHeight: vpH,
        scrollStepHeight: vpH,
        totalHeight: Math.max(vpH, docEl ? docEl.scrollHeight : vpH),
        actualY: Math.max(0, window.scrollY ?? (docEl ? docEl.scrollTop : 0)),
        devicePixelRatio: window.devicePixelRatio || 1,
        visualViewportScale: vv?.scale || 1,
        isInnerContainer: false,
        containerRect: null,
      };
    }

    const el = session.element;
    const r = el.getBoundingClientRect();
    const containerRect = {
      left: Math.max(0, r.left),
      top: Math.max(0, r.top),
      width: Math.max(1, Math.min(vpW - Math.max(0, r.left), r.width)),
      height: Math.max(1, Math.min(vpH - Math.max(0, r.top), r.height)),
    };
    return {
      viewportWidth: vpW,
      viewportHeight: vpH,
      scrollStepHeight: containerRect.height,
      totalHeight: Math.max(el.clientHeight, el.scrollHeight),
      actualY: Math.max(0, el.scrollTop),
      devicePixelRatio: window.devicePixelRatio || 1,
      visualViewportScale: vv?.scale || 1,
      isInnerContainer: true,
      containerRect,
    };
  }

  function walkDomElements(root, visit, { maxNodes = 20000, skipSubtreeSet = null } = {}) {
    if (!root) return;
    const stack = [root];
    let visited = 0;

    while (stack.length > 0 && visited < maxNodes) {
      const currentRoot = stack.pop();
      if (!currentRoot) continue;
      let walker;
      try {
        walker = document.createTreeWalker(currentRoot, NodeFilter.SHOW_ELEMENT, {
          acceptNode(node) {
            if (
              node.namespaceURI === 'http://www.w3.org/2000/svg' ||
              node.tagName === 'SVG' ||
              node.tagName === 'svg'
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (
              node.id === OVERLAY_HOST_ID ||
              node.id === TOAST_HOST_ID ||
              node.id === FULLPAGE_PILL_HOST_ID
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (skipSubtreeSet && skipSubtreeSet.has(node)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (!(node instanceof HTMLElement)) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
      } catch {
        continue;
      }

      let el = walker.nextNode();
      while (el && visited < maxNodes) {
        visited += 1;
        visit(el);
        if (el.shadowRoot) {
          stack.push(el.shadowRoot);
        }
        el = walker.nextNode();
      }
    }
  }

  function snapshotSlice0StickyElements(session) {
    if (!session) return;
    const vpH = window.innerHeight || document.documentElement.clientHeight || 1;
    const root = document.body || document.documentElement;
    if (!root) return;
    try {
      walkDomElements(root, (el) => {
        const pos = getComputedStyle(el).position;
        if (pos === 'sticky' || pos === '-webkit-sticky') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vpH) {
            session.slice0VisibleSet.add(el);
          }
        }
      });
    } catch {
      // Never abort capture on hostile DOM getters
    }
  }

  function attachFullPageMutationObserver(session) {
    if (!session || typeof MutationObserver !== 'function') return;
    const root = document.body || document.documentElement;
    if (!root) return;
    const MAX_DIRTY = 2000;
    const recordDirty = (node) => {
      if (!node || session.dirtyNodes.size >= MAX_DIRTY) return;
      if (
        node.id === OVERLAY_HOST_ID ||
        node.id === TOAST_HOST_ID ||
        node.id === FULLPAGE_PILL_HOST_ID
      ) {
        return;
      }
      if (node instanceof HTMLElement) {
        session.dirtyNodes.add(node);
      }
    };
    try {
      const observer = new MutationObserver((mutations) => {
        if (!session || session.cancelled || session.dirtyNodes.size >= MAX_DIRTY) return;
        for (const m of mutations) {
          if (m.type === 'attributes') {
            recordDirty(m.target);
          } else if (m.type === 'childList' && m.addedNodes?.length) {
            for (const added of m.addedNodes) {
              if (!(added instanceof HTMLElement)) continue;
              recordDirty(added);
              if (session.dirtyNodes.size < MAX_DIRTY && added.childElementCount > 0) {
                walkDomElements(
                  added,
                  (child) => recordDirty(child),
                  { maxNodes: Math.max(0, MAX_DIRTY - session.dirtyNodes.size) }
                );
              }
            }
          }
        }
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
      session.mutationObserver = observer;
    } catch {
      // Ignore MutationObserver failures
    }
  }

  function hideFixedAndStickyElements(session) {
    if (!session) return;
    const vpW = window.innerWidth || document.documentElement.clientWidth || 1;
    const vpH = window.innerHeight || document.documentElement.clientHeight || 1;
    const root = document.body || document.documentElement;
    if (!root) return;

    const toMutate = [];
    const MAX_ZERO_RECT = 500;

    const inspectElement = (el) => {
      if (!(el instanceof HTMLElement) || !el.isConnected) return;
      if (session.handledSet.has(el)) return;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky' && pos !== '-webkit-sticky') return;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        if (session.zeroRectNodes.size < MAX_ZERO_RECT) {
          session.zeroRectNodes.add(el);
        }
        return;
      }
      session.zeroRectNodes.delete(el);

      const isScrollContainerOrAncestor =
        el === session.element || (session.element && el.contains(session.element));
      // Only skip true full-viewport SPA root wrappers covering BOTH width and height
      const isFullViewportWrapper =
        rect.width >= vpW * 0.85 && rect.height >= vpH * 0.85;
      if (isScrollContainerOrAncestor || isFullViewportWrapper) return;

      const isSticky = pos === 'sticky' || pos === '-webkit-sticky';
      // Hide fixed overlays and slice-0-visible sticky chrome (e.g. X.com sidebars, top navbars)
      // via opacity: 0 (zero flex reflow and cannot be undone by descendant visibility: visible).
      // Convert below-the-fold sticky elements to position: static so they appear once in flow.
      const hideViaOpacity = !isSticky || session.slice0VisibleSet.has(el);
      const prop = hideViaOpacity ? 'opacity' : 'position';
      const val = hideViaOpacity ? '0' : 'static';
      toMutate.push({
        el,
        prop,
        val,
        prevValue: el.style.getPropertyValue(prop),
        prevPriority: el.style.getPropertyPriority(prop),
      });
      session.handledSet.add(el);
      if (hideViaOpacity) {
        session.opacityHiddenSet.add(el);
      }
    };

    try {
      if (!session.fullWalkDone) {
        walkDomElements(root, inspectElement, {
          maxNodes: 20000,
          skipSubtreeSet: session.opacityHiddenSet,
        });
        session.fullWalkDone = true;
        session.dirtyNodes.clear();
      } else {
        const candidates = [];
        for (const node of session.dirtyNodes) {
          candidates.push(node);
          if (candidates.length >= 2000) break;
        }
        session.dirtyNodes.clear();
        for (const node of Array.from(session.zeroRectNodes)) {
          if (candidates.length >= 2500) break;
          if (!node.isConnected) {
            session.zeroRectNodes.delete(node);
            continue;
          }
          candidates.push(node);
        }
        for (const el of candidates) {
          inspectElement(el);
        }
      }
    } catch {
      // Never abort capture on hostile DOM getters
    }

    for (const item of toMutate) {
      try {
        session.hiddenElements.push(item);
        item.el.style.setProperty(item.prop, item.val, 'important');
      } catch {
        // Ignore detached or read-only style targets
      }
    }
  }

  function ensureFullPageProgressPill(session) {
    if (!session) return null;
    if (session.pillHost && session.pillHost.isConnected && session.pillTextEl) {
      return { host: session.pillHost, pill: session.pillTextEl };
    }
    removeHostElement(FULLPAGE_PILL_HOST_ID);
    const vv = window.visualViewport;
    const vvScale = vv?.scale || 1;
    const topPx = Math.round((vv?.offsetTop || 0) + 14 / vvScale);
    const leftPx = Math.round((vv?.offsetLeft || 0) + (vv?.width || window.innerWidth || 320) / 2);
    const { host, shadow } = mountTopLayerHost(FULLPAGE_PILL_HOST_ID, {
      interactiveModalFallback: false,
      cssBounds: `top:${topPx}px !important;left:${leftPx}px !important;transform:translateX(-50%) scale(${1 / vvScale}) !important;transform-origin:top center !important;pointer-events:none !important;`,
    });
    const style = document.createElement('style');
    style.textContent = `
      .fp-pill {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 18px;
        font-variant-numeric: tabular-nums;
        color: #f3f4f6;
        background: rgba(20, 21, 24, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        padding: 6px 14px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
        white-space: nowrap;
        pointer-events: none;
        user-select: none;
      }
    `;
    const pill = document.createElement('div');
    pill.className = 'fp-pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    shadow.append(style, pill);
    session.pillHost = host;
    session.pillTextEl = pill;
    return { host, pill };
  }

  async function setFullPagePillState({ hidden = false, progressText = '' } = {}) {
    const session = fullPageSession;
    if (!session || session.cancelled) return { ok: true };
    const safeText = typeof progressText === 'string' ? progressText.slice(0, 120) : '';
    if (safeText) {
      const refs = ensureFullPageProgressPill(session);
      if (refs) {
        refs.pill.textContent = safeText;
      }
    }
    const host = session.pillHost;
    if (!host || !host.isConnected) return { ok: true };
    if (hidden) {
      try {
        if (typeof host.hidePopover === 'function') {
          host.hidePopover();
        }
      } catch {
        // Ignore if not an open popover
      }
      host.style.setProperty('display', 'none', 'important');
      // Wait for compositor repaint with document.hidden + timeout guard so pill never burns into PNG
      await waitNextPaint(0);
    } else {
      host.style.setProperty('display', 'block', 'important');
      try {
        if (typeof host.showPopover === 'function' && !host.matches(':popover-open')) {
          host.showPopover();
        }
      } catch {
        // Fallback fixed positioning already active
      }
    }
    return { ok: true };
  }

  function restoreFullPageSession() {
    const session = fullPageSession;
    fullPageSession = null;
    removeHostElement(FULLPAGE_PILL_HOST_ID);
    const existingStyle = document.getElementById(FULLPAGE_STYLE_ID);
    if (existingStyle) existingStyle.remove();

    if (!session) return;
    session.pillHost = null;
    session.pillTextEl = null;
    try {
      session.mutationObserver?.disconnect?.();
    } catch {
      // Ignore disconnect errors
    }
    session.mutationObserver = null;
    session.dirtyNodes?.clear?.();
    session.zeroRectNodes?.clear?.();
    if (session.onKeyDown) {
      window.removeEventListener('keydown', session.onKeyDown, true);
    }

    for (const entry of session.hiddenElements) {
      try {
        if (entry.prevValue) {
          entry.el.style.setProperty(entry.prop, entry.prevValue, entry.prevPriority);
        } else {
          entry.el.style.removeProperty(entry.prop);
        }
      } catch {
        // Ignore detached elements
      }
    }

    if (session.containerScrollbarPatched && session.element) {
      try {
        if (session.prevContainerScrollbar) {
          session.element.style.setProperty(
            'scrollbar-width',
            session.prevContainerScrollbar,
            session.prevContainerScrollbarPriority
          );
        } else {
          session.element.style.removeProperty('scrollbar-width');
        }
      } catch {
        // Ignore detached element
      }
    }

    scrollTargetInstant(session, session.origScrollX, session.origScrollY);
  }

  async function prepareFullPageCapture() {
    const support = checkRegionSupport();
    if (!support.ok) {
      return {
        ok: false,
        code: support.code,
        reason: support.reason.replace('Region selection', 'Full-page capture'),
      };
    }

    // Clear any leftover overlay, toast, or previous full-page state
    clearActiveOverlay();
    removeHostElement(TOAST_HOST_ID);
    restoreFullPageSession();

    const target = detectFullPageScrollTarget();
    const docEl = document.scrollingElement || document.documentElement;
    const origScrollX = target.isWindow
      ? window.scrollX ?? (docEl ? docEl.scrollLeft : 0)
      : target.element.scrollLeft;
    const origScrollY = target.isWindow
      ? window.scrollY ?? (docEl ? docEl.scrollTop : 0)
      : target.element.scrollTop;

    const style = document.createElement('style');
    style.id = FULLPAGE_STYLE_ID;
    style.textContent = `
      html, body, * {
        scroll-behavior: auto !important;
      }
      html::-webkit-scrollbar, body::-webkit-scrollbar {
        display: none !important;
      }
      html, body {
        scrollbar-width: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    const session = {
      element: target.element,
      isWindow: target.isWindow,
      origScrollX,
      origScrollY,
      hiddenElements: [],
      handledSet: new WeakSet(),
      opacityHiddenSet: new WeakSet(),
      slice0VisibleSet: new WeakSet(),
      dirtyNodes: new Set(),
      zeroRectNodes: new Set(),
      fullWalkDone: false,
      mutationObserver: null,
      pillHost: null,
      pillTextEl: null,
      cancelled: false,
      onKeyDown: null,
      containerScrollbarPatched: false,
      prevContainerScrollbar: '',
      prevContainerScrollbarPriority: '',
    };

    if (!session.isWindow && session.element instanceof HTMLElement) {
      session.prevContainerScrollbar = session.element.style.getPropertyValue('scrollbar-width');
      session.prevContainerScrollbarPriority =
        session.element.style.getPropertyPriority('scrollbar-width');
      session.element.style.setProperty('scrollbar-width', 'none', 'important');
      session.containerScrollbarPatched = true;
    }

    session.onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        session.cancelled = true;
        removeHostElement(FULLPAGE_PILL_HOST_ID);
        session.pillHost = null;
        session.pillTextEl = null;
        try {
          const maybePromise = chrome.runtime.sendMessage({ type: 'FULLPAGE_CANCEL' });
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch(() => {});
          }
        } catch {
          // Ignore messaging errors
        }
      }
    };
    window.addEventListener('keydown', session.onKeyDown, true);
    fullPageSession = session;

    // Scroll to top cleanly for slice 0
    scrollTargetInstant(session, origScrollX, 0);
    await waitNextPaint(40);
    snapshotSlice0StickyElements(session);
    attachFullPageMutationObserver(session);

    return {
      ok: true,
      ...readScrollMetrics(session),
      cancelled: session.cancelled,
    };
  }

  async function stepFullPageCapture({
    targetY = 0,
    hideFixed = false,
    progressText = '',
  } = {}) {
    const session = fullPageSession;
    if (!session) {
      return { ok: false, code: 'NO_FULLPAGE_SESSION' };
    }
    if (session.cancelled) {
      return { ok: true, cancelled: true, ...readScrollMetrics(session) };
    }

    if (progressText) {
      await setFullPagePillState({ hidden: false, progressText });
    }

    const safeY = Math.max(0, Math.round(Number(targetY) || 0));
    scrollTargetInstant(session, session.origScrollX, safeY);

    // Wait a brief frame after scroll so dynamic sticky/fixed wrappers settle before hiding
    await waitNextPaint(30);
    if (hideFixed && !session.cancelled) {
      hideFixedAndStickyElements(session);
    }

    return {
      ok: true,
      cancelled: session.cancelled,
      ...readScrollMetrics(session),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id && chrome?.runtime?.id && sender.id !== chrome.runtime.id) return;
    if (sender?.tab) return;
    if (!message || !message.type) return;

    if (message.type === 'START_REGION_SELECT') {
      const res = startRegionSelection();
      sendResponse(res);
      return;
    }

    if (message.type === 'FULLPAGE_PREPARE') {
      prepareFullPageCapture()
        .then((res) => sendResponse(res))
        .catch((err) =>
          sendResponse({
            ok: false,
            code: 'FULLPAGE_ERROR',
            reason: err?.message || 'Could not prepare full-page capture.',
          })
        );
      return true;
    }

    if (message.type === 'FULLPAGE_STEP') {
      stepFullPageCapture(message)
        .then((res) => sendResponse(res))
        .catch((err) =>
          sendResponse({
            ok: false,
            code: 'FULLPAGE_ERROR',
            reason: err?.message || 'Could not scroll page for capture.',
          })
        );
      return true;
    }

    if (message.type === 'FULLPAGE_PILL') {
      setFullPagePillState(message)
        .then((res) => sendResponse(res))
        .catch(() => sendResponse({ ok: true }));
      return true;
    }

    if (message.type === 'FULLPAGE_RESTORE') {
      restoreFullPageSession();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'HIDE_UI_FOR_CAPTURE') {
      const hadUi =
        Boolean(document.getElementById(OVERLAY_HOST_ID)) ||
        Boolean(document.getElementById(TOAST_HOST_ID)) ||
        Boolean(document.getElementById(FULLPAGE_PILL_HOST_ID));
      if (!hadUi) {
        sendResponse({ ok: true, removed: false });
        return;
      }
      if (toastDismissTimer) {
        clearTimeout(toastDismissTimer);
        toastDismissTimer = null;
      }
      clearActiveOverlay();
      removeHostElement(TOAST_HOST_ID);
      removeHostElement(FULLPAGE_PILL_HOST_ID);
      if (document.hidden) {
        sendResponse({ ok: true, removed: true });
        return;
      }
      let responded = false;
      const done = () => {
        if (responded) return;
        responded = true;
        sendResponse({ ok: true, removed: true });
      };
      const fallbackTimer = setTimeout(done, 120);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            clearTimeout(fallbackTimer);
            done();
          }, 20);
        });
      });
      return true;
    }

    if (message.type === 'SHOW_TOAST') {
      showToast(message.payload);
      sendResponse({ ok: true });
    }
  });
})();
