(() => {
  if (globalThis.__saveShotFullPageLoaded) {
    return;
  }
  globalThis.__saveShotFullPageLoaded = true;

  const OVERLAY_HOST_ID = '__saveshot-overlay-host';
  const TOAST_HOST_ID = '__saveshot-toast-host';

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
    if (typeof globalThis.__saveShotClearOverlay === 'function') {
      globalThis.__saveShotClearOverlay();
      return;
    }
    removeHostElement(OVERLAY_HOST_ID);
  }

  function mountTopLayerHost(id, { cssBounds = '' } = {}) {
    const parentTarget =
      document.fullscreenElement instanceof HTMLElement
        ? document.fullscreenElement
        : document.documentElement;

    const ancestorZoom = Number(parentTarget.currentCSSZoom) || 1;
    const inverseZoom = ancestorZoom > 0 ? 1 / ancestorZoom : 1;

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
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const containerRect = {
      left,
      top,
      width: Math.max(1, Math.min(vpW - left, r.right - left)),
      height: Math.max(1, Math.min(vpH - top, r.bottom - top)),
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

  const FULLPAGE_SKIP_TAGS = new Set([
    'HEAD',
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'LINK',
    'META',
    'TITLE',
    'BASE',
  ]);
  const FULLPAGE_MAX_TRACKED = 2000;

  function isSaveShotHost(node) {
    return Boolean(
      node &&
        (node.id === OVERLAY_HOST_ID ||
          node.id === TOAST_HOST_ID ||
          node.id === FULLPAGE_PILL_HOST_ID)
    );
  }

  function isScrollContainerOrAncestor(session, el) {
    if (!el) return true;
    if (el === document.documentElement || el === document.body) return true;
    return el === session.element || Boolean(session.element && el.contains(session.element));
  }

  function isTransparentBackground(cs) {
    if (!cs) return false;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return false;
    const bg = String(cs.backgroundColor || '').trim().toLowerCase();
    if (!bg || bg === 'transparent') return true;
    return /(?:,\s*0(?:\.0+)?\s*\)|\/\s*0(?:\.0+)?%?\s*\))$/.test(bg);
  }

  function walkDomElementsBfs(root, visit, { maxNodes = 20000, skipSubtreeSet = null } = {}) {
    if (!root) return;
    const queue = [root];
    let head = 0;
    let visited = 0;

    while (head < queue.length && visited < maxNodes) {
      const node = queue[head++];
      if (!node) continue;

      if (node instanceof Element) {
        if (
          node.namespaceURI === 'http://www.w3.org/2000/svg' ||
          node.tagName === 'SVG' ||
          node.tagName === 'svg' ||
          FULLPAGE_SKIP_TAGS.has(node.tagName) ||
          isSaveShotHost(node) ||
          (skipSubtreeSet && skipSubtreeSet.has(node))
        ) {
          continue;
        }
        if (node instanceof HTMLElement) {
          visited += 1;
          visit(node);
          if (skipSubtreeSet && skipSubtreeSet.has(node)) {
            continue;
          }
        }
        if (node.shadowRoot) {
          queue.push(node.shadowRoot);
        }
      }

      let child = node.firstElementChild;
      while (child) {
        queue.push(child);
        child = child.nextElementSibling;
      }
    }
  }

  function saveAndSetInlineImportant(session, el, prop, val) {
    if (!el || !el.style) return;
    let propMap = session.inlineRestoreMap.get(el);
    if (!propMap) {
      if (session.inlineRestoreMap.size >= FULLPAGE_MAX_TRACKED) return;
      propMap = new Map();
      session.inlineRestoreMap.set(el, propMap);
    }
    if (!propMap.has(prop)) {
      propMap.set(prop, {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      });
    }
    el.style.setProperty(prop, val, 'important');
  }

  function applyUnstickBatch(session, items) {
    if (!items.length) return false;
    let changed = false;
    const applied = [];

    // Pass 1: apply stylesheet attribute tags cleanly in batch
    for (const item of items) {
      const el = item.el;
      if (!el || !el.isConnected) continue;
      if (session.attrTrackedSet.size >= FULLPAGE_MAX_TRACKED && !session.attrTrackedSet.has(el)) {
        continue;
      }
      const mode = item.preserveTopPx !== null ? 'preserve-top' : '1';
      try {
        if (el.getAttribute('data-saveshot-unstick') !== mode) {
          el.setAttribute('data-saveshot-unstick', mode);
          changed = true;
        }
        if (item.preserveTopPx !== null) {
          saveAndSetInlineImportant(session, el, 'top', `${item.preserveTopPx}px`);
          changed = true;
        }
        session.attrTrackedSet.add(el);
        session.unstuckSet.add(el);
        applied.push(item);
      } catch {
        // Ignore read-only/detached targets
      }
    }

    // Pass 2: verify and apply inline !important fallback only for Shadow DOM or page inline !important
    const needFallback = [];
    for (const item of applied) {
      try {
        const inShadow = item.el.getRootNode() instanceof ShadowRoot;
        if (inShadow || getComputedStyle(item.el).position !== 'relative') {
          needFallback.push(item);
        }
      } catch {
        // Ignore hostile getters
      }
    }
    for (const item of needFallback) {
      try {
        saveAndSetInlineImportant(session, item.el, 'position', 'relative');
        if (item.preserveTopPx === null) {
          saveAndSetInlineImportant(session, item.el, 'top', 'auto');
        }
        saveAndSetInlineImportant(session, item.el, 'bottom', 'auto');
        saveAndSetInlineImportant(session, item.el, 'left', 'auto');
        saveAndSetInlineImportant(session, item.el, 'right', 'auto');
        saveAndSetInlineImportant(session, item.el, 'isolation', 'isolate');
        session.inlineEnforcedUnstick.add(item.el);
        changed = true;
      } catch {
        // Ignore style errors
      }
    }

    return changed;
  }

  function applyHideBatch(session, elements) {
    if (!elements.length) return false;
    let changed = false;
    const applied = [];

    // Pass 1: apply stylesheet attribute tags cleanly in batch
    for (const el of elements) {
      if (!el || !el.isConnected) continue;
      // Never hide an un-stuck in-flow sticky element (e.g. X.com right sidebar)
      if (session.unstuckSet.has(el)) continue;
      if (session.attrTrackedSet.size >= FULLPAGE_MAX_TRACKED && !session.attrTrackedSet.has(el)) {
        continue;
      }
      try {
        if (el.getAttribute('data-saveshot-hide') !== '1') {
          el.setAttribute('data-saveshot-hide', '1');
          changed = true;
        }
        session.attrTrackedSet.add(el);
        session.opacityHiddenSet.add(el);
        applied.push(el);
      } catch {
        // Ignore read-only/detached targets
      }
    }

    // Pass 2: verify and apply inline !important fallback only for Shadow DOM or page inline !important
    const needFallback = [];
    for (const el of applied) {
      try {
        const inShadow = el.getRootNode() instanceof ShadowRoot;
        if (inShadow || getComputedStyle(el).opacity !== '0') {
          needFallback.push(el);
        }
      } catch {
        // Ignore hostile getters
      }
    }
    for (const el of needFallback) {
      try {
        saveAndSetInlineImportant(session, el, 'opacity', '0');
        saveAndSetInlineImportant(session, el, 'transition-property', 'none');
        session.inlineEnforcedHide.add(el);
        changed = true;
      } catch {
        // Ignore style errors
      }
    }

    return changed;
  }

  function shouldSkipUnstickSticky(session, el, cs) {
    if (isScrollContainerOrAncestor(session, el)) return true;
    if (cs.display === 'none' || cs.display === 'contents') return true;
    // Skip horizontal-only sticky (e.g. frozen table columns) during vertical capture
    if (cs.top === 'auto' && cs.bottom === 'auto') return true;

    // Walk ancestors up to scroll container to skip sticky inside fixed rails or inner scrollers
    let anc = getComposedParent(el);
    let hops = 0;
    while (anc && anc !== document.documentElement && anc !== session.element && hops < 24) {
      hops += 1;
      const acs = getComputedStyle(anc);
      if (acs.position === 'fixed') {
        return true;
      }
      if (
        (acs.overflowY === 'auto' || acs.overflowY === 'scroll' || acs.overflowY === 'overlay') &&
        anc.scrollHeight > anc.clientHeight + 2
      ) {
        return true;
      }
      anc = getComposedParent(anc);
    }
    return false;
  }

  function unstickStickyElementsBeforeSlice0(session) {
    if (!session) return false;
    const vpH = window.innerHeight || document.documentElement.clientHeight || 1;
    const root = document.documentElement;
    if (!root) return false;

    const candidates = [];
    const candidateSet = new Set();

    try {
      walkDomElementsBfs(
        root,
        (el) => {
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed') {
            session.initialFixedCandidates?.add(el);
            return;
          }
          if (cs.position !== 'sticky' && cs.position !== '-webkit-sticky') return;
          if (shouldSkipUnstickSticky(session, el, cs)) return;

          let hasStickyAncestor = false;
          let p = getComposedParent(el);
          while (p && p !== document.documentElement) {
            if (candidateSet.has(p)) {
              hasStickyAncestor = true;
              break;
            }
            p = getComposedParent(p);
          }

          let rectBeforeTop = null;
          if (!hasStickyAncestor && cs.top !== 'auto') {
            const rect = el.getBoundingClientRect();
            if (rect.height > 0 && rect.bottom > 0 && rect.top < vpH) {
              rectBeforeTop = rect.top;
            }
          }

          candidateSet.add(el);
          candidates.push({ el, preserveTopPx: null, rectBeforeTop });
        },
        { maxNodes: 20000 }
      );
      session.slice0BfsCompleted = true;
    } catch {
      // Never abort capture on hostile DOM getters
    }

    if (!candidates.length) return false;
    applyUnstickBatch(session, candidates);

    // Check top-level top-sticky elements that were actively pushed down by a fixed header at y=0
    const preserveItems = [];
    const maxClearance = Math.round(vpH * 0.35);
    for (const item of candidates) {
      if (item.rectBeforeTop === null) continue;
      try {
        const afterTop = item.el.getBoundingClientRect().top;
        const delta = Math.round(item.rectBeforeTop - afterTop);
        if (delta >= 2 && delta <= maxClearance) {
          preserveItems.push({ el: item.el, preserveTopPx: delta });
        }
      } catch {
        // Ignore layout read errors
      }
    }
    if (preserveItems.length) {
      applyUnstickBatch(session, preserveItems);
    }
    return true;
  }

  function classifyFullViewportFixed(session, el, cs, vpW, vpH) {
    // Protect interactive full-viewport iframes (e.g. Figma/Storybook/enterprise embeds)
    if (el.tagName === 'IFRAME' && cs.pointerEvents !== 'none') {
      return { action: 'skip', floatingChildren: [] };
    }
    // Protect misdetected full-viewport scrollable app shells
    if (
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') &&
      el.scrollHeight > el.clientHeight + 20
    ) {
      return { action: 'skip', floatingChildren: [] };
    }
    // Protect negative-z fixed background wallpapers and direct media backdrops
    const zNum = cs.zIndex !== 'auto' ? Number(cs.zIndex) : 0;
    if (Number.isFinite(zNum) && zNum < 0) {
      return { action: 'skip', floatingChildren: [] };
    }
    if (el.tagName === 'CANVAS' || el.tagName === 'IMG' || el.tagName === 'VIDEO') {
      return { action: 'skip', floatingChildren: [] };
    }

    const transparent = isTransparentBackground(cs);
    if (!transparent && cs.pointerEvents !== 'none') {
      return { action: 'skip', floatingChildren: [] };
    }

    // Inspect shallow children to distinguish Tailwind/Framer/Vercel fixed background wrappers
    // from transparent portal layers (e.g. X.com #layers, Radix/MUI/Intercom overlay roots).
    let hasFullBgChild = false;
    const floatingChildren = [];
    const queue = [];
    let head = 0;
    let c = el.firstElementChild;
    while (c) {
      queue.push(c);
      c = c.nextElementSibling;
    }
    let checked = 0;
    while (head < queue.length && checked < 60) {
      const child = queue[head++];
      checked += 1;
      if (!(child instanceof Element) || isSaveShotHost(child) || FULLPAGE_SKIP_TAGS.has(child.tagName)) {
        continue;
      }
      const cRect = child.getBoundingClientRect();
      const cFull = cRect.width >= vpW * 0.85 && cRect.height >= vpH * 0.85;
      const cStyle = getComputedStyle(child);
      if (cStyle.display === 'none') continue;
      if (cFull) {
        const cZ = cStyle.zIndex !== 'auto' ? Number(cStyle.zIndex) : 0;
        const isVisualBg =
          child.tagName === 'CANVAS' ||
          child.tagName === 'IMG' ||
          child.tagName === 'VIDEO' ||
          child.tagName === 'SVG' ||
          child.namespaceURI === 'http://www.w3.org/2000/svg' ||
          !isTransparentBackground(cStyle);
        if (isVisualBg && (!Number.isFinite(cZ) || cZ <= 0)) {
          hasFullBgChild = true;
        } else if (child instanceof HTMLElement && child.firstElementChild) {
          let gc = child.firstElementChild;
          while (gc) {
            queue.push(gc);
            gc = gc.nextElementSibling;
          }
        }
      } else if (
        child instanceof HTMLElement &&
        cRect.width > 0 &&
        cRect.height > 0 &&
        !isScrollContainerOrAncestor(session, child) &&
        !session.unstuckSet.has(child)
      ) {
        floatingChildren.push(child);
      }
    }

    if (hasFullBgChild) {
      return { action: 'children-only', floatingChildren };
    }
    if (transparent) {
      return { action: 'hide-self', floatingChildren: [] };
    }
    return { action: 'skip', floatingChildren: [] };
  }

  function getProbePoints(session, vpW, vpH) {
    let L = 0;
    let T = 0;
    let W = vpW;
    let H = vpH;
    if (!session.isWindow && session.element) {
      const r = session.element.getBoundingClientRect();
      L = Math.max(0, r.left);
      T = Math.max(0, r.top);
      W = Math.max(1, Math.min(vpW - L, r.width));
      H = Math.max(1, Math.min(vpH - T, r.height));
    }
    const R = L + W;
    const B = T + H;
    const clampX = (x) => Math.max(L + 4, Math.min(R - 4, Math.round(x)));
    const clampY = (y) => Math.max(T + 4, Math.min(B - 4, Math.round(y)));

    return [
      // Bottom-right cluster (catches stacked X.com Grok + Chat FABs & chat launchers)
      [clampX(R - 24), clampY(B - 24)],
      [clampX(R - 36), clampY(B - 84)],
      [clampX(R - 36), clampY(B - 144)],
      [clampX(R - 96), clampY(B - 24)],
      // Bottom-left & bottom-center
      [clampX(L + 24), clampY(B - 24)],
      [clampX(L + 24), clampY(B - 84)],
      [clampX(L + W / 2), clampY(B - 24)],
      // Top edge
      [clampX(L + 24), clampY(T + 24)],
      [clampX(L + W / 2), clampY(T + 20)],
      [clampX(R - 24), clampY(T + 24)],
      // Mid-right & mid-left edges (feedback tabs / floating extension side docks)
      [clampX(R - 16), clampY(T + H * 0.5)],
      [clampX(R - 16), clampY(T + H * 0.72)],
      [clampX(L + 16), clampY(T + H * 0.5)],
      [clampX(L + 16), clampY(T + H * 0.72)],
    ];
  }

  function collectElementsAtPoint(x, y) {
    const out = [];
    const seen = new Set();
    const drill = (root, depth) => {
      if (!root || depth > 5 || typeof root.elementsFromPoint !== 'function') return;
      let hits;
      try {
        hits = root.elementsFromPoint(x, y);
      } catch {
        return;
      }
      for (const el of hits) {
        if (!el || seen.has(el) || isSaveShotHost(el)) continue;
        seen.add(el);
        out.push(el);
        if (el.shadowRoot && typeof el.shadowRoot.elementsFromPoint === 'function') {
          drill(el.shadowRoot, depth + 1);
        }
      }
    };
    drill(document, 0);
    return out;
  }

  function getComposedParent(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode?.();
    if (root instanceof ShadowRoot && root.host instanceof HTMLElement) {
      return root.host;
    }
    return null;
  }

  function probePerimeterOverlays(session, { hidePinned = false, inspectElement = null, toHide = null } = {}) {
    if (!session) return;
    const vpW = window.innerWidth || document.documentElement.clientWidth || 1;
    const vpH = window.innerHeight || document.documentElement.clientHeight || 1;
    const currentY = readScrollMetrics(session).actualY;
    const points = getProbePoints(session, vpW, vpH);

    for (const [x, y] of points) {
      const hits = collectElementsAtPoint(x, y);
      for (const hit of hits) {
        if (!(hit instanceof HTMLElement) || isScrollContainerOrAncestor(session, hit)) continue;
        if (session.opacityHiddenSet.has(hit) || session.unstuckSet.has(hit)) continue;

        if (hidePinned && inspectElement) {
          let anc = hit;
          let hops = 0;
          let hiddenByAncestor = false;
          while (anc && hops < 12) {
            if (isScrollContainerOrAncestor(session, anc) || isSaveShotHost(anc)) break;
            if (session.opacityHiddenSet.has(anc)) {
              hiddenByAncestor = true;
              break;
            }
            inspectElement(anc);
            if (session.opacityHiddenSet.has(anc)) {
              hiddenByAncestor = true;
              break;
            }
            anc = getComposedParent(anc);
            hops += 1;
          }
          if (hiddenByAncestor || session.opacityHiddenSet.has(hit) || session.unstuckSet.has(hit)) {
            continue;
          }
        }

        const rect = hit.getBoundingClientRect();
        const prev = session.probeSeenMap.get(hit);
        if (!prev) {
          session.probeSeenMap.set(hit, {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            scrollY: currentY,
          });
          continue;
        }

        if (!hidePinned || !toHide || Math.abs(currentY - prev.scrollY) < 150) {
          continue;
        }

        // Case A: Closed Shadow DOM floating host (hit point outside host's own rect & no light children)
        const hitOutsideRect =
          x < rect.left - 2 || x > rect.right + 2 || y < rect.top - 2 || y > rect.bottom + 2;
        if (hitOutsideRect && hit.childElementCount === 0) {
          toHide.push(hit);
          continue;
        }

        // Case B: Viewport-pinned element by geometry (JS scroll-synced widget, absolute child of portal, iframe FAB)
        const isSubViewport = rect.width > 0 && rect.height > 0 && (rect.width < vpW * 0.85 || rect.height < vpH * 0.85);
        const stayedPinned =
          Math.abs(rect.top - prev.top) <= 6 && Math.abs(rect.left - prev.left) <= 6;
        if (isSubViewport && stayedPinned) {
          // Climb to highest viewport-pinned <85% ancestor so we hide the full widget container, not just a leaf icon
          let best = hit;
          let anc = getComposedParent(hit);
          let hops = 0;
          while (anc && hops < 10) {
            if (
              isScrollContainerOrAncestor(session, anc) ||
              isSaveShotHost(anc) ||
              session.unstuckSet.has(anc)
            ) {
              break;
            }
            const aRect = anc.getBoundingClientRect();
            const aSubVp =
              aRect.width > 0 &&
              aRect.height > 0 &&
              (aRect.width < vpW * 0.85 || aRect.height < vpH * 0.85);
            const aPrev = session.probeSeenMap.get(anc);
            const aPinned =
              aPrev &&
              Math.abs(currentY - aPrev.scrollY) >= 150 &&
              Math.abs(aRect.top - aPrev.top) <= 6 &&
              Math.abs(aRect.left - aPrev.left) <= 6;
            if (aSubVp && aPinned) {
              best = anc;
            } else {
              break;
            }
            anc = getComposedParent(anc);
            hops += 1;
          }
          toHide.push(best);
        }
      }
    }
  }

  function attachFullPageMutationObserver(session) {
    if (!session || typeof MutationObserver !== 'function') return;
    const root = document.documentElement;
    if (!root) return;
    const MAX_DIRTY = 2000;
    const recordDirty = (node, allowHiddenStyleCheck = false) => {
      if (!node || session.dirtyNodes.size >= MAX_DIRTY) return;
      if (!(node instanceof HTMLElement)) return;
      if (FULLPAGE_SKIP_TAGS.has(node.tagName) || isSaveShotHost(node)) return;
      if (!allowHiddenStyleCheck && session.opacityHiddenSet.has(node)) return;
      session.dirtyNodes.add(node);
    };
    try {
      const observer = new MutationObserver((mutations) => {
        if (!session || session.cancelled) return;
        for (const m of mutations) {
          if (m.type === 'attributes') {
            if (m.attributeName === 'class') {
              const t = m.target;
              if (
                t === document.documentElement ||
                t === document.body ||
                t === session.element ||
                (t instanceof HTMLElement &&
                  (t.parentElement === document.body ||
                    (session.element instanceof HTMLElement && t.contains(session.element))))
              ) {
                session.ancestorClassMutated = true;
              }
            }
            if (session.dirtyNodes.size < MAX_DIRTY) {
              recordDirty(m.target, m.attributeName === 'style');
            }
          } else if (m.type === 'childList' && m.addedNodes?.length) {
            for (const added of m.addedNodes) {
              if (session.dirtyNodes.size >= MAX_DIRTY) break;
              if (!(added instanceof HTMLElement)) continue;
              if (FULLPAGE_SKIP_TAGS.has(added.tagName) || isSaveShotHost(added)) continue;
              recordDirty(added);
              if (session.dirtyNodes.size < MAX_DIRTY && added.childElementCount > 0) {
                walkDomElementsBfs(
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
    if (!session) return false;
    const vpW = window.innerWidth || document.documentElement.clientWidth || 1;
    const vpH = window.innerHeight || document.documentElement.clientHeight || 1;
    const root = document.documentElement;
    if (!root) return false;

    const toHide = [];
    const toUnstick = [];
    const toReEnforceUnstick = [];
    const toReEnforceHide = [];
    const MAX_ZERO_RECT = 500;

    const inspectElement = (el) => {
      if (!(el instanceof HTMLElement) || !el.isConnected) return;
      if (isSaveShotHost(el) || isScrollContainerOrAncestor(session, el)) return;

      // Preserve precedence for already-unstuck sticky elements (never reclassify as opacity: 0)
      if (session.unstuckSet.has(el)) {
        if (getComputedStyle(el).position !== 'relative') {
          toReEnforceUnstick.push(el);
        }
        return;
      }
      if (session.opacityHiddenSet.has(el)) {
        if (getComputedStyle(el).opacity !== '0') {
          toReEnforceHide.push(el);
        }
        return;
      }

      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (cs.display === 'none' || cs.display === 'contents') {
        // Keep display:none fixed elements tracked in case scroll reveals them on later slices
        if (pos === 'fixed' && cs.display === 'none' && session.zeroRectNodes.size < MAX_ZERO_RECT) {
          session.zeroRectNodes.add(el);
        }
        return;
      }

      if (pos !== 'fixed' && pos !== 'sticky' && pos !== '-webkit-sticky') return;

      // Un-stick any newly mounted/scrolled sticky elements back into natural document flow
      if (pos === 'sticky' || pos === '-webkit-sticky') {
        if (!shouldSkipUnstickSticky(session, el, cs)) {
          toUnstick.push({ el, preserveTopPx: null });
        }
        return;
      }

      // position: fixed handling
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        const clippedOnZeroAxis =
          (rect.width <= 0 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip')) ||
          (rect.height <= 0 && (cs.overflowY === 'hidden' || cs.overflowY === 'clip'));
        // Zero-box fixed portal anchor (e.g. X.com #layers height: 0 with overflowing absolute FABs)
        if (el.childElementCount > 0 && !clippedOnZeroAxis) {
          toHide.push(el);
          session.zeroRectNodes.delete(el);
          return;
        }
        if (session.zeroRectNodes.size < MAX_ZERO_RECT) {
          session.zeroRectNodes.add(el);
        }
        return;
      }
      session.zeroRectNodes.delete(el);

      const isFullViewportWrapper = rect.width >= vpW * 0.85 && rect.height >= vpH * 0.85;
      if (isFullViewportWrapper) {
        const decision = classifyFullViewportFixed(session, el, cs, vpW, vpH);
        if (decision.action === 'hide-self') {
          toHide.push(el);
        } else if (decision.action === 'children-only') {
          for (const child of decision.floatingChildren) {
            toHide.push(child);
          }
        }
        return;
      }

      toHide.push(el);
    };

    try {
      // 1. Re-verify any inline-enforced nodes in case JS scroll handlers clobbered inline !important
      for (const el of session.inlineEnforcedUnstick) {
        if (el.isConnected && getComputedStyle(el).position !== 'relative') {
          toReEnforceUnstick.push(el);
        }
      }
      for (const el of session.inlineEnforcedHide) {
        if (el.isConnected && getComputedStyle(el).opacity !== '0') {
          toReEnforceHide.push(el);
        }
      }

      // 2. Reuse Slice 0 fixed candidates + incremental dirty nodes when safe; fall back to
      //    a full BFS only if Slice 0 BFS didn't run or html/body class mutated during scroll
      if (session.ancestorClassMutated || (!session.fullWalkDone && !session.slice0BfsCompleted)) {
        walkDomElementsBfs(root, inspectElement, {
          maxNodes: 20000,
          skipSubtreeSet: session.opacityHiddenSet,
        });
        session.fullWalkDone = true;
        session.ancestorClassMutated = false;
        session.initialFixedCandidates?.clear?.();
        session.dirtyNodes.clear();
      } else {
        const seen = new Set();
        if (!session.fullWalkDone) {
          session.fullWalkDone = true;
          if (session.initialFixedCandidates?.size) {
            for (const node of session.initialFixedCandidates) {
              if (!seen.has(node)) {
                seen.add(node);
                inspectElement(node);
              }
            }
            session.initialFixedCandidates.clear();
          }
        }
        let inspectedDirty = 0;
        for (const node of session.dirtyNodes) {
          if (inspectedDirty >= 2000) break;
          if (!seen.has(node)) {
            seen.add(node);
            inspectElement(node);
            inspectedDirty += 1;
          }
        }
        session.dirtyNodes.clear();
        let inspectedZero = 0;
        for (const node of Array.from(session.zeroRectNodes)) {
          if (inspectedZero >= 500) break;
          if (!node.isConnected) {
            session.zeroRectNodes.delete(node);
            continue;
          }
          if (!seen.has(node)) {
            seen.add(node);
            inspectElement(node);
            inspectedZero += 1;
          }
        }
      }

      // 3. CSS Top Layer elements (:popover-open, dialog:modal) ignore ancestor opacity: 0
      try {
        const topLayers = document.querySelectorAll(':popover-open, dialog:modal');
        for (const tl of topLayers) {
          if (
            tl instanceof HTMLElement &&
            !isSaveShotHost(tl) &&
            !isScrollContainerOrAncestor(session, tl) &&
            !session.opacityHiddenSet.has(tl)
          ) {
            toHide.push(tl);
          }
        }
      } catch {
        // Older engines without :popover-open selector support
      }

      // 4. Perimeter scroll-invariance probe (catches JS-synced widgets, deep portals, closed Shadow DOM hosts)
      probePerimeterOverlays(session, { hidePinned: true, inspectElement, toHide });
    } catch {
      // Never abort capture on hostile DOM getters
    }

    let mutated = false;
    if (toUnstick.length) {
      if (applyUnstickBatch(session, toUnstick)) mutated = true;
    }
    if (toHide.length) {
      if (applyHideBatch(session, toHide)) mutated = true;
    }
    for (const el of toReEnforceUnstick) {
      try {
        saveAndSetInlineImportant(session, el, 'position', 'relative');
        if (el.getAttribute('data-saveshot-unstick') !== 'preserve-top') {
          saveAndSetInlineImportant(session, el, 'top', 'auto');
        }
        saveAndSetInlineImportant(session, el, 'bottom', 'auto');
        saveAndSetInlineImportant(session, el, 'left', 'auto');
        saveAndSetInlineImportant(session, el, 'right', 'auto');
        saveAndSetInlineImportant(session, el, 'isolation', 'isolate');
        session.inlineEnforcedUnstick.add(el);
        mutated = true;
      } catch {
        // Ignore style errors
      }
    }
    for (const el of toReEnforceHide) {
      try {
        saveAndSetInlineImportant(session, el, 'opacity', '0');
        saveAndSetInlineImportant(session, el, 'transition-property', 'none');
        session.inlineEnforcedHide.add(el);
        mutated = true;
      } catch {
        // Ignore style errors
      }
    }

    return mutated;
  }

  function ensureFullPageProgressPill(session) {
    if (!session) return null;
    if (session.pillHost && session.pillHost.isConnected && session.pillTextEl) {
      return { host: session.pillHost, pill: session.pillTextEl };
    }
    removeHostElement(FULLPAGE_PILL_HOST_ID);
    const { host, shadow } = mountTopLayerHost(FULLPAGE_PILL_HOST_ID, {
      interactiveModalFallback: false,
      cssBounds:
        'inset:auto !important;top:10px !important;left:0 !important;right:0 !important;bottom:auto !important;width:100% !important;height:auto !important;display:flex !important;justify-content:center !important;pointer-events:none !important;',
    });
    const style = document.createElement('style');
    style.textContent = `
      .fp-pill {
        box-sizing: border-box;
        max-width: calc(100% - 24px);
        direction: ltr;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 18px;
        font-variant-numeric: tabular-nums;
        color: #f3f4f6;
        background: rgba(20, 21, 24, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 999px;
        padding: 5px 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

  function measureFullPagePillGeometry(session) {
    const host = session?.pillHost;
    const pill = session?.pillTextEl;
    if (!host || !host.isConnected || !pill) {
      return {
        pillClearBottomCss: 58,
        isTopLayer: false,
        vvScale: window.visualViewport?.scale || 1,
        vvOffsetTop: Math.abs(window.visualViewport?.offsetTop || 0),
      };
    }
    const hostRect = host.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const bottomCss = Math.max(hostRect.bottom, pillRect.bottom);
    // Skia box-shadow (0 2px 8px) paints up to 2 + ceil(1.5 * 8) = 14px below border-box; add 4px AA cushion
    const pillClearBottomCss =
      pillRect.height > 0 && bottomCss > 0 ? Math.ceil(bottomCss) + 18 : 58;
    const vv = window.visualViewport;
    let isTopLayer = false;
    try {
      isTopLayer = typeof host.matches === 'function' && host.matches(':popover-open');
    } catch {
      isTopLayer = false;
    }
    return {
      pillClearBottomCss,
      isTopLayer,
      vvScale: vv?.scale || 1,
      vvOffsetTop: Math.abs(vv?.offsetTop || 0),
    };
  }

  async function setFullPagePillState({
    hidden = false,
    progressText = '',
    postSettleHide = false,
    sessionToken = '',
    prevScrollY = null,
    allowStaticIfClear = false,
  } = {}) {
    const session = fullPageSession;
    if (!session) {
      return { ok: false, code: 'NO_FULLPAGE_SESSION' };
    }
    if (session.token && sessionToken !== session.token) {
      return { ok: false, code: 'FULLPAGE_SESSION_MISMATCH' };
    }
    if (session.cancelled) {
      return { ok: true, cancelled: true, sessionToken: session.token };
    }

    const safeText = typeof progressText === 'string' ? progressText.slice(0, 120) : '';
    let pillTextChanged = false;
    if (safeText) {
      const refs = ensureFullPageProgressPill(session);
      if (refs && session.lastPillText !== safeText) {
        refs.pill.textContent = safeText;
        session.lastPillText = safeText;
        pillTextChanged = true;
      }
    }

    let didMutateDom = false;
    if (postSettleHide && !session.cancelled) {
      didMutateDom = hideFixedAndStickyElements(session);
    }

    const liveMetrics = readScrollMetrics(session);
    const host = session.pillHost;
    let shouldHideNow = Boolean(hidden);
    let measuredClearBottom = session.lastMeasuredClearBottom || 58;
    let geom = null;

    if (host && host.isConnected) {
      geom = measureFullPagePillGeometry(session);
      measuredClearBottom = geom.pillClearBottomCss;

      if (allowStaticIfClear && !shouldHideNow) {
        const liveDeltaCss =
          typeof prevScrollY === 'number' && Number.isFinite(prevScrollY)
            ? Math.max(0, liveMetrics.actualY - prevScrollY)
            : 0;
        const containerTop =
          liveMetrics.isInnerContainer && liveMetrics.containerRect
            ? liveMetrics.containerRect.top
            : 0;
        const cropTopViewportCss =
          containerTop + Math.max(0, liveMetrics.scrollStepHeight - liveDeltaCss);
        const canKeepStatic =
          geom.isTopLayer &&
          geom.vvScale <= 1.01 &&
          geom.vvOffsetTop <= 1 &&
          liveMetrics.scrollStepHeight >= 260 &&
          cropTopViewportCss >= geom.pillClearBottomCss;
        if (!canKeepStatic) {
          shouldHideNow = true;
        }
      }
    }

    let didHidePill = false;
    if (host && host.isConnected) {
      if (shouldHideNow) {
        try {
          if (typeof host.hidePopover === 'function') {
            host.hidePopover();
          }
        } catch {
          // Ignore if not an open popover
        }
        host.style.setProperty('display', 'none', 'important');
        session.pillVisible = false;
        didHidePill = true;
      } else {
        const needsShow =
          !session.pillVisible ||
          host.style.getPropertyValue('display') !== 'flex' ||
          (typeof host.showPopover === 'function' && !geom?.isTopLayer);
        if (needsShow) {
          host.style.setProperty('display', 'flex', 'important');
          try {
            if (typeof host.showPopover === 'function' && !host.matches(':popover-open')) {
              host.showPopover();
            }
          } catch {
            // Fallback fixed positioning already active
          }
          measuredClearBottom = measureFullPagePillGeometry(session).pillClearBottomCss;
        }
        session.pillVisible = true;
        session.lastMeasuredClearBottom = measuredClearBottom;
      }
    }

    // Flush a single compositor paint whenever either the pill was hidden or overlays were updated
    if (didHidePill || didMutateDom) {
      await waitNextPaint(0);
    }
    return {
      ok: true,
      sessionToken: session.token,
      cancelled: session.cancelled,
      didHidePill,
      pillClearBottomCss: measuredClearBottom,
      metrics: liveMetrics,
    };
  }

  function restoreFullPageSession({ expectedToken = '', force = false } = {}) {
    const session = fullPageSession;
    if (!force && session && session.token && expectedToken !== session.token) {
      return;
    }
    fullPageSession = null;
    removeHostElement(FULLPAGE_PILL_HOST_ID);
    const existingStyle = document.getElementById(FULLPAGE_STYLE_ID);

    if (!session) {
      if (existingStyle) existingStyle.remove();
      return;
    }
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
    session.initialFixedCandidates?.clear?.();
    session.inlineEnforcedUnstick?.clear?.();
    session.inlineEnforcedHide?.clear?.();
    if (session.onKeyDown) {
      window.removeEventListener('keydown', session.onKeyDown, true);
    }

    // Suppress transitions ONLY on modified elements and scroll-snap on scrollers across restore
    // so elements snap back to opacity: 1 immediately without invalidating 20,000 untouched nodes.
    const restoringEls = [];
    if (existingStyle) {
      existingStyle.textContent =
        'html, body, [data-saveshot-scroller="1"] { scroll-behavior: auto !important; scroll-snap-type: none !important; }' +
        '[data-saveshot-restoring="1"], [data-saveshot-restoring="1"] * { transition-property: none !important; }';
    }

    if (session.attrTrackedSet) {
      for (const el of session.attrTrackedSet) {
        try {
          if (existingStyle && el.isConnected) {
            el.setAttribute('data-saveshot-restoring', '1');
            restoringEls.push(el);
          }
          el.removeAttribute('data-saveshot-unstick');
          el.removeAttribute('data-saveshot-hide');
        } catch {
          // Ignore detached elements
        }
      }
      session.attrTrackedSet.clear();
    }

    if (session.inlineRestoreMap) {
      for (const [el, propMap] of session.inlineRestoreMap.entries()) {
        try {
          if (existingStyle && el.isConnected && !el.hasAttribute('data-saveshot-restoring')) {
            el.setAttribute('data-saveshot-restoring', '1');
            restoringEls.push(el);
          }
        } catch {
          // Ignore detached elements
        }
        for (const [prop, orig] of propMap.entries()) {
          try {
            if (orig.value) {
              el.style.setProperty(prop, orig.value, orig.priority);
            } else {
              el.style.removeProperty(prop);
            }
          } catch {
            // Ignore detached elements
          }
        }
      }
      session.inlineRestoreMap.clear();
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

    try {
      scrollTargetInstant(session, session.origScrollX, session.origScrollY);
      if (existingStyle) {
        void document.documentElement?.offsetHeight;
      }
    } catch {
      // Best-effort scroll restore before mandatory DOM/style cleanup
    } finally {
      if (existingStyle) {
        try {
          existingStyle.remove();
        } catch {
          // Ignore detached style tag
        }
      }
      for (const el of restoringEls) {
        try {
          el.removeAttribute('data-saveshot-restoring');
        } catch {
          // Ignore detached elements
        }
      }
      if (session.scrollerAttrTagged && session.element) {
        try {
          session.element.removeAttribute('data-saveshot-scroller');
        } catch {
          // Ignore detached element
        }
      }
    }

    try {
      const target = session.isWindow ? window : session.element;
      target?.dispatchEvent?.(new Event('scroll'));
    } catch {
      // Ignore synthetic scroll event errors
    }
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
    restoreFullPageSession({ force: true });

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
      html, body, [data-saveshot-scroller="1"] {
        scroll-behavior: auto !important;
        scroll-snap-type: none !important;
      }
      html::-webkit-scrollbar, body::-webkit-scrollbar {
        display: none !important;
      }
      html, body {
        scrollbar-width: none !important;
      }
      [data-saveshot-unstick="1"] {
        position: relative !important;
        top: auto !important;
        bottom: auto !important;
        left: auto !important;
        right: auto !important;
        isolation: isolate !important;
      }
      [data-saveshot-unstick="preserve-top"] {
        position: relative !important;
        bottom: auto !important;
        left: auto !important;
        right: auto !important;
        isolation: isolate !important;
      }
      [data-saveshot-hide="1"] {
        opacity: 0 !important;
        transition-property: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    const sessionToken =
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const session = {
      token: sessionToken,
      element: target.element,
      isWindow: target.isWindow,
      origScrollX,
      origScrollY,
      attrTrackedSet: new Set(),
      inlineRestoreMap: new Map(),
      unstuckSet: new WeakSet(),
      opacityHiddenSet: new WeakSet(),
      inlineEnforcedUnstick: new Set(),
      inlineEnforcedHide: new Set(),
      probeSeenMap: new WeakMap(),
      initialFixedCandidates: new Set(),
      dirtyNodes: new Set(),
      zeroRectNodes: new Set(),
      slice0BfsCompleted: false,
      ancestorClassMutated: false,
      fullWalkDone: false,
      mutationObserver: null,
      pillHost: null,
      pillTextEl: null,
      pillVisible: false,
      lastPillText: '',
      lastMeasuredClearBottom: 58,
      cancelled: false,
      onKeyDown: null,
      scrollerAttrTagged: false,
      containerScrollbarPatched: false,
      prevContainerScrollbar: '',
      prevContainerScrollbarPriority: '',
    };

    if (session.element instanceof HTMLElement) {
      session.element.setAttribute('data-saveshot-scroller', '1');
      session.scrollerAttrTagged = true;
    }

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
          const maybePromise = chrome.runtime.sendMessage({
            type: 'FULLPAGE_CANCEL',
            sessionToken: session.token,
          });
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

    // Scroll to top cleanly for slice 0, un-stick sticky elements into natural flow,
    // and capture baseline perimeter probe before slice 0 is snapped.
    scrollTargetInstant(session, origScrollX, 0);
    await waitNextPaint(40);
    const unstuckAny = unstickStickyElementsBeforeSlice0(session);
    if (unstuckAny) {
      await waitNextPaint(0);
    }
    probePerimeterOverlays(session, { hidePinned: false });
    attachFullPageMutationObserver(session);

    return {
      ok: true,
      sessionToken: session.token,
      ...readScrollMetrics(session),
      cancelled: session.cancelled,
    };
  }

  async function stepFullPageCapture({
    targetY = 0,
    hideFixed = false,
    progressText = '',
    sessionToken = '',
  } = {}) {
    const session = fullPageSession;
    if (!session) {
      return { ok: false, code: 'NO_FULLPAGE_SESSION' };
    }
    if (session.token && sessionToken !== session.token) {
      return { ok: false, code: 'FULLPAGE_SESSION_MISMATCH' };
    }
    if (session.cancelled) {
      return { ok: true, sessionToken: session.token, cancelled: true, ...readScrollMetrics(session) };
    }

    if (progressText) {
      await setFullPagePillState({ hidden: false, progressText, sessionToken: session.token });
    }

    // Floor rather than round up so fractional scroll coordinates never shrink top overlap
    const safeY = Math.max(0, Math.floor(Number(targetY) || 0));
    scrollTargetInstant(session, session.origScrollX, safeY);

    // Wait a brief frame after scroll so dynamic sticky/fixed wrappers settle before hiding
    await waitNextPaint(30);
    if (hideFixed && !session.cancelled) {
      hideFixedAndStickyElements(session);
    }

    return {
      ok: true,
      sessionToken: session.token,
      cancelled: session.cancelled,
      ...readScrollMetrics(session),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id && chrome?.runtime?.id && sender.id !== chrome.runtime.id) return;
    if (sender?.tab) return;
    if (!message || !message.type) return;

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
        .catch(() => sendResponse({ ok: false, code: 'FULLPAGE_PILL_ERROR' }));
      return true;
    }

    if (message.type === 'FULLPAGE_RESTORE') {
      restoreFullPageSession({ expectedToken: message.sessionToken || '' });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'HIDE_UI_FOR_CAPTURE' && !globalThis.__saveShotContentLoaded) {
      const hadUi = Boolean(document.getElementById(FULLPAGE_PILL_HOST_ID));
      if (!hadUi) {
        sendResponse({ ok: true, removed: false });
        return;
      }
      removeHostElement(FULLPAGE_PILL_HOST_ID);
      if (document.hidden) {
        sendResponse({ ok: true, removed: true });
        return;
      }
      waitNextPaint(20).then(() => sendResponse({ ok: true, removed: true }));
      return true;
    }
  });
})();
