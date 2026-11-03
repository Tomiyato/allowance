// Devpost gallery screenshots: drives a running Allowance instance through the demo and saves
// docs/gallery/01-mandate.png … 05-ledger.png (1500×1000 viewport, 3:2, each ≤ 5 MB).
//
// Usage:
//   npm install                      # puppeteer-core is a devDependency (it does not download a browser)
//   npm run build && PORT=3150 AI_MODEL=gemini-3.6-flash PRODUCT_SOURCE=channel3 DEMO_INJECTION=1 npm start
//   node scripts/screenshots.mjs     # in a second terminal
//
// Environment:
//   BASE_URL     app to drive (default http://localhost:3150)
//   CHROME_PATH  Chrome/Chromium/Edge executable (default: first installed one found below)
//   SCALE        deviceScaleFactor, 2 (default) or 1; a shot over 5 MB is retaken at 1
//   OUT_DIR      output folder (default docs/gallery)
//
// Each run starts a fresh browser profile, so it gets a new session: empty mandate, empty ledger.
// It makes 3–5 LLM calls (mandate draft, two chat turns, one retry each if no card appears).
// Retake only 01 (one LLM call): node scripts/screenshots.mjs --mandate-only
// The cover (00-cover.png) is rendered separately from docs/gallery/cover.html: node scripts/screenshots.mjs --cover

import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3150").replace(/\/+$/, "");
const OUT = resolve(ROOT, process.env.OUT_DIR ?? "docs/gallery");
const SCALE = Number(process.env.SCALE ?? 2);
const MAX_BYTES = 5 * 1024 * 1024;
const VIEW = { width: 1500, height: 1000 };
const TURN_TIMEOUT = 75_000;

const P1 = "Find a gardening gift for my mom around $40 and buy the best one";
const VACUUM = "Order a robot vacuum";

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

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ ...VIEW, deviceScaleFactor: SCALE });
page.setDefaultTimeout(60_000);
const problems = [];
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && problems.push(`[http ${r.status()}] ${r.url()}`));

mkdirSync(OUT, { recursive: true });

try {
  if (process.argv.includes("--cover")) {
    await shootCover();
  } else {
    await runDemo();
  }
} catch (e) {
  const dump = join(tmpdir(), "allowance-screenshots-error.png");
  await page.screenshot({ path: dump, fullPage: true }).catch(() => {});
  log(`Failed: ${e.message}
  Page at failure: ${dump}`);
  process.exitCode = 1;
} finally {
  if (problems.length) log("Problems seen:\n  " + problems.join("\n  "));
  await browser.close();
}

// ---------------------------------------------------------------- demo

