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
    :host { all: initial; }
    .orb {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 46px;
      height: 46px;
      border-radius: 9999px;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 10px 30px rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.22);
      background: #888;
      transition: transform 120ms ease, filter 200ms ease, background 250ms ease;
    }
    .orb:hover { transform: scale(1.05); }
    .orb:active { transform: scale(0.98); }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 9999px;
      background: rgba(255,255,255,0.85);
      filter: blur(0.2px);
      opacity: 0.85;
    }

    .tooltip {
      position: fixed;
      z-index: 2147483647;
      padding: 6px 10px;
      border-radius: 10px;
      font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      color: rgba(255,255,255,0.92);
      background: rgba(10,10,10,0.85);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 120ms ease, transform 120ms ease;
      white-space: nowrap;
    }
    .tooltip.show { opacity: 1; transform: translateY(0); }

    .panel {
      position: fixed;
      z-index: 2147483647;
      width: 280px;
      border-radius: 16px;
      background: rgba(18,18,18,0.92);
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 18px 60px rgba(0,0,0,0.55);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      padding: 12px;
      display: none;
      font: 12.5px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      color: rgba(255,255,255,0.92);
    }
    .panel.show { display: block; }

    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { font-size: 13px; font-weight: 650; letter-spacing: 0.2px; }
    .sub { font-size: 12px; opacity: 0.78; }

    .ring {
      width: 34px;
      height: 34px;
      border-radius: 9999px;
      border: 3px solid rgba(255,255,255,0.18);
      background: transparent;
      box-shadow: inset 0 0 0 2px rgba(0,0,0,0.25);
    }

    .signals { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.10); }
    .signals ul { margin: 6px 0 0 0; padding-left: 16px; }
    .signals li { margin: 4px 0; opacity: 0.9; }

    .buttons { display: flex; gap: 8px; margin-top: 10px; }
    button {
      appearance: none;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.92);
      padding: 6px 8px;
      border-radius: 10px;
      cursor: pointer;
      font: 12px system-ui, -apple-system, Segoe UI, Roboto, Arial;
    }
    button:hover { background: rgba(255,255,255,0.10); }
  `;
  shadow.appendChild(style);

  const orb = document.createElement("div");
  orb.className = "orb";
  orb.setAttribute("role", "button");
  orb.setAttribute("aria-label", "Mood orb");

  const dot = document.createElement("div");
  dot.className = "dot";
  orb.appendChild(dot);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <div class="row">
      <div>
        <div class="title" id="moodTitle">Neutral</div>
        <div class="sub" id="moodSub">Confidence: 50%</div>
      </div>
      <div class="ring" id="moodRing"></div>
    </div>
    <div class="signals">
      <div class="sub">Signals</div>
      <ul id="moodSignals"></ul>
    </div>
    <div class="buttons">
      <button id="btnSnooze">Snooze 1h</button>
      <button id="btnHideSite">Hide here</button>
    </div>
  `;

  shadow.appendChild(orb);
  shadow.appendChild(tooltip);
  shadow.appendChild(panel);

  document.documentElement.appendChild(root);

  // --- position persistence ---
  const POS_KEY = "orbPosition";
  let pos = { right: 16, bottom: 16 };
  let dragging = false;
  let dragOffset = { x: 0, y: 0 };

  function applyPos() {
    orb.style.right = `${pos.right}px`;
    orb.style.bottom = `${pos.bottom}px`;
    // Panel anchored near orb
    positionPanel();
  }

  function positionPanel() {
    // Convert right/bottom to viewport coords
    const rect = orb.getBoundingClientRect();
    const panelW = 280;
    const panelH = 210;
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
    tooltip.style.top = `${Math.max(margin, rect.top - 34)}px`;
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
    if (open) positionPanel();
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

    const clampedLeft = Math.max(8, Math.min(newLeft, window.innerWidth - 54));
    const clampedTop = Math.max(8, Math.min(newTop, window.innerHeight - 54));

    pos.right = Math.round(window.innerWidth - clampedLeft - 46);
    pos.bottom = Math.round(window.innerHeight - clampedTop - 46);

    applyPos();
  });

  orb.addEventListener("pointerup", async (e) => {
    if (!dragging) return;
    dragging = false;
    await savePos();
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
    setPanel(!panelOpen);
  });

  orb.addEventListener("mouseenter", () => {
    // Will be updated with actual state below
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
  let moodState = { mood: "Neutral", confidence: 0.5, color: "#888", signals: [] };

  function render(state) {
    moodState = state || moodState;
    orb.style.background = `radial-gradient(circle at 30% 30%, rgba(255,255,255,0.35), rgba(0,0,0,0.25)), ${moodState.color}`;
    const ring = shadow.getElementById("moodRing");
    ring.style.borderColor = "rgba(255,255,255,0.18)";
    ring.style.boxShadow = `0 0 0 2px rgba(0,0,0,0.22), 0 0 18px ${moodState.color}55 inset`;

    shadow.getElementById("moodTitle").textContent = moodState.mood;
    shadow.getElementById("moodSub").textContent = `Confidence: ${Math.round((moodState.confidence || 0) * 100)}%`;

    const ul = shadow.getElementById("moodSignals");
    ul.innerHTML = "";
    (moodState.signals || []).forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      ul.appendChild(li);
    });
  }

  function currentTooltipText() {
    return `${moodState.mood} · ${Math.round((moodState.confidence || 0) * 100)}%`;
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
  }

  init().catch(() => {});
})();
