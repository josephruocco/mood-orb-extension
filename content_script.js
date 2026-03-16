// Injects orb + popover panel into each page, updates from service worker messages.

(() => {
  // Avoid injecting on chrome-internal pages (content scripts won't run there anyway)
  if (!document || !document.documentElement) return;

  const ORB_ID = "mood-orb-root";

  if (document.getElementById(ORB_ID)) return;

  const root = document.createElement("div");
  root.id = ORB_ID;

  root.attachShadow({ mode: "open" });
  const shadow = root.shadowRoot;

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      color-scheme: dark;
      --orb-color: #888888;
      --orb-rgb: 136, 136, 136;
      --orb-shadow: rgba(136, 136, 136, 0.42);
      --panel-bg: rgba(13, 16, 24, 0.86);
      --panel-border: rgba(255,255,255,0.12);
    }
    .orb {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 58px;
      height: 58px;
      border-radius: 9999px;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      cursor: pointer;
      user-select: none;
      overflow: hidden;
      isolation: isolate;
      box-shadow:
        0 18px 45px rgba(0,0,0,0.34),
        0 0 0 1px rgba(255,255,255,0.16),
        0 0 40px var(--orb-shadow);
      border: 1px solid rgba(255,255,255,0.22);
      background:
        radial-gradient(circle at 30% 28%, rgba(255,255,255,0.95), rgba(255,255,255,0.22) 18%, rgba(255,255,255,0) 44%),
        radial-gradient(circle at 68% 74%, rgba(0,0,0,0.36), rgba(0,0,0,0) 42%),
        radial-gradient(circle at 50% 50%, rgba(var(--orb-rgb), 0.95), rgba(var(--orb-rgb), 0.82) 45%, rgba(12,16,24,0.92) 100%);
      transition: transform 160ms ease, filter 240ms ease, box-shadow 240ms ease, background 240ms ease;
      animation: orbFloat 4.5s ease-in-out infinite;
    }
    .orb.docked {
      filter: saturate(0.92);
    }
    .orb:hover {
      transform: scale(1.06) translateY(-1px);
      box-shadow:
        0 22px 52px rgba(0,0,0,0.38),
        0 0 0 1px rgba(255,255,255,0.18),
        0 0 56px var(--orb-shadow);
    }
    .orb:active { transform: scale(0.98); }

    .orb::before {
      content: "";
      position: absolute;
      inset: 6px;
      border-radius: 9999px;
      background: radial-gradient(circle at 36% 34%, rgba(255,255,255,0.42), rgba(255,255,255,0.08) 36%, rgba(255,255,255,0) 60%);
      z-index: 0;
    }

    .orb::after {
      content: "";
      position: absolute;
      inset: -10px;
      border-radius: 9999px;
      background: radial-gradient(circle, rgba(var(--orb-rgb), 0.22), rgba(var(--orb-rgb), 0) 65%);
      z-index: 0;
      filter: blur(6px);
      opacity: 0.95;
      animation: orbPulse 2.8s ease-in-out infinite;
    }

    .halo {
      position: absolute;
      inset: 10px;
      border-radius: 9999px;
      border: 1px solid rgba(255,255,255,0.24);
      z-index: 1;
      opacity: 0.42;
      box-shadow: inset 0 0 18px rgba(255,255,255,0.1);
    }

    .tooltip {
      position: fixed;
      z-index: 2147483647;
      padding: 8px 11px;
      border-radius: 999px;
      font: 11.5px/1.2 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      letter-spacing: 0.02em;
      color: rgba(255,255,255,0.92);
      background: rgba(10,12,18,0.9);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 120ms ease, transform 120ms ease;
      white-space: nowrap;
    }
    .tooltip.show { opacity: 1; transform: translateY(0); }

    .wakeZone {
      position: fixed;
      z-index: 2147483646;
      width: 38px;
      height: 38px;
      padding: 0;
      appearance: none;
      border: 0;
      border-radius: 999px;
      background: transparent;
      cursor: pointer;
      display: none;
    }
    .wakeZone.show { display: block; }

    .panel {
      position: fixed;
      z-index: 2147483647;
      width: 320px;
      border-radius: 22px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0)),
        var(--panel-bg);
      border: 1px solid var(--panel-border);
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      backdrop-filter: blur(18px) saturate(120%);
      -webkit-backdrop-filter: blur(18px) saturate(120%);
      padding: 14px;
      display: none;
      font: 12.5px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      color: rgba(255,255,255,0.92);
    }
    .panel.show { display: block; }

    .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .eyebrow {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: rgba(255,255,255,0.54);
      margin-bottom: 6px;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.05;
    }
    .sub { font-size: 12px; opacity: 0.76; }
    .summary {
      margin-top: 8px;
      font-size: 12.5px;
      color: rgba(255,255,255,0.84);
    }

    .ring {
      width: 42px;
      height: 42px;
      border-radius: 9999px;
      border: 2px solid rgba(255,255,255,0.16);
      background:
        radial-gradient(circle at 30% 30%, rgba(255,255,255,0.32), rgba(255,255,255,0) 48%),
        radial-gradient(circle at 50% 50%, rgba(var(--orb-rgb), 0.34), rgba(0,0,0,0.14) 72%);
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,0.08),
        0 0 18px rgba(var(--orb-rgb), 0.25);
    }

    .meter {
      margin-top: 12px;
      padding: 10px 11px;
      border-radius: 14px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .meterRow {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-size: 11.5px;
      color: rgba(255,255,255,0.72);
    }
    .bar {
      height: 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.09);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      width: 50%;
      border-radius: inherit;
      background: linear-gradient(90deg, rgba(var(--orb-rgb), 0.55), rgba(var(--orb-rgb), 0.98));
      box-shadow: 0 0 18px rgba(var(--orb-rgb), 0.34);
      transition: width 220ms ease, background 220ms ease;
    }

    .signals {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .signalsHead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .signals ul {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 7px;
    }
    .signals li {
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.88);
    }

    .buttons { display: flex; gap: 8px; margin-top: 12px; }
    button {
      appearance: none;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.92);
      padding: 8px 10px;
      border-radius: 12px;
      cursor: pointer;
      font: 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      transition: background 140ms ease, transform 140ms ease, border-color 140ms ease;
    }
    button:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.18);
      transform: translateY(-1px);
    }

    @keyframes orbPulse {
      0%, 100% { transform: scale(0.96); opacity: 0.74; }
      50% { transform: scale(1.08); opacity: 1; }
    }

    @keyframes orbFloat {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-2px); }
    }

    @media (prefers-reduced-motion: reduce) {
      .orb, .orb::after { animation: none; }
      .orb, .fill, button, .tooltip { transition: none; }
    }
  `;
  shadow.appendChild(style);

  const orb = document.createElement("div");
  orb.className = "orb";
  orb.setAttribute("role", "button");
  orb.setAttribute("aria-label", "Mood orb");

  const halo = document.createElement("div");
  halo.className = "halo";
  orb.appendChild(halo);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";

  const wakeZone = document.createElement("button");
  wakeZone.className = "wakeZone";
  wakeZone.setAttribute("type", "button");
  wakeZone.setAttribute("aria-label", "Bring back mood orb");

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <div class="row">
      <div>
        <div class="eyebrow">Mood Orb</div>
        <div class="title" id="moodTitle">Neutral</div>
        <div class="summary" id="moodSummary">Waiting for a little more browsing context.</div>
      </div>
      <div class="ring" id="moodRing"></div>
    </div>
    <div class="meter">
      <div class="meterRow">
        <span id="moodSub">Confidence 50%</span>
        <span id="moodUpdated">Just now</span>
      </div>
      <div class="bar"><div class="fill" id="moodFill"></div></div>
    </div>
    <div class="signals">
      <div class="signalsHead">
        <div class="sub">Signals</div>
      </div>
      <ul id="moodSignals"></ul>
    </div>
    <div class="buttons">
      <button id="btnSnooze">Snooze 1h</button>
      <button id="btnHideSite">Hide here</button>
    </div>
  `;

  shadow.appendChild(orb);
  shadow.appendChild(tooltip);
  shadow.appendChild(wakeZone);
  shadow.appendChild(panel);

  document.documentElement.appendChild(root);

  // --- position persistence ---
  const POS_KEY = "orbPosition";
  let pos = { right: 16, bottom: 16 };
  let dragging = false;
  let dragOffset = { x: 0, y: 0 };
  let docked = false;
  let dockCorner = "bottom-right";
  let dockTimer = null;
  const ORB_SIZE = 58;
  const ORB_MARGIN = 16;
  const DOCK_VISIBLE_SLICE = 7;
  const DOCK_DELAY_MS = 2200;

  function applyPos() {
    orb.style.right = `${pos.right}px`;
    orb.style.bottom = `${pos.bottom}px`;
    updateDockCorner();
    applyDockState();
    // Panel anchored near orb
    positionPanel();
  }

  function updateDockCorner() {
    const left = window.innerWidth - pos.right - ORB_SIZE;
    const top = window.innerHeight - pos.bottom - ORB_SIZE;
    const horizontal = left + ORB_SIZE / 2 < window.innerWidth / 2 ? "left" : "right";
    const vertical = top + ORB_SIZE / 2 < window.innerHeight / 2 ? "top" : "bottom";
    dockCorner = `${vertical}-${horizontal}`;
  }

  function dockTransformForCorner(corner) {
    const hiddenOffset = ORB_SIZE - DOCK_VISIBLE_SLICE;
    if (corner === "top-left") return `translate(${-hiddenOffset}px, ${-hiddenOffset}px)`;
    if (corner === "top-right") return `translate(${hiddenOffset}px, ${-hiddenOffset}px)`;
    if (corner === "bottom-left") return `translate(${-hiddenOffset}px, ${hiddenOffset}px)`;
    return `translate(${hiddenOffset}px, ${hiddenOffset}px)`;
  }

  function applyDockState() {
    orb.classList.toggle("docked", docked);
    if (docked) {
      orb.style.transform = dockTransformForCorner(dockCorner);
      orb.style.animation = "none";
    } else {
      orb.style.transform = "";
      orb.style.animation = "";
    }
    positionWakeZone();
  }

  function positionWakeZone() {
    const edgeInset = 4;
    const size = 38;
    wakeZone.style.left = "";
    wakeZone.style.right = "";
    wakeZone.style.top = "";
    wakeZone.style.bottom = "";

    if (dockCorner.includes("left")) {
      wakeZone.style.left = `${edgeInset}px`;
    } else {
      wakeZone.style.right = `${edgeInset}px`;
    }

    if (dockCorner.includes("top")) {
      wakeZone.style.top = `${edgeInset}px`;
    } else {
      wakeZone.style.bottom = `${edgeInset}px`;
    }

    wakeZone.style.width = `${size}px`;
    wakeZone.style.height = `${size}px`;
    wakeZone.classList.toggle("show", docked);
  }

  function setDocked(nextDocked) {
    docked = nextDocked;
    applyDockState();
  }

  function cancelDockTimer() {
    if (dockTimer) {
      clearTimeout(dockTimer);
      dockTimer = null;
    }
  }

  function scheduleDock() {
    cancelDockTimer();
    if (panelOpen || dragging || root.style.display === "none") return;
    dockTimer = setTimeout(() => {
      setDocked(true);
    }, DOCK_DELAY_MS);
  }

  function wakeOrb() {
    cancelDockTimer();
    if (docked) setDocked(false);
    scheduleDock();
  }

  function positionPanel() {
    // Convert right/bottom to viewport coords
    const rect = orb.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelW = panelRect.width || 320;
    const panelH = panelRect.height || 280;
    const margin = 10;

    // Try above-left of orb by default
    let left = rect.left - panelW + rect.width;
    let top = rect.top - panelH - margin;

    // Clamp into viewport
    left = Math.max(margin, Math.min(left, window.innerWidth - panelW - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - panelH - margin));

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    // Tooltip near orb
    tooltip.style.left = `${Math.max(margin, rect.left - 10)}px`;
    tooltip.style.top = `${Math.max(margin, rect.top - 38)}px`;
  }

  async function loadPos() {
    try {
      const data = await chrome.storage.local.get([POS_KEY]);
      if (data && data[POS_KEY]) pos = data[POS_KEY];
      applyPos();
    } catch (_) {
      applyPos();
    }
  }

  async function savePos() {
    try {
      await chrome.storage.local.set({ [POS_KEY]: pos });
    } catch (_) {}
  }

  // --- show/hide controls ---
  let panelOpen = false;

  function setPanel(open) {
    panelOpen = open;
    panel.classList.toggle("show", open);
    if (open) {
      wakeOrb();
      positionPanel();
      return;
    }
    scheduleDock();
  }

  // Click outside closes panel
  function onDocPointerDown(e) {
    if (!panelOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(panel) || path.includes(orb)) return;
    setPanel(false);
  }

  // Tooltip
  let tooltipTimer = null;
  function showTooltip(text) {
    tooltip.textContent = text;
    wakeOrb();
    positionPanel();
    tooltip.classList.add("show");
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => tooltip.classList.remove("show"), 900);
  }

  // Drag
  orb.addEventListener("pointerdown", (e) => {
    // Left click / primary pointer only
    if (e.button !== 0) return;

    // If user intends to click (short), drag won’t really move
    dragging = true;
    wakeOrb();
    orb.setPointerCapture(e.pointerId);

    const rect = orb.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
  });

  orb.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    // Compute new position in terms of right/bottom
    const newLeft = e.clientX - dragOffset.x;
    const newTop = e.clientY - dragOffset.y;

    const clampedLeft = Math.max(8, Math.min(newLeft, window.innerWidth - 66));
    const clampedTop = Math.max(8, Math.min(newTop, window.innerHeight - 66));

    pos.right = Math.round(window.innerWidth - clampedLeft - 58);
    pos.bottom = Math.round(window.innerHeight - clampedTop - 58);

    applyPos();
  });

  orb.addEventListener("pointerup", async (e) => {
    if (!dragging) return;
    dragging = false;
    await savePos();
    scheduleDock();
  });

  // Click toggles panel (but only if not dragging much)
  let lastDown = { x: 0, y: 0, t: 0 };
  orb.addEventListener("pointerdown", (e) => {
    lastDown = { x: e.clientX, y: e.clientY, t: Date.now() };
  });

  orb.addEventListener("click", (e) => {
    const dt = Date.now() - lastDown.t;
    const dx = Math.abs(e.clientX - lastDown.x);
    const dy = Math.abs(e.clientY - lastDown.y);
    const isClick = dt < 350 && dx < 6 && dy < 6;

    if (!isClick) return;
    wakeOrb();
    setPanel(!panelOpen);
  });

  orb.addEventListener("mouseenter", () => {
    // Will be updated with actual state below
    showTooltip(currentTooltipText());
  });
  orb.addEventListener("pointerenter", () => wakeOrb());
  orb.addEventListener("focus", () => wakeOrb());

  wakeZone.addEventListener("click", () => {
    wakeOrb();
    showTooltip(currentTooltipText());
  });

  window.addEventListener("resize", () => applyPos());
  document.addEventListener("pointerdown", onDocPointerDown, true);

  // --- "Hide on this site" + snooze (local-only behaviors) ---
  const HIDE_KEY = "hiddenSites";
  const SNOOZE_KEY = "snoozeUntil";

  async function isHiddenHere() {
    const host = location.hostname.replace(/^www\./, "");
    const data = await chrome.storage.local.get([HIDE_KEY, SNOOZE_KEY]);
    const hidden = data[HIDE_KEY] || [];
    const snoozeUntil = data[SNOOZE_KEY] || 0;
    if (Date.now() < snoozeUntil) return true;
    return hidden.includes(host);
  }

  async function applyVisibility() {
    const hidden = await isHiddenHere();
    root.style.display = hidden ? "none" : "block";
    if (hidden) {
      cancelDockTimer();
      setDocked(false);
    } else {
      scheduleDock();
    }
  }

  shadow.getElementById("btnHideSite").addEventListener("click", async () => {
    const host = location.hostname.replace(/^www\./, "");
    const data = await chrome.storage.local.get([HIDE_KEY]);
    const hidden = new Set(data[HIDE_KEY] || []);
    hidden.add(host);
    await chrome.storage.local.set({ [HIDE_KEY]: Array.from(hidden) });
    setPanel(false);
    await applyVisibility();
  });

  shadow.getElementById("btnSnooze").addEventListener("click", async () => {
    const oneHour = Date.now() + 60 * 60 * 1000;
    await chrome.storage.local.set({ [SNOOZE_KEY]: oneHour });
    setPanel(false);
    await applyVisibility();
  });

  // --- mood state rendering ---
  let moodState = {
    mood: "Neutral",
    confidence: 0.5,
    color: "#888",
    summary: "Waiting for a little more browsing context.",
    signals: []
  };

  function hexToRgb(hex) {
    const clean = (hex || "").replace("#", "");
    if (clean.length !== 6) return { r: 136, g: 136, b: 136 };
    const value = Number.parseInt(clean, 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255
    };
  }

  function timeAgo(updatedAt) {
    if (!updatedAt) return "Just now";
    const deltaSeconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
    if (deltaSeconds < 10) return "Just now";
    if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
    const deltaMinutes = Math.round(deltaSeconds / 60);
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    const deltaHours = Math.round(deltaMinutes / 60);
    return `${deltaHours}h ago`;
  }

  function render(state) {
    moodState = state || moodState;
    const { r, g, b } = hexToRgb(moodState.color);
    root.style.setProperty("--orb-color", moodState.color || "#888888");
    root.style.setProperty("--orb-rgb", `${r}, ${g}, ${b}`);
    root.style.setProperty("--orb-shadow", `rgba(${r}, ${g}, ${b}, 0.42)`);

    const ring = shadow.getElementById("moodRing");
    ring.style.borderColor = "rgba(255,255,255,0.16)";
    ring.style.boxShadow = `inset 0 0 0 1px rgba(255,255,255,0.08), 0 0 18px rgba(${r}, ${g}, ${b}, 0.28)`;

    shadow.getElementById("moodTitle").textContent = moodState.mood;
    shadow.getElementById("moodSummary").textContent =
      moodState.summary || "Waiting for a little more browsing context.";
    shadow.getElementById("moodSub").textContent = `Confidence ${Math.round((moodState.confidence || 0) * 100)}%`;
    shadow.getElementById("moodUpdated").textContent = timeAgo(moodState.updatedAt);
    shadow.getElementById("moodFill").style.width = `${Math.round((moodState.confidence || 0) * 100)}%`;

    const ul = shadow.getElementById("moodSignals");
    ul.innerHTML = "";
    (moodState.signals || []).forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      ul.appendChild(li);
    });

    shadow.getElementById("moodUpdated").textContent = timeAgo(moodState.updatedAt);
  }

  function currentTooltipText() {
    return `${moodState.mood} · ${Math.round((moodState.confidence || 0) * 100)}% confidence`;
  }

  // Listen for background updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "MOOD_UPDATE") {
      render(msg.payload);
    }
  });

  // Initial load: pull last computed mood
  async function init() {
    await loadPos();
    await applyVisibility();

    try {
      const data = await chrome.storage.local.get(["moodState"]);
      if (data?.moodState) render(data.moodState);
    } catch (_) {
      render(moodState);
    }

    scheduleDock();
  }

  init().catch(() => {});
})();