async function runDemo() {
  // 1. Mandate: draft from the prefilled rule with AI, then review.
  await page.goto(`${BASE}/mandate`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#rule");
  for (let attempt = 1; ; attempt++) {
    log(`Draft with AI (attempt ${attempt})`);
    await clickButton("Draft with AI");
    const ok = await waitUntil(() => page.$(".review .form-grid").then(Boolean), 60_000);
    if (ok) break;
    if (attempt >= 2) throw new Error("The mandate draft never appeared.");
  }
  await waitUntil(async () => !(await hasText("button", "Drafting")), 30_000);
  await settle();
  // Rule + full review fit only on tall screens; at 1000 px show the rule text through the fine print.
  await frameFirstFit(
    [
      [".page > .panel:first-of-type", ".review"],
      ["label[for=rule]", ".review .fine-print"],
      [".review", ".review"],
    ],
    6,
  );
  await shoot("01-mandate.png");
  if (process.argv.includes("--mandate-only")) return;

  // 2. Approve (mock rail redirects straight back to /agent; the real rail would open PayPal).
  log("Approve with PayPal");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), clickButton("Approve with PayPal")]);
  if (!page.url().includes("/agent")) await page.goto(`${BASE}/agent`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".meter .pill-active");
  await page.waitForSelector(".composer input");

  // 3. Delegated purchase.
  await chatTurn(
    "P1",
    async () => {
      await page.click(".composer input");
      await page.type(".composer input", P1);
      await page.keyboard.press("Enter");
    },
    ".msg-agent:not(.msg-sim) .receipt, .msg-agent:not(.msg-sim) .approval",
  );
  if (!(await page.$(".msg-agent:not(.msg-sim) .receipt"))) log("WARN: the agent asked for approval instead of buying; 02 shows the approval card.");
  await settle();
  await framePurchase();
  await shoot("02-agent-purchase.png");

  // 4. Blocked category (and the injection flag, if the agent raised one in turn 1).
  await chatTurn("robot vacuum", () => clickButton(VACUUM, "button.chip-suggest"), ".msg-agent:not(.msg-sim) .blocked");
  await settle();
  await frameBlocked();
  await shoot("03-flagged-and-blocked.png");

  // 5. Red-team simulation: no LLM call, same purchase path.
  log("Simulate a hijacked agent");
  await clickButton("Simulate a hijacked agent");
  await page.waitForSelector(".msg-sim .blocked", { timeout: 30_000 });
  await settle();
  await frame(".msg-sim", ".msg-sim");
  await shoot("04-hijack-simulation.png");

  // 6. Ledger.
  log("Ledger");
  await clickLink("Ledger");
  await page.waitForSelector(".ag-row", { timeout: 30_000 });
  await page.waitForSelector(".kpis");
  await settle(1500);
  await frameLedger();
  await shoot("05-ledger.png");
}

/** Sends a prompt and waits for a new card matching doneSel; resends once if the turn ends without one. */
async function chatTurn(label, send, doneSel) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = await count(doneSel);
    log(`${label}: sending (attempt ${attempt})`);
    await send();
    const started = Date.now();
    let outcome = "timeout";
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
      if (!busy && Date.now() - started > 4000) {
        outcome = "ended without the expected card";
        break;
      }
    }
    if (outcome === "ok") {
      log(`${label}: done in ${Math.round((Date.now() - started) / 1000)} s`);
      return;
    }
    log(`${label}: ${outcome}`);
    if (await isBusy()) await clickButton("Stop", ".composer button").catch(() => {});
    if (await page.$(".chat-error")) await clickButton("Dismiss", ".chat-error button").catch(() => {});
    await waitUntil(async () => !(await isBusy()), 10_000);
    if (attempt === 1) await sleep(8000); // give a rate limit a moment
  }
  throw new Error(`${label}: no card after two attempts.`);
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

/** Scrolls so the elements from `first` to `last` sit in the visible band; if they do not fit, `last` wins. */
async function scrollToSpan(firstEl, lastEl, pad = 16) {
  const b = await band();
  await page.evaluate(
    (f, l, b, pad) => {
      const y = window.scrollY;
      const top = f.getBoundingClientRect().top + y;
      const bottom = l.getBoundingClientRect().bottom + y;
      const room = b.bottom - b.top - 2 * pad;
      const target = bottom - top <= room ? top - b.top - pad : bottom - (b.bottom - pad);
      window.scrollTo({ top: Math.max(0, target), behavior: "instant" });
    },
    firstEl,
    lastEl,
    b,
    pad,
  );
  await settle(700);
}

/** Frames the first [first, last] selector pair whose span fits the visible band (the last pair always). */
async function frameFirstFit(pairs, pad = 12) {
  const b = await band();
  for (const [i, [f, l]] of pairs.entries()) {
    const fe = (await page.$$(f)).at(-1);
    const le = (await page.$$(l)).at(-1);
    if (!fe || !le) continue;
    const span = await page.evaluate((a, z) => z.getBoundingClientRect().bottom - a.getBoundingClientRect().top, fe, le);
    if (span <= b.bottom - b.top - 2 * pad || i === pairs.length - 1) return scrollToSpan(fe, le, pad);
  }
}

async function frame(firstSel, lastSel) {
  const firsts = await page.$$(firstSel);
  const lasts = await page.$$(lastSel);
  await scrollToSpan(firsts.at(-1), lasts.at(-1));
}

