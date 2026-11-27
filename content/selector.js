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
          <button type="button" class="hud-btn" id="full-page-btn" title="Capture full scrolling page (F)">
            <span>Full page</span>
            <kbd class="hud-kbd">F</kbd>
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
    const fullPageBtn = shadow.getElementById('full-page-btn');
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

    let dragBounds = null;
    let dragDpr = 1;
    let dragVScale = 1;
    let moveRafId = 0;
    let pendingMoveX = 0;
    let pendingMoveY = 0;

    function cancelMoveRaf() {
      if (moveRafId) {
        cancelAnimationFrame(moveRafId);
        moveRafId = 0;
      }
    }

    function updateBox(clientX, clientY) {
      const bounds = dragBounds || getVisibleBounds();
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

      const dpr = dragBounds ? dragDpr : window.devicePixelRatio || 1;
      const vScale = dragBounds ? dragVScale : window.visualViewport?.scale || 1;
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
      cancelMoveRaf();
      installTrailingClickShield();
      clearActiveOverlay();
      afterOverlayRepaint(35, () => {
        chrome.runtime
          .sendMessage({ type: 'CAPTURE_VISIBLE_FROM_OVERLAY' })
          .catch(() => {});
      });
    }

    function triggerFullPageCapture() {
      cancelMoveRaf();
      installTrailingClickShield();
      clearActiveOverlay();
      afterOverlayRepaint(35, () => {
        chrome.runtime
          .sendMessage({ type: 'CAPTURE_FULLPAGE_FROM_OVERLAY' })
          .catch(() => {});
      });
    }

    fullTabBtn.addEventListener('click', (e) => {
      stopEvent(e);
      triggerFullTabCapture();
    });

    fullPageBtn.addEventListener('click', (e) => {
      stopEvent(e);
      triggerFullPageCapture();
    });

    function onPointerDown(e) {
      if (hint.contains(e.target)) {
        e.stopPropagation();
        return;
      }
      stopEvent(e);
      if (e.button !== 0) {
        cancelMoveRaf();
        installTrailingClickShield();
        clearActiveOverlay();
        return;
      }
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      dragBounds = getVisibleBounds();
      dragDpr = window.devicePixelRatio || 1;
      dragVScale = window.visualViewport?.scale || 1;
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
      pendingMoveX = e.clientX;
      pendingMoveY = e.clientY;
      if (moveRafId) return;
      moveRafId = requestAnimationFrame(() => {
        moveRafId = 0;
        if (!isDragging) return;
        updateBox(pendingMoveX, pendingMoveY);
      });
    }

    function onPointerUp(e) {
      if (!isDragging) return;
      stopEvent(e);
      cancelMoveRaf();
      isDragging = false;
      dragBounds = null;
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
          message: 'Drag across an area, press Enter for full tab, or press F for full page.',
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
        if (shadow.activeElement === fullPageBtn || e.composedPath().includes(fullPageBtn)) {
          triggerFullPageCapture();
        } else {
          triggerFullTabCapture();
        }
        return;
      }
      if (
        (e.key === 'f' || e.key === 'F') &&
        !isDragging &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        stopEvent(e);
        triggerFullPageCapture();
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
      cancelMoveRaf();
      dragBounds = null;
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


  const FULLPAGE_PILL_HOST_ID = '__saveshot-fullpage-pill-host';
  globalThis.__saveShotClearOverlay = clearActiveOverlay;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id && chrome?.runtime?.id && sender.id !== chrome.runtime.id) return;
    if (sender?.tab) return;
    if (!message || !message.type) return;

    if (message.type === 'START_REGION_SELECT') {
      try {
        const res = startRegionSelection();
        sendResponse(res || { ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          code: 'REGION_ERROR',
          reason: err?.message || 'Region selection does not work on this page. Use "Visible Tab" instead.',
        });
      }
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
      try {
        showToast(message.payload);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          code: 'TOAST_ERROR',
          reason: err?.message || 'Could not display toast notification.',
        });
      }
    }
  });
})();
