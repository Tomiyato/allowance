// Devpost gallery screenshots: drives a running Ribbon instance through the demo list in one fresh
// session and saves docs/gallery/01-gift-list.png … 06-envelopes.png, 3000×2000 (3:2, each ≤ 5 MB):
//
//   01-gift-list.png        the demo list and the AI-drafted envelopes in the people editor
//   02-paypal-approval.png  PayPal's own sandbox approval page for the $200.00 authorization
//   03-gift-plan.png        Agent page, the Gift plan after "Shop my whole gift list": Mom waiting
//                           for an OK, the others bought with their PayPal capture IDs
//   04-hijack-blocked.png   "Simulate a hijacked agent": the red-team card, blocked by the gift list
//   05-ledger.png           Ledger: the AG Grid gift-list grid on top of the ledger grid
//   06-envelopes.png        the active gift list with a meter per person's envelope
//
// Each shot is the browser viewport (1500×956 CSS px at 2×) under a slim browser bar that shows the
// page's real URL, so 02 reads www.sandbox.paypal.com. 00-cover.png is rendered separately.
//
// Usage (hosted demo, real PayPal sandbox rail, PAYMENT_MODE=authorization):
//   BASE_URL=https://allowance-cpp0.onrender.com node scripts/screenshots.mjs
// Usage (local):
//   npm run build && PORT=3150 PRODUCT_SOURCE=channel3 DEMO_INJECTION=1 PAYMENT_MODE=authorization npm start
//   node scripts/screenshots.mjs     # in a second terminal
//
// "Approve $200.00 with PayPal" logs in to the PayPal sandbox as PAYPAL_BUYER_EMAIL /
// PAYPAL_BUYER_PASSWORD (read from .env by Node, see scripts/video/paypal.mjs). Each app shot fails
// if the page shows MOCK or FIXTURE text or the footer does not read "PayPal sandbox (authorization)".
// If the agent bought Mom's gift without asking (≤ $45), the run stops: run it again (a new session).
//
// Environment:
//   BASE_URL     app to drive (default http://localhost:3150)
//   CHROME_PATH  Chrome/Chromium/Edge executable (default: first installed one found below)
//   OUT_DIR      output folder (default docs/gallery)
//
// AI calls: Draft with AI (1), Shop my whole gift list (1 turn, several model steps), and only if Mom
// got no gift, "Find Mom something around $55" (1). The red-team button and the Ledger need no AI.
// The cover (00-cover.png) is rendered from docs/gallery/cover.html: node scripts/screenshots.mjs --cover

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { approveOnPayPal, loadBuyerEnv, onPayPal } from "./video/paypal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3150").replace(/\/+$/, "");
const OUT = resolve(ROOT, process.env.OUT_DIR ?? "docs/gallery");
const SCALE = 2;
const MAX_BYTES = 5 * 1024 * 1024;
const FULL = { width: 1500, height: 1000 };
const BAR = 44; // CSS px of browser bar above the page
const VIEW = { width: FULL.width, height: FULL.height - BAR };
const TURN_TIMEOUT = 150_000;

const SHOP = "Shop my whole gift list";
const MOM_FOLLOW_UP = "Find Mom something around $55";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(local, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error("No Chrome found. Set CHROME_PATH to a Chrome, Chromium or Edge executable.");
  return hit;
}

if (!process.argv.includes("--cover")) await wake();

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb", "--lang=en-US"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
await page.setViewport({ ...VIEW, deviceScaleFactor: SCALE });
page.setDefaultTimeout(60_000);
const problems = [];
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && problems.push(`[http ${r.status()}] ${r.url()}`));
const report = { base: BASE, turns: [], shots: [] };

mkdirSync(OUT, { recursive: true });

try {
  if (process.argv.includes("--cover")) {
    await shootCover();
  } else {
    await runDemo();
  }
} catch (e) {
  const dump = join(tmpdir(), "ribbon-screenshots-error.png");
  await page.screenshot({ path: dump }).catch(() => {});
  log(`Failed: ${e.message}
  Page at failure: ${dump}`);
  process.exitCode = 1;
} finally {
  if (problems.length) log("Problems seen:\n  " + problems.join("\n  "));
  if (!process.argv.includes("--cover")) {
    const file = join(tmpdir(), "ribbon-screenshots-report.json");
    writeFileSync(file, JSON.stringify(report, null, 2));
    log(`Report: ${file}`);
  }
  await browser.close();
}

