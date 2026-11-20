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
        .backdrop {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          cursor: crosshair;
          background: rgba(15, 23, 42, 0.35);
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
          background: rgba(15, 23, 42, 0.9);
          color: #f8fafc;
          font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          padding: 8px 16px;
          border-radius: 999px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          border: 1px solid rgba(255, 255, 255, 0.14);
          pointer-events: none;
          white-space: nowrap;
        }
        .selection {
          position: fixed;
          display: none;
          border: ${Math.max(1, 2 / vvScale)}px solid #1a73e8;
          background: transparent;
          box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.42);
          pointer-events: none;
        }
        .dimensions {
          position: fixed;
          display: none;
          transform: scale(${1 / vvScale});
          transform-origin: top left;
          background: #0f172a;
          color: #f8fafc;
          font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
          padding: 4px 8px;
          border-radius: 6px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
          pointer-events: none;
          white-space: nowrap;
        }
      </style>
      <div class="backdrop" id="backdrop">
        <div class="hint" id="hint">Drag to select screenshot area · Press Esc to cancel</div>
        <div class="selection" id="selection"></div>
        <div class="dimensions" id="dimensions"></div>
      </div>
    `;

    const backdrop = shadow.getElementById('backdrop');
    const hint = shadow.getElementById('hint');
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
      dimensionsEl.textContent = `${pxW} × ${pxH} px`;
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

    function onPointerDown(e) {
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
      hint.style.display = 'none';
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
          message: 'Drag across an area to capture a region screenshot.',
        });
        return;
      }

      // Wait for two paint frames + short settle so the compositor paints a clean frame without the overlay
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            chrome.runtime
              .sendMessage({
                type: 'REGION_SELECTED',
                selection: selectionPayload,
              })
              .catch(() => {});
          }, 35);
        });
      });
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        stopEvent(e);
        clearActiveOverlay();
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

    backdrop.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onCancelEvent, true);
    window.addEventListener('mousedown', stopEvent, true);
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
      window.removeEventListener('mousedown', stopEvent, true);
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
        ? `left:${Math.round(vv.offsetLeft + vv.width - 340 / vvScale)}px !important;top:${Math.round(
            vv.offsetTop + vv.height - 130 / vvScale
          )}px !important;`
        : 'bottom:20px !important;right:20px !important;';

    const { host, shadow } = mountTopLayerHost(TOAST_HOST_ID, {
      interactiveModalFallback: false,
      cssBounds: `${posCss}width:auto !important;height:auto !important;pointer-events:auto !important;`,
    });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .toast {
          width: 328px;
          transform: scale(${1 / vvScale});
          transform-origin: bottom right;
          background: #ffffff;
          color: #0f172a;
          border-radius: 12px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
          padding: 12px 14px;
          font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: slideIn 160ms ease-out;
        }
        @media (prefers-color-scheme: dark) {
          .toast {
            background: #1e293b;
            color: #f8fafc;
            border-color: rgba(255, 255, 255, 0.12);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
          }
          .sub { color: #cbd5e1; }
          .btn-secondary {
            background: #334155;
            color: #f8fafc;
            border-color: rgba(255, 255, 255, 0.12);
          }
          .btn-secondary:hover { background: #475569; }
          .close { color: #94a3b8; }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(10px) scale(${1 / vvScale}); }
          to { opacity: 1; transform: translateY(0) scale(${1 / vvScale}); }
        }
        .row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .thumb {
          width: 48px;
          height: 36px;
          object-fit: cover;
          border-radius: 6px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          flex-shrink: 0;
          background: #0f172a;
        }
        .spinner {
          width: 18px;
          height: 18px;
          border: 2.5px solid rgba(26, 115, 232, 0.25);
          border-top-color: #1a73e8;
          border-radius: 50%;
          animation: spin 700ms linear infinite;
          flex-shrink: 0;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .dot.success { background: #1e8e3e; }
        .dot.error { background: #d93025; }
        .dot.info { background: #1a73e8; }
        .body {
          flex: 1;
          min-width: 0;
        }
        .title {
          font-weight: 600;
          font-size: 13px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sub {
          font-size: 12px;
          color: #475569;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
        }
        .close {
          background: none;
          border: none;
          color: #64748b;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          padding: 2px 4px;
          align-self: flex-start;
        }
        .close:hover { opacity: 0.7; }
        .actions {
          display: flex;
          gap: 6px;
        }
        .btn {
          flex: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 6px 8px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          text-decoration: none;
          border: 1px solid transparent;
          white-space: nowrap;
          transition: background 120ms ease;
        }
        .btn-primary {
          background: #1a73e8;
          color: #ffffff;
        }
        .btn-primary:hover { background: #1557b0; }
        .btn-secondary {
          background: #f1f5f9;
          color: #0f172a;
          border-color: rgba(15, 23, 42, 0.08);
        }
        .btn-secondary:hover { background: #e2e8f0; }
      </style>
      <div class="toast" id="toast">
        <div class="row">
          <div id="leading"></div>
          <div class="body">
            <div class="title" id="title"></div>
            <div class="sub" id="message"></div>
          </div>
          <button class="close" id="close" aria-label="Dismiss">&times;</button>
        </div>
        <div class="actions" id="actions" style="display:none;"></div>
      </div>
    `;

    const leadingEl = shadow.getElementById('leading');
    const titleEl = shadow.getElementById('title');
    const msgEl = shadow.getElementById('message');
    const closeBtn = shadow.getElementById('close');
    const actionsEl = shadow.getElementById('actions');
    const toastEl = shadow.getElementById('toast');

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
    if (!message) msgEl.style.display = 'none';

    const dismissToast = () => {
      if (toastDismissTimer) {
        clearTimeout(toastDismissTimer);
        toastDismissTimer = null;
      }
      removeHostElement(TOAST_HOST_ID);
    };

    if (status === 'success' && safeHttpsLink) {
      actionsEl.style.display = 'flex';
      const defaultCopyLabel = canEdit ? 'Copy link' : 'Copy Drive link';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-primary';
      copyBtn.textContent = defaultCopyLabel;

      // Best-effort auto-copy when page has focus and setting is enabled
      if (autoCopyLink && document.hasFocus() && navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(safeHttpsLink)
          .then(() => {
            copyBtn.textContent = 'Link copied!';
            setTimeout(() => {
              copyBtn.textContent = defaultCopyLabel;
            }, 2000);
          })
          .catch(() => {});
      }

      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(safeHttpsLink);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = defaultCopyLabel;
          }, 1800);
        } catch {
          copyBtn.textContent = 'Copy failed';
        }
      });

      actionsEl.append(copyBtn);

      if (canEdit) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-secondary';
        editBtn.style.flex = '0.72';
        editBtn.textContent = 'Edit';
        editBtn.title = 'Annotate, redact, rotate, or rename in Google Drive';
        editBtn.addEventListener('click', () => {
          editBtn.disabled = true;
          chrome.runtime.sendMessage({ type: 'OPEN_LAST_CAPTURE_EDITOR' }, () => {
            void chrome.runtime.lastError;
            dismissToast();
          });
        });
        actionsEl.append(editBtn);
      }

      const openLink = document.createElement('a');
      openLink.className = 'btn btn-secondary';
      if (canEdit) openLink.style.flex = '0.78';
      openLink.href = safeHttpsLink;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.textContent = canEdit ? 'Open' : 'Open in Drive';

      actionsEl.append(openLink);
    } else if (status === 'error' && (hasFallback || fallbackDataUrl)) {
      actionsEl.style.display = 'flex';
      if (typeof fallbackDataUrl === 'string' && fallbackDataUrl.startsWith('data:image/')) {
        const saveLocalLink = document.createElement('a');
        saveLocalLink.className = 'btn btn-primary';
        saveLocalLink.href = fallbackDataUrl;
        saveLocalLink.download = fallbackFilename;
        saveLocalLink.textContent = 'Save PNG locally';
        actionsEl.append(saveLocalLink);
      } else {
        const saveBtn = document.createElement('button');
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

    const dismiss = () => {
      if (toastDismissTimer) {
        clearTimeout(toastDismissTimer);
        toastDismissTimer = null;
      }
      removeHostElement(TOAST_HOST_ID);
    };

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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'START_REGION_SELECT') {
      const res = startRegionSelection();
      sendResponse(res);
      return;
    }

    if (message.type === 'HIDE_UI_FOR_CAPTURE') {
      const hadUi =
        Boolean(document.getElementById(OVERLAY_HOST_ID)) ||
        Boolean(document.getElementById(TOAST_HOST_ID));
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
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => sendResponse({ ok: true, removed: true }), 20);
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