/** Product strip and the receipt that followed it, with "Why this one" in view. */
async function framePurchase() {
  const card = (await page.$$(".msg-agent:not(.msg-sim) .receipt, .msg-agent:not(.msg-sim) .approval")).at(-1);
  const strip = await page.evaluateHandle((c) => {
    const all = [...document.querySelectorAll(".products-card")].filter(
      (s) => s.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return all.at(-1) ?? c;
  }, card);
  await scrollToSpan(strip.asElement(), card);
}

/** The injection flag card plus the blocked vacuum when both fit; else the vacuum request and its card. */
async function frameBlocked() {
  const blocked = (await page.$$(".msg-agent:not(.msg-sim) .blocked")).at(-1);
  const flag = (await page.$$(".flag-card")).at(-1);
  const b = await band();
  if (flag) {
    const span = await page.evaluate((f, l) => l.getBoundingClientRect().bottom - f.getBoundingClientRect().top, flag, blocked);
    if (span <= b.bottom - b.top - 32) return scrollToSpan(flag, blocked);
    log("Flag card and blocked card do not fit together; framing the blocked card.");
  } else {
    log("No injection flag card this run; framing the blocked card.");
  }
  const bubble = await page.evaluateHandle((c) => {
    const users = [...document.querySelectorAll(".msg-user")].filter(
      (u) => u.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return users.at(-1) ?? c;
  }, blocked);
  await scrollToSpan(bubble.asElement(), blocked);
}

/** KPI tiles, category bars and as much of the grid as fits, with the flagged rows in view. */
async function frameLedger() {
  // Bring a red or amber row into the grid's own viewport if it is not on screen yet.
  await page.evaluate(() => {
    const vp = document.querySelector(".ag-body-viewport");
    const row = document.querySelector(".ag-row.row-deny, .ag-row.row-flag, .ag-row.row-wait");
    if (vp && row) {
      const r = row.getBoundingClientRect();
      const v = vp.getBoundingClientRect();
      if (r.bottom > v.bottom) vp.scrollTop += r.bottom - v.bottom + 40;
    }
  });
  const kpis = await page.$(".kpis");
  const grid = await page.$(".grid-panel");
  const b = await band();
  const fits = await page.evaluate((f, l) => l.getBoundingClientRect().bottom - f.getBoundingClientRect().top, kpis, grid);
  if (fits <= b.bottom - b.top - 32) return scrollToSpan(kpis, grid);
  // Too tall: start at the KPI tiles; the grid runs off the bottom edge.
  await page.evaluate(
    (k, top) => window.scrollTo({ top: Math.max(0, k.getBoundingClientRect().top + window.scrollY - top - 16), behavior: "instant" }),
    kpis,
    b.top,
  );
  await settle(700);
}

// ---------------------------------------------------------------- helpers

async function shoot(name) {
  const path = join(OUT, name);
  await waitUntil(async () => !(await page.$(".toast")), 9000);
  await waitUntil(async () => !(await page.$(".route .spinner, .typing, .skeleton, .tool-pending")), 15_000);
  await waitForVisibleImages();
  await page.screenshot({ path, type: "png" });
  let size = statSync(path).size;
  if (size > MAX_BYTES) {
    log(`${name}: ${(size / 1e6).toFixed(2)} MB at scale ${SCALE}; retaking at scale 1`);
    const y = await page.evaluate(() => window.scrollY);
    await page.setViewport({ ...VIEW, deviceScaleFactor: 1 });
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), y);
    await settle(800);
    await page.screenshot({ path, type: "png" });
    await page.setViewport({ ...VIEW, deviceScaleFactor: SCALE });
    size = statSync(path).size;
  }
  log(`saved ${name} (${(size / 1e6).toFixed(2)} MB)`);
}

async function shootCover() {
  const html = join(OUT, "cover.html");
  await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await settle(500);
  await shoot("00-cover.png");
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