// ---------------------------------------------------------------- demo

async function runDemo() {
  // 01. Gift list: draft the prefilled demo list with AI, then the review with five envelopes.
  await page.goto(`${BASE}/mandate`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#rule");
  for (let attempt = 1; ; attempt++) {
    log(`Draft with AI (attempt ${attempt})`);
    await clickButton("Draft with AI");
    await waitUntil(() => page.$(".review").then(Boolean), 60_000);
    await waitUntil(async () => !(await hasText("button", "Drafting")), 30_000);
    const people = await count(".review .rcp-row");
    await aiTurn("draft");
    if (people === 5) break;
    if (attempt >= 2) throw new Error(`The draft has ${people} people, not 5 (the AI fell back to the rule-based parser?).`);
    log(`The draft has ${people} people; waiting 60 s for the AI quota, then drafting again.`);
    await sleep(60_000);
  }
  const envelopes = await page.$$eval(".review .rcp-row", (rows) => rows.map((r) => `${r.querySelector(".rcp-name input").value} $${r.querySelector(".rcp-env input").value}`));
  log(`Draft: ${envelopes.join(", ")}`);
  report.envelopes = envelopes;
  // Focus Mom's envelope so the editor reads as editable.
  await page.click(".review .rcp-row .rcp-env input");
  await frameFirstFit(
    [
      ["label[for=rule]", ".review .rcp"],
      [".review", ".review .rcp"],
    ],
    14,
  );
  await shoot("01-gift-list.png");

  // 02. Approve $200.00 with PayPal: sandbox login, then PayPal's own approval page.
  log("Approve with PayPal");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60_000 }).catch(() => {}), clickButton("with PayPal", "button.btn-paypal")]);
  await waitUntil(async () => onPayPal(page) || page.url().includes("/agent"), 30_000);
  if (!onPayPal(page)) throw new Error("The app did not open PayPal (mock rail?).");
  if (!loadBuyerEnv(ROOT)) throw new Error("PayPal sandbox approval needs PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD in .env.");
  let shot = false;
  await approveOnPayPal(page, {
    log,
    onStep: async (kind) => {
      if (kind !== "submit" || shot) return;
      shot = true;
      await sleep(1500);
      await framePayPalAmount();
      await shoot("02-paypal-approval.png", { appChecks: false });
    },
  });
  if (!shot) throw new Error("PayPal showed no approval page; 02 not shot.");
  await waitUntil(async () => !onPayPal(page) && page.url().startsWith(BASE), 60_000);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 20_000 }).catch(() => {});
  if (!page.url().includes("/agent")) await page.goto(`${BASE}/agent`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".meter .pill-active");
  report.authorizationId = await apiState().then((s) => s.mandate?.paypal?.authorization_id ?? null);
  log(`PayPal authorization ${report.authorizationId}`);

  // 03. Shop the whole list in one pass; Mom's gift (> $45) waits for an OK.
  await page.waitForSelector(".composer input");
  await chatTurn("shop", () => clickButton(SHOP, "button.chip-suggest"), ".msg-agent .gift-plan");
  let mom = await momRow();
  log(`Mom: ${mom.kind} ${mom.price ?? ""} ${mom.gift ?? ""}`);
  if (mom.kind === "gp-bought") {
    const st = await apiState();
    report.searchRows = st.ledger.filter((r) => /search/.test(r.action)).map((r) => `${r.action}: ${r.summary}`);
    log(`Search rows:\n  ${report.searchRows.join("\n  ")}`);
  }
  if (mom.kind === "gp-bought") throw new Error(`The agent bought Mom's gift without asking (${mom.price} ≤ $45). Run again for a new session.`);
  if (mom.kind !== "gp-waiting") {
    log(`Mom has no gift waiting (${mom.kind}); asking "${MOM_FOLLOW_UP}"`);
    await sleep(20_000);
    await chatTurn(
      "mom",
      async () => {
        await page.click(".composer input");
        await page.type(".composer input", MOM_FOLLOW_UP);
        await page.keyboard.press("Enter");
      },
      ".msg-agent .approval, .msg-agent .receipt, .msg-agent .blocked",
    );
    if (!(await page.$(".msg-agent .approval"))) throw new Error("The follow-up did not leave Mom's gift waiting for an OK.");
    report.notes = [...(report.notes ?? []), "Mom's gift came from the follow-up prompt"];
  }
  await settle(800);
  await frame(".msg-agent .gift-plan", ".msg-agent .gift-plan");
  await shoot("03-gift-plan.png");
  report.plan = await page.$$eval(".msg-agent .gift-plan .gp-row", (rows) =>
    rows.map((r) => ({
      who: r.querySelector(".gp-who strong")?.textContent,
      gift: r.querySelector(".gp-gift")?.textContent,
      price: r.querySelector(".gp-price")?.textContent,
      status: r.querySelector(".gp-status")?.textContent,
      capture: r.querySelector(".pp-id code")?.textContent ?? null,
    })),
  );
  console.table(report.plan);

  // 04. Red-team simulation: no AI call, same purchase path.
  log("Simulate a hijacked agent");
  await clickButton("Simulate a hijacked agent");
  await page.waitForSelector(".msg-sim .blocked", { timeout: 30_000 });
  await settle(1500);
  await frame(".msg-sim", ".msg-sim");
  await shoot("04-hijack-blocked.png");

  // 06. The active gift list: a meter per envelope (Mom's gift still waiting for an OK).
  await clickLink("Gift list");
  await page.waitForSelector(".env-rows");
  await settle(1200);
  await frameFirstFit(
    [
      [".page-head", ".env"],
      [".mandate-card", ".env"],
      [".env", ".env"],
    ],
    14,
  );
  await shoot("06-envelopes.png");

  // Approve Mom's gift from her envelope row, so the ledger shows the whole list bought.
  const approve = await page.evaluateHandle(() => [...document.querySelectorAll(".env-decide button")].find((b) => /^\s*Approve/.test(b.textContent)) ?? null);
  if (approve.asElement()) {
    log("Approve Mom's gift");
    await approve.asElement().click();
    await waitUntil(async () => (await apiState()).recipients.every((r) => r.state !== "waiting_approval"), 30_000);
    await settle(1000);
  }

  // 05. Ledger: the gift-list grid on top, the ledger grid below.
  log("Ledger");
  await clickLink("Ledger");
  await page.waitForSelector(".gift-grid .ag-row", { timeout: 30_000 });
  await page.waitForSelector(".grid-panel:not(.gift-grid) .ag-row", { timeout: 30_000 });
  await settle(1500);
  await frameFirstFit([[".gift-grid", ".grid-panel:not(.gift-grid) .grid-wrap"]], 14, { alignTop: true });
  await shoot("05-ledger.png");
  const st = await apiState();
  report.captures = st.purchases.filter((p) => p.paypal?.capture_id).map((p) => ({ for: p.recipient_id, total: p.total, capture: p.paypal.capture_id, status: p.status }));
}

