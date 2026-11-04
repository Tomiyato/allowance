// Injected into every page the recorder opens (evaluateOnNewDocument): CSS zoom, a visible cursor
// dot with click ripples, and eased scrolling helpers. Coordinates are viewport pixels, the same
// space as getBoundingClientRect() and puppeteer's page.mouse.
(() => {
  const Z = Number("__ZOOM__");
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const frame = () => new Promise((r) => requestAnimationFrame(r));

  function setup() {
    document.documentElement.style.zoom = String(Z);
    const style = document.createElement("style");
    style.textContent = `
      html::-webkit-scrollbar, *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      #__cursor { position: fixed; left: 0; top: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
        background: rgba(14, 59, 67, 0.62); border: 2.5px solid #fff; box-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
        z-index: 2147483647; pointer-events: none; transition: transform 0.12s ease, opacity 0.3s ease; }
      #__cursor.down { transform: scale(0.78); }
      .__ripple { position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
        border: 3px solid rgba(15, 118, 110, 0.85); z-index: 2147483646; pointer-events: none;
        animation: __ripple 0.55s ease-out forwards; }
      @keyframes __ripple { from { transform: scale(0.6); opacity: 1; } to { transform: scale(2.8); opacity: 0; } }
    `;
    document.head.appendChild(style);
    const c = document.createElement("div");
    c.id = "__cursor";
    document.documentElement.appendChild(c);
    const saved = JSON.parse(sessionStorage.getItem("__cur") || "null") ?? { x: 1180, y: 640 };
    place(saved.x, saved.y);
  }

  let pos = { x: 1180, y: 640 };
  function place(x, y) {
    pos = { x, y };
    const c = document.getElementById("__cursor");
    if (c) {
      c.style.left = `${x / Z}px`;
      c.style.top = `${y / Z}px`;
    }
    sessionStorage.setItem("__cur", JSON.stringify(pos));
  }

  async function moveTo(x, y, ms) {
    const from = { ...pos };
    const dist = Math.hypot(x - from.x, y - from.y);
    const dur = ms ?? Math.min(1100, Math.max(420, 300 + dist * 0.55));
    // A slight arc reads as a hand, not a robot.
    const bend = Math.min(60, dist * 0.12) * (x > from.x ? -1 : 1);
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = ease(t);
      const arc = Math.sin(Math.PI * k) * bend;
      place(from.x + (x - from.x) * k, from.y + (y - from.y) * k + arc);
      if (t >= 1) break;
      await frame();
    }
  }

  function ripple() {
    const c = document.getElementById("__cursor");
    c?.classList.add("down");
    setTimeout(() => c?.classList.remove("down"), 160);
    const r = document.createElement("div");
    r.className = "__ripple";
    r.style.left = `${pos.x / Z}px`;
    r.style.top = `${pos.y / Z}px`;
    document.documentElement.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }

  /** Viewport px per scrollTop unit (CSS zoom makes these differ). */
  function scrollRatio(el) {
    const s = el ?? document.scrollingElement;
    const probe = document.body;
    const before = probe.getBoundingClientRect().top;
    const y = s.scrollTop;
    s.scrollTop = y + 40;
    const moved = s.scrollTop - y;
    const after = probe.getBoundingClientRect().top;
    s.scrollTop = y;
    return moved ? (before - after) / moved : Z;
  }

  /** Eased scroll of the page by `dy` viewport px. */
  async function scrollByPx(dy, ms = 900) {
    const s = document.scrollingElement;
    const ratio = scrollRatio() || Z;
    const from = s.scrollTop;
    const max = s.scrollHeight - s.clientHeight;
    const to = Math.max(0, Math.min(max, from + dy / ratio));
    if (Math.abs(to - from) < 1) return 0;
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      s.scrollTop = from + (to - from) * ease(t);
      if (t >= 1) break;
      await frame();
    }
    return (to - from) * ratio;
  }

  /** Eased horizontal scroll of an element (AG Grid viewports). */
  async function scrollElX(el, to, ms = 900) {
    const from = el.scrollLeft;
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      el.scrollLeft = from + (to - from) * ease(t);
      el.dispatchEvent(new Event("scroll"));
      if (t >= 1) break;
      await frame();
    }
  }

  /** Camera push-in: scales .app about an origin that keeps `rect` inside the viewport. */
  function zoomTo(rect, s, ms) {
    const app = document.querySelector(".app");
    if (!app) return;
    const W = innerWidth, H = innerHeight, m = 24;
    const lim = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
    const ox = lim((s * rect.right - (W - m)) / (s - 1), (s * rect.left - m) / (s - 1), rect.left + rect.width / 2);
    const oy = lim((s * rect.bottom - (H - m)) / (s - 1), (s * rect.top - m) / (s - 1), rect.top + rect.height / 2);
    const ar = app.getBoundingClientRect();
    app.style.transformOrigin = `${(ox - ar.left) / Z}px ${(oy - ar.top) / Z}px`;
    app.style.transition = `transform ${ms}ms cubic-bezier(0.45, 0, 0.25, 1)`;
    app.style.transform = `scale(${s})`;
  }
  function zoomReset(ms) {
    const app = document.querySelector(".app");
    if (!app) return;
    app.style.transition = `transform ${ms}ms cubic-bezier(0.45, 0, 0.25, 1)`;
    app.style.transform = "scale(1)";
  }

  function cursorVisible(v) {
    const c = document.getElementById("__cursor");
    if (c) c.style.opacity = v ? "1" : "0";
  }

  window.__rec = { moveTo, ripple, place, cursorVisible, scrollByPx, scrollElX, zoomTo, zoomReset, get pos() { return pos; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