/** Waits for the turn's card; one turn per prompt (a resend would duplicate the user bubble). */
async function chatTurn(label, send, doneSel) {
  const before = await count(doneSel);
  log(`${label}: sending`);
  await send();
  const started = Date.now();
  let outcome = "timeout";
  let idleSince = null;
  while (Date.now() - started < TURN_TIMEOUT) {
    await sleep(700);
    const busy = await isBusy();
    if ((await count(doneSel)) > before && !busy) {
      outcome = "ok";
      break;
    }
    if (await page.$(".chat-error")) {
      outcome = "error: " + (await page.$eval(".chat-error span", (n) => n.textContent).catch(() => "?"));
      break;
    }
    idleSince = busy ? null : (idleSince ?? Date.now());
    if (idleSince && Date.now() - started > 4000 && Date.now() - idleSince > 6000) {
      outcome = "ended without the expected card";
      break;
    }
  }
  await aiTurn(label);
  if (outcome !== "ok") throw new Error(`${label}: ${outcome}`);
  log(`${label}: done in ${Math.round((Date.now() - started) / 1000)} s`);
}

/** Records which model answered the last AI call (the server's mode.ai_active). */
async function aiTurn(label) {
  const s = await apiState().catch(() => null);
  report.turns.push({ label, model: s?.mode?.ai_active ?? null });
  log(`  ${label}: answered by ${s?.mode?.ai_active ?? "?"}`);
}

function apiState() {
  return page.evaluate(() => fetch("/api/state", { credentials: "same-origin" }).then((r) => r.json()));
}

async function momRow() {
  return page.evaluate(() => {
    const row = [...document.querySelectorAll(".msg-agent .gift-plan .gp-row")].find((r) => r.querySelector(".gp-who strong")?.textContent.trim() === "Mom");
    if (!row) return { kind: "missing" };
    return {
      kind: [...row.classList].find((c) => c.startsWith("gp-") && c !== "gp-row") ?? "?",
      price: row.querySelector(".gp-price")?.textContent ?? null,
      gift: row.querySelector(".gp-gift")?.textContent ?? null,
    };
  });
}

// ---------------------------------------------------------------- framing

/** Visible band between the sticky topbar and the sticky composer (viewport px). */
async function band() {
  return page.evaluate(() => {
    const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const comp = document.querySelector(".composer-wrap");
    const bottom = comp ? comp.getBoundingClientRect().top + 12 : window.innerHeight; // its top 12px is a fade
    return { top, bottom };
  });
}

/** Scrolls so the elements from `first` to `last` sit in the visible band; if they do not fit, `first` (alignTop) or `last` wins. */
async function scrollToSpan(firstEl, lastEl, pad = 16, { alignTop = false } = {}) {
  const b = await band();
  await page.evaluate(
    (f, l, b, pad, alignTop) => {
      const y = window.scrollY;
      const top = f.getBoundingClientRect().top + y;
      const bottom = l.getBoundingClientRect().bottom + y;
      const room = b.bottom - b.top - 2 * pad;
      const target = alignTop || bottom - top <= room ? top - b.top - pad : bottom - (b.bottom - pad);
      window.scrollTo({ top: Math.max(0, target), behavior: "instant" });
    },
    firstEl,
    lastEl,
    b,
    pad,
    alignTop,
  );
  await settle(700);
}

/** Frames the first [first, last] selector pair whose span fits the visible band (the last pair always). */
async function frameFirstFit(pairs, pad = 12, opts = {}) {
  const b = await band();
  for (const [i, [f, l]] of pairs.entries()) {
    const fe = (await page.$$(f)).at(-1);
    const le = (await page.$$(l)).at(-1);
    if (!fe || !le) continue;
    const span = await page.evaluate((a, z) => z.getBoundingClientRect().bottom - a.getBoundingClientRect().top, fe, le);
    if (span <= b.bottom - b.top - 2 * pad || i === pairs.length - 1) return scrollToSpan(fe, le, pad, opts);
  }
}

async function frame(firstSel, lastSel) {
  const firsts = await page.$$(firstSel);
  const lasts = await page.$$(lastSel);
  await scrollToSpan(firsts.at(-1), lasts.at(-1));
}

/** On PayPal's page, bring the first "$200.00" into view (the page is usually short enough anyway). */
async function framePayPalAmount() {
  await page
    .evaluate(() => {
      const hit = [...document.querySelectorAll("span, p, div, button")].find((n) => n.children.length === 0 && /\$200\.00/.test(n.textContent));
      if (!hit) return;
      const r = hit.getBoundingClientRect();
      if (r.bottom > innerHeight - 40) window.scrollBy({ top: r.bottom - innerHeight + 120, behavior: "instant" });
    })
    .catch(() => {});
  await settle(500);
}

// ---------------------------------------------------------------- helpers

/** The viewport under a slim browser bar with the page's URL, 1500×1000 CSS px at 2× = 3000×2000. */
async function shoot(name, { appChecks = true } = {}) {
  const path = join(OUT, name);
  if (appChecks) await checkReal(name);
  await waitUntil(async () => !(await page.$(".toast")), 9000);
  await waitUntil(async () => !(await page.$(".route .spinner, .typing, .skeleton, .tool-pending")), 15_000);
  await waitForVisibleImages();
  const shotBuf = await page.screenshot({ type: "png" });
  const url = page.url().replace(/^https?:\/\//, "");
  await compositeWithBar(shotBuf, url, path);
  const size = statSync(path).size;
  if (size > MAX_BYTES) throw new Error(`${name}: ${(size / 1e6).toFixed(2)} MB is over 5 MB`);
  report.shots.push({ name, url });
  log(`saved ${name} (${(size / 1e6).toFixed(2)} MB) at ${url.slice(0, 60)}`);
}

async function compositeWithBar(png, url, path) {
  const shown = url.length > 72 ? `${url.slice(0, 71)}…` : url;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${FULL.width}px;height:${FULL.height}px;overflow:hidden;background:#fff}
    .bar{height:${BAR}px;box-sizing:border-box;display:grid;grid-template-columns:120px 1fr 120px;align-items:center;background:#f2eadc;border-bottom:1px solid #e4d8c3;font-family:"Inter","Segoe UI",system-ui,sans-serif}
    .dots{display:flex;gap:8px;padding-left:18px}.dots i{width:12px;height:12px;border-radius:50%;background:#dccfb8}
    .url{justify-self:center;display:flex;align-items:center;gap:8px;min-width:520px;max-width:900px;height:28px;padding:0 18px;border-radius:9px;background:#fffdf8;border:1px solid #e4d8c3;font-size:15px;color:#5a4e45;font-weight:500;white-space:nowrap;overflow:hidden}
    .url svg{flex:none;color:#9a8c7c}
    img{display:block;width:${VIEW.width}px;height:${VIEW.height}px}
  </style></head><body><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="url"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>${esc(shown)}</span><span></span></div>
  <img src="data:image/png;base64,${Buffer.from(png).toString("base64")}"></body></html>`;
  const comp = await browser.newPage();
  try {
    await comp.setViewport({ ...FULL, deviceScaleFactor: SCALE });
    await comp.setContent(html, { waitUntil: "load" });
    await comp.screenshot({ path, type: "png" });
  } finally {
    await comp.close();
  }
}

/** The hosted demo sleeps when idle: wait for /healthz (up to ~2.5 min). */
async function wake() {
  const end = Date.now() + 150_000;
  for (;;) {
    const ok = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.ok).catch(() => false);
    if (ok) return log(`${BASE} is awake`);
    if (Date.now() > end) throw new Error(`${BASE}/healthz does not answer.`);
    log("waking the app …");
    await sleep(5000);
  }
}

/** Real rail only: no MOCK or FIXTURE text, the authorization footer. */
async function checkReal(name) {
  const t = await page.evaluate(() => document.body.innerText);
  const bad = [];
  if (/MOCK|FIXTURE/.test(t)) bad.push("MOCK or FIXTURE text on the page");
  if (!/PayPal sandbox \(authorization\)/.test(t)) bad.push("the footer does not read 'PayPal sandbox (authorization)'");
  if (bad.length) throw new Error(`${name}: ${bad.join("; ")}`);
}

async function shootCover() {
  const html = join(OUT, "cover.html");
  await page.setViewport({ ...FULL, deviceScaleFactor: SCALE });
  await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await settle(500);
  await page.screenshot({ path: join(OUT, "00-cover.png"), type: "png" });
  log("saved 00-cover.png");
}

async function waitForVisibleImages() {
  await waitUntil(
    () =>
      page.evaluate(() =>
        [...document.images]
          .filter((img) => {
            const r = img.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
          })
          .every((img) => img.complete),
      ),
    10_000,
  );
  await sleep(300);
}

async function settle(ms = 1000) {
  await sleep(ms);
}

async function waitUntil(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(400);
  }
  return false;
}

function count(sel) {
  return page.$$eval(sel, (n) => n.length);
}

function isBusy() {
  return page.evaluate(() => [...document.querySelectorAll(".composer button")].some((b) => b.textContent?.trim() === "Stop"));
}

function hasText(sel, text) {
  return page.evaluate((s, t) => [...document.querySelectorAll(s)].some((n) => n.textContent?.includes(t)), sel, text);
}

async function clickButton(text, sel = "button") {
  const ok = await page.evaluate(
    (t, sel) => {
      const b = [...document.querySelectorAll(sel)].find((x) => x.textContent?.includes(t) && !x.disabled);
      b?.click();
      return !!b;
    },
    text,
    sel,
  );
  if (!ok) throw new Error(`No enabled button "${text}"`);
}

async function clickLink(text) {
  const ok = await page.evaluate((t) => {
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent?.trim() === t);
    a?.click();
    return !!a;
  }, text);
  if (!ok) throw new Error(`No link "${text}"`);
}
