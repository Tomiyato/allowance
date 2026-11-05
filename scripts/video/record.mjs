// Drives the running app through the demo and records one clip per app scene (clips/<id>.mp4).
//
// One fresh browser session runs scenes s01 → s11 in order (each scene needs the state the one
// before left behind). Only the selected scenes are recorded; the others still run, quickly, so
// the state is right. Each clip lasts at least its narration (lead + voiceover + tail), with
// actions synced to sentence cues, AI waits sped up and AI cooldowns cut.
//
// AI calls: Draft with AI (1), P1, robot vacuum, P2, return = 5 chat turns (each one or more
// model steps). A chat prompt is never resent inside a take (that would leave two identical user
// bubbles): if a turn fails, or P2 is bought without asking, the whole take restarts in a fresh
// browser session (new app session, new PayPal authorization), up to MAX_TAKES (default 3).
// A cooldown between AI calls (AI_COOLDOWN, default 25 s) is cut from the clips.
//
// Scene 3 runs the real PayPal sandbox approval (scripts/video/paypal.mjs) with the visible
// cursor; PayPal's page loads are jump cuts, and the clip marks the PayPal interval so compose
// shows PayPal's host in the window's URL bar meanwhile.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { approveOnPayPal, loadBuyerEnv, onPayPal } from "./paypal.mjs";
import { Recorder } from "./recorder.mjs";
import {
  BASE_URL, DIRS, HERE, ROOT, RUN_STATE, STAGE, T, bumpUsage, ensureDirs, findChrome, loadScenes, log, minClipFor,
  narrationDur, readJson, sentenceStarts, sleep, variantFor, voiceText, writeJson,
} from "./lib.mjs";

const TURN_TIMEOUT = 75_000;
const COOLDOWN = Number(process.env.AI_COOLDOWN ?? 25) * 1000;
const MAX_TAKES = Number(process.env.MAX_TAKES ?? 3);

/** A take that must restart from a fresh session (failed chat turn, unexpected card). */
class Retake extends Error {}

export async function record({ only } = {}) {
  const carry = {}; // what a retake should do differently (e.g. the $90 P2 prompt)
  for (let take = 1; ; take++) {
    try {
      return await recordTake({ only, take, carry });
    } catch (e) {
      if (!(e instanceof Retake) || take >= MAX_TAKES) throw e;
      const wait = /rate|limit|busy|overloaded/i.test(e.message) ? 75 : 10;
      log(`Take ${take} discarded: ${e.message}. Starting take ${take + 1} in a fresh session in ${wait} s.`);
      await sleep(wait * 1000);
    }
  }
}

async function recordTake({ only, take, carry }) {
  ensureDirs();
  const cfg = loadScenes();
  const P = cfg.prompts;
  const appScenes = cfg.scenes.filter((s) => s.type === "app");
  const selected = new Set(only?.length ? only : appScenes.map((s) => s.id));
  const lastNeeded = Math.max(...appScenes.map((s, i) => (selected.has(s.id) ? i : -1)));
  if (lastNeeded < 0) throw new Error(`No app scene matches ${[...selected].join(", ")}`);
  const prevState = readJson(RUN_STATE(), {});
  const state = { ...prevState, recordedAt: new Date().toISOString(), base: BASE_URL, take, notes: [] };

  const health = await fetch(`${BASE_URL}/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`The app is not answering at ${BASE_URL}/healthz. Start it first (see the header of scripts/video/run.mjs).`);
  const mode = await fetch(`${BASE_URL}/api/state`).then((r) => r.json()).catch(() => null);
  state.mode = mode?.mode ?? null;
  log(`App at ${BASE_URL}: payments=${mode?.mode?.payment} products=${mode?.mode?.products} ai=${mode?.mode?.ai}`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !process.env.HEADFUL,
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-features=Translate", "--font-render-hinting=none", "--lang=en-US"],
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await page.setViewport({ width: STAGE.appW, height: STAGE.appH, deviceScaleFactor: 1 });
  page.setDefaultTimeout(60_000);
  const inject = readFileSync(join(HERE, "inject.js"), "utf8").replace("__ZOOM__", String(STAGE.zoom));
  await page.evaluateOnNewDocument(inject);
  const problems = [];
  page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
  page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && problems.push(`[http ${r.status()}] ${r.url()}`));

  const rec = new Recorder(page);
  let lastAi = 0;
  let aiCalls = 0;

  // ------------------------------------------------------------------ helpers

  const center = (el) =>
    page.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height, width: r.width, height: r.height };
    }, el);

  async function el(sel, { text, last = true, within } = {}) {
    const h = await page.evaluateHandle(
      (sel, text, last, within) => {
        const root = within ? [...document.querySelectorAll(within)].at(-1) ?? document : document;
        const all = [...root.querySelectorAll(sel)].filter((n) => (text ? n.textContent?.includes(text) : true));
        return (last ? all.at(-1) : all[0]) ?? null;
      },
      sel,
      text ?? null,
      last,
      within ?? null,
    );
    const e = h.asElement();
    if (!e) throw new Error(`No element ${sel}${text ? ` with "${text}"` : ""}`);
    return e;
  }

  let cursorPos = { x: 1180, y: 640 };
  async function moveTo(target, { dx = 0, dy = 0, ms } = {}) {
    const p = target.x != null ? target : await center(target);
    const x = Math.round(p.x + dx);
    const y = Math.round(p.y + dy);
    cursorPos = { x, y };
    await page.evaluate((x, y, ms) => window.__rec.moveTo(x, y, ms), x, y, ms ?? null);
    await page.mouse.move(x, y);
  }

  /** Points at an element without covering its text: just off its left edge, or inside its right end. */
  async function pointAt(target, { side = "left", ms } = {}) {
    const r = await center(target);
    const y = r.top + Math.min(r.h / 2, 22);
    const x = side === "left" ? r.left - 12 : r.right - 70;
    await moveTo({ x, y }, { ms });
  }

  async function click(target, opts = {}) {
    await moveTo(target, opts);
    await sleep(rec.on ? 220 : 30);
    await page.evaluate(() => window.__rec.ripple());
    const p = await page.evaluate(() => window.__rec.pos);
    await page.mouse.click(p.x, p.y);
    await sleep(rec.on ? 250 : 50);
  }

  async function type(text, { min = 38, max = 85 } = {}) {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await sleep(rec.on ? min + Math.random() * (max - min) + (ch === " " ? 25 : 0) : 5);
    }
  }

  const pause = (ms) => sleep(rec.on ? ms : Math.min(ms, 150));

  /** The visible band between the sticky topbar and the composer (viewport px). */
  const band = () =>
    page.evaluate(() => {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      const comp = document.querySelector(".composer-wrap");
      const bottom = comp ? comp.getBoundingClientRect().top + 12 : window.innerHeight;
      return { top, bottom };
    });

  /** Eased scroll so [first .. last] sits in the band (if too tall, `last` wins; `align` top keeps first). */
  async function frameSpan(first, last, { pad = 18, ms = 1000, align = "fit" } = {}) {
    const offset = async () => {
      const b = await band();
      const f = await center(first);
      const l = await center(last ?? first);
      const room = b.bottom - b.top - 2 * pad;
      let dy;
      if (align === "top" || l.bottom - f.top <= room) dy = f.top - b.top - pad;
      else dy = l.bottom - (b.bottom - pad);
      if (align === "center" && l.bottom - f.top <= room) dy = (f.top + l.bottom) / 2 - (b.top + b.bottom) / 2;
      return dy;
    };
    // A second, short pass corrects a scroll the app moved under us (the chat's own smooth
    // scroll to its end can still be running when a scene starts).
    for (let pass = 0; pass < 3; pass++) {
      const dy = await offset();
      if (Math.abs(dy) < (pass ? 24 : 4)) return;
      if (pass) log(`  frameSpan: correcting ${Math.round(dy)} px`);
      const moved = await page.evaluate((dy, ms) => window.__rec.scrollByPx(dy, ms), dy, rec.on ? (pass ? 450 : ms) : 1);
      if (Math.abs(moved) < 2) return; // already at the top or bottom of the page
      await pause(150);
    }
  }

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn().catch(() => false)) return true;
      await sleep(300);
    }
    return false;
  }
  const count = (sel) => page.$$eval(sel, (n) => n.length);
  const exists = (sel) => page.$(sel).then(Boolean);
  const isBusy = () => page.evaluate(() => [...document.querySelectorAll(".composer button")].some((b) => b.textContent?.trim() === "Stop"));

  async function cooldown() {
    const left = COOLDOWN - (Date.now() - lastAi);
    if (left > 0) {
      log(`  AI cooldown ${Math.round(left / 1000)} s${rec.on ? " (cut)" : ""}`);
      await rec.cut(() => sleep(left));
    }
  }

  /**
   * Sends a chat turn once and waits (sped up) for a new card matching doneSel. A failed turn
   * discards the take (Retake): resending would leave two identical user bubbles on screen.
   */
  async function chatTurn(label, send, doneSel) {
    await cooldown();
    const before = await count(doneSel);
    log(`  ${label}: sending`);
    aiCalls++;
    bumpUsage("app_ai_turns");
    await send();
    let outcome = "timeout";
    const started = Date.now();
    await rec.fast(async () => {
      // A card can settle only after the turn ends: the refund card reads "Refund not completed"
      // until the app state refreshes. So an idle composer gets a grace period before giving up.
      let idleSince = null;
      while (Date.now() - started < TURN_TIMEOUT) {
        await sleep(500);
        const busy = await isBusy();
        if ((await count(doneSel)) > before && !busy) {
          outcome = "ok";
          break;
        }
        if (await exists(".chat-error")) {
          outcome = "error: " + (await page.$eval(".chat-error span", (n) => n.textContent).catch(() => "?"));
          break;
        }
        idleSince = busy ? null : (idleSince ?? Date.now());
        if (idleSince && Date.now() - started > 4000 && Date.now() - idleSince > 6000) {
          outcome = "ended without the expected card";
          break;
        }
      }
      await sleep(600); // let the last tokens and the meter settle
    });
    lastAi = Date.now();
    if (outcome !== "ok") throw new Retake(`${label}: ${outcome}`);
    log(`  ${label}: done in ${Math.round((Date.now() - started) / 1000)} s`);
    return true;
  }

  /** Every user bubble is unique (a duplicated prompt discards the take). */
  async function assertNoDuplicateBubbles() {
    const texts = await page.$$eval(".msg-user", (ns) => ns.map((n) => n.textContent.trim()));
    const dup = texts.find((t, i) => texts.indexOf(t) !== i);
    if (dup) throw new Retake(`duplicated user bubble "${dup.slice(0, 60)}"`);
  }

  /** The real rail is on screen: no MOCK text, the authorization footer. */
  async function assertReal(id) {
    if (onPayPal(page)) return;
    const t = await page.evaluate(() => document.body.innerText);
    if (/MOCK/.test(t)) throw new Error(`${id}: MOCK text on screen; record against the PAYMENT_MODE=authorization app.`);
    if (!/PayPal sandbox \(authorization\)/.test(t)) throw new Error(`${id}: the footer does not read "PayPal sandbox (authorization)".`);
  }

  async function clickChip(text) {
    await click(await el("button.chip-suggest", { text }));
  }

  async function nav(label) {
    await click(await el(".nav a", { text: label }));
    await page.waitForFunction((l) => document.querySelector(".nav a.active")?.textContent?.trim() === l, {}, label);
    await sleep(rec.on ? 500 : 200);
  }

  async function waitToastGone() {
    await waitFor(async () => !(await exists(".toast")), 9000);
  }

  /**
   * PayPal sandbox approval with the visible cursor: email, password, the "Pay with" page (held
   * for a beat), then back to the app. PayPal's page loads are cut; the clip marks the interval.
   */
  async function paypalApprove({ holdReview = 1600 } = {}) {
    if (!loadBuyerEnv(ROOT)) throw new Error("Scene 3 needs PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD in .env (the real PayPal sandbox rail).");
    state.notes.push("s03: recorded the PayPal sandbox approval.");
    const ui = {
      async click(_page, h) {
        await h.evaluate((e) => e.scrollIntoView({ block: "nearest", behavior: "instant" }));
        await click(h);
      },
      async type(_page, h, text, { secret } = {}) {
        await h.evaluate((e) => e.scrollIntoView({ block: "nearest", behavior: "instant" }));
        await click(h);
        await type(text, secret ? { min: 30, max: 50 } : { min: 10, max: 20 });
        await pause(200);
      },
      async wait(fn) {
        const r = await rec.cut(fn);
        // A new document: restart the screencast and put the cursor back where it was.
        await rec.restartCast();
        await page.evaluate((p) => window.__rec?.place(p.x, p.y), cursorPos).catch(() => {});
        await sleep(rec.on ? 120 : 0);
        return r;
      },
    };
    const steps = await approveOnPayPal(page, {
      ui,
      log: (m) => log(`  ${m}`),
      onStep: async (kind) => {
        if (kind === "email" || kind === "password" || kind === "submit") rec.markStart("paypal");
        if (kind === "email") await pause(250);
        if (kind === "submit") {
          await pause(400);
          const amount = await page.evaluateHandle(() => [...document.querySelectorAll("span, p, div")].find((n) => n.children.length === 0 && /\$150\.00/.test(n.textContent)) ?? null);
          if (amount.asElement()) await pointAt(amount.asElement(), { ms: 600 });
          await pause(holdReview);
        }
        if (kind === "back") rec.markEnd("paypal");
      },
    });
    state.paypalSteps = steps;
  }

  // ------------------------------------------------------------------ scene timing

  const sceneById = Object.fromEntries(cfg.scenes.map((s) => [s.id, s]));
  function timing(id) {
    const scene = sceneById[id];
    const variant = variantFor(scene, state);
    const narr = narrationDur(id, variant);
    if (narr == null) throw new Error(`No narration for ${id}; run TTS first (npm run video -- --tts-only).`);
    const text = voiceText(scene, variant);
    const offset = scene.prefixCard ? T.titleCard - T.titleXfade : 0; // clip starts this far into the segment
    const cues = sentenceStarts(scene, variant).map((t) => T.lead + (scene.voiceDelay ?? 0) + t - offset);
    return { min: minClipFor(scene, narr), cues, narr };
  }

  async function scene(id, fn) {
    const idx = appScenes.findIndex((s) => s.id === id);
    if (idx > lastNeeded) return false;
    const on = selected.has(id);
    const t = timing(id);
    // A closing beat that never makes the clip longer than its narration needs.
    t.hold = async (ms) => {
      if (!rec.on) return;
      const left = t.min - rec.elapsed();
      if (left > 0) await sleep(Math.min(ms, left * 1000));
    };
    log(`Scene ${id}${on ? "" : " (not recorded)"}: narration ${t.narr.toFixed(1)} s, clip ≥ ${t.min.toFixed(1)} s`);
    if (on) await rec.start(id);
    await fn(t);
    await assertReal(id);
    if (on) {
      await rec.until(t.min);
      const info = await rec.stop();
      state.clips ??= {};
      state.clips[id] = { dur: info.dur, min: Number(t.min.toFixed(2)), over: Number((info.dur - t.min).toFixed(2)), recordedAt: new Date().toISOString() };
      if (info.dur - t.min > 1.5) log(`  ${id}: clip runs ${(info.dur - t.min).toFixed(1)} s past its narration`);
    }
    return true;
  }

  // ------------------------------------------------------------------ the demo

  try {
    await page.goto(`${BASE_URL}/mandate`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#rule");
    await page.evaluate(() => document.fonts.ready);
    await sleep(600);

    // s01: empty mandate page, push in on the empty meter, pull back for "a mandate".
    await scene("s01", async ({ cues }) => {
      await pause(700);
      const meter = await el(".meter");
      await moveTo(meter, { dx: -70, dy: 52, ms: 1400 });
      await pause(300);
      await page.evaluate(() => window.__rec.cursorVisible(false));
      const r = await center(meter);
      await page.evaluate((r, ms) => window.__rec.zoomTo(r, 1.85, ms), r, rec.on ? 3200 : 1);
      await rec.until(cues[4] - 1.2); // "Allowance is a third option: a mandate."
      await page.evaluate((ms) => window.__rec.zoomReset(ms), rec.on ? 1500 : 1);
      await pause(1600);
      await page.evaluate(() => window.__rec.cursorVisible(true));
      await moveTo({ x: 1290, y: 330 }, { ms: 1200 });
    });

    // s02: plain-language rule → Draft with AI → review the structured mandate.
    await scene("s02", async ({ cues }) => {
      const rule = await el("#rule");
      const rr = await center(rule);
      await moveTo({ x: rr.left + 40, y: rr.top + 34 }, { ms: 900 });
      await moveTo({ x: rr.left + 520, y: rr.top + 34 }, { ms: 1700 });
      await moveTo({ x: rr.left + 260, y: rr.top + 62 }, { ms: 1300 });
      await rec.until(cues[1] - 3.2);
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        await cooldown();
        log(`  Draft with AI (attempt ${attempt})`);
        aiCalls++;
        bumpUsage("app_ai_turns");
        await click(await el("button", { text: "Draft with AI" }));
        await rec.fast(async () => {
          ok = await waitFor(() => exists(".review .form-grid"), 60_000);
          await waitFor(async () => !(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Drafting")))), 30_000);
          await sleep(400);
        });
        lastAi = Date.now();
      }
      if (!ok) throw new Error("The mandate draft never appeared.");
      const review = await el(".review");
      await frameSpan(review, await el(".review .review-actions"), { align: "top", ms: 1200 });
      await moveTo(await el(".review .field", { text: "Total budget" }), { dy: 6, ms: 900 });
      await pause(500);
      await moveTo(await el(".review .field", { text: "Ask me above" }), { dy: 6 });
      await pause(400);
      await moveTo(await el(".review .field", { text: "Max quantity" }), { dy: 6 });
      await pause(400);
      await moveTo(await el(".review .cat-picker"), { dy: 30 });
      await rec.until(cues[1] + 1.8); // "… and I can change every field"
      const budgetInput = await (await el(".review .field", { text: "Total budget" })).$("input");
      if (budgetInput) await click(budgetInput);
      await pause(900);
      await moveTo(await el(".review fieldset", { text: "Always blocked" }), { dy: 18 });
    });

    // s03: Approve with PayPal → the real sandbox login and approval → the active mandate.
    await scene("s03", async ({ hold }) => {
      const approve = await el("button.btn-paypal", { text: "Approve with PayPal" });
      await frameSpan(approve, approve, { align: "center", ms: 500 });
      await pause(100);
      await click(approve);
      await rec.cut(() => waitFor(async () => onPayPal(page) || page.url().includes("/agent"), 45_000));
      if (onPayPal(page)) await paypalApprove({ holdReview: 800 });
      else state.notes.push("s03: the app did not open PayPal (mock rail?).");
      await rec.cut(async () => {
        const ok = await waitFor(() => page.evaluate(() => !!document.querySelector(".meter .pill-active")), 45_000);
        if (!ok) throw new Error("The mandate never became active after Approve with PayPal.");
        await page.waitForNetworkIdle({ idleTime: 400, timeout: 15_000 }).catch(() => {});
        // PayPal returns to /agent; cut straight to the active mandate.
        if (!(await exists(".mandate-card"))) {
          await page.evaluate(() => [...document.querySelectorAll(".nav a")].find((a) => a.textContent.trim() === "Mandate")?.click());
          await page.waitForSelector(".mandate-card", { timeout: 15_000 });
          await sleep(400);
        }
      });
      await rec.restartCast();
      await page.evaluate((p) => window.__rec?.place(p.x, p.y), cursorPos).catch(() => {});
      await page.waitForSelector(".mandate-card");
      await pause(150);
      await moveTo(await el(".page-head .pill"), { dx: 30, dy: 8, ms: 450 });
      await pause(250);
      await moveTo(await el(".budget-hero .hero-num"), { dx: 60, dy: 4, ms: 450 });
      await pause(250);
      await moveTo(await el(".rules dt", { text: "Spending power" }), { dx: 40, dy: 22, ms: 500 });
      await hold(700);
      const auth = await page.$$(".rules dt").then(async (ds) => {
        for (const d of ds) if ((await d.evaluate((n) => n.textContent)) === "PayPal authorization") return d;
        return null;
      });
      if (auth) {
        await moveTo(auth, { dx: 60, dy: 22, ms: 500 });
        await hold(1500);
      }
    });
    state.authorizationId = await page.evaluate(() => [...document.querySelectorAll(".rules dt")].find((d) => d.textContent === "PayPal authorization")?.nextElementSibling?.textContent?.trim() ?? null).catch(() => null);
    state.mandateMode = await page.evaluate(() => [...document.querySelectorAll(".rules dt")].find((d) => d.textContent === "Spending power")?.nextElementSibling?.textContent ?? null).catch(() => null);

    // s04: delegate a purchase.
    await scene("s04", async ({ cues, hold }) => {
      await click(await el("button", { text: "Talk to the agent" }));
      await page.waitForSelector(".composer input");
      await pause(500);
      await click(await el(".composer input"));
      await chatTurn(
        "P1",
        async () => {
          await page.evaluate(() => (document.querySelector(".composer input").value = ""));
          await type(P.P1);
          await pause(300);
          await page.keyboard.press("Enter");
        },
        ".msg-agent:not(.msg-sim) .receipt, .msg-agent:not(.msg-sim) .approval",
      );
      const card = await el(".msg-agent:not(.msg-sim) .receipt, .msg-agent:not(.msg-sim) .approval");
      const strip = (await page.$$(".products-card")).at(-1);
      if (strip) {
        await frameSpan(strip, strip, { align: "top", ms: 1100 });
        const sr = await center(strip);
        await moveTo({ x: sr.right - 150, y: sr.top + 24 }, { ms: 800 });
        await pause(500);
        await moveTo({ x: sr.left + sr.w * 0.55, y: sr.top + sr.h * 0.6 }, { ms: 1500 });
      }
      await rec.until(cues[2] - 0.6); // "Before any PayPal call, a policy engine checked the mandate."
      await frameSpan(card, card, { ms: 1100 });
      await pointAt(await el(".card-banner", { within: ".msg-agent:not(.msg-sim) .purchase-card" }), { side: "right" });
      await pause(800);
      if (await page.evaluate((c) => c.classList.contains("approval"), card)) {
        state.notes.push("s04: the agent asked for approval instead of buying; approved on camera.");
        await click(await el(".approval .card-actions .btn-primary"));
        await waitFor(() => exists(".toast"), 10_000);
      }
      const why = await page.$(".msg-agent:not(.msg-sim) .receipt .rationale");
      await rec.until(cues[4] - 0.3); // "Every receipt says why the agent chose it."
      if (why) await pointAt(why);
      await hold(1600);
      await moveTo(await el(".meter"), { dy: 10 });
      await hold(800);
    });
    const ranS04 = appScenes.findIndex((x) => x.id === "s04") <= lastNeeded;
    if (ranS04) state.flagged = await exists(".flag-card");
    if (ranS04) log(`  injection flag card: ${state.flagged ? "yes" : "no"}`);
    if (ranS04 && !state.flagged) state.notes.push("No 'Agent flagged suspicious product text' card this take; s06 uses the noFlag narration.");
    writeJson(RUN_STATE(), state);
    if (ranS04 && !state.flagged && narrationDur("s06", "noFlag", true) == null) {
      log("  s06 needs the noFlag narration; generating it");
      const { runTts } = await import("./tts.mjs");
      await runTts({ withVariants: true });
    }

    // s05: blocked category, then the ask-first threshold, then approve.
    await scene("s05", async ({ cues, hold }) => {
      await chatTurn("robot vacuum", () => clickChip(P.vacuumChip), ".msg-agent:not(.msg-sim) .blocked");
      const blocked = await el(".msg-agent:not(.msg-sim) .blocked");
      const bubble = await page.evaluateHandle((c) => [...document.querySelectorAll(".msg-user")].filter((u) => u.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? c, blocked);
      await frameSpan(bubble.asElement(), blocked, { ms: 900 });
      await pointAt(await el(".reasons-block li", { within: ".msg-agent:not(.msg-sim) .blocked" }));
      await pause(900);
      const strike = await page.$(".msg-agent:not(.msg-sim) .blocked .strike");
      if (strike) await moveTo(strike, { dx: 10 });
      await rec.until(cues[1] - 4.2); // "A sheet set over sixty dollars …"
      // One P2 prompt per take; if it is bought without asking (≤ $60), the next take uses $90.
      const prompt = carry.p2Retry ? P.P2_retry : P.P2;
      {
        await click(await el(".composer input"));
        await chatTurn(
          "P2",
          async () => {
            await page.evaluate(() => (document.querySelector(".composer input").value = ""));
            await type(prompt, { min: 25, max: 45 });
            await pause(200);
            await page.keyboard.press("Enter");
          },
          ".msg-agent:not(.msg-sim) .approval, .msg-agent:not(.msg-sim) .receipt",
        );
      }
      const card = await el(".msg-agent:not(.msg-sim) .approval, .msg-agent:not(.msg-sim) .receipt");
      if (!(await page.evaluate((c) => c.classList.contains("approval"), card))) {
        carry.p2Retry = true;
        throw new Retake(`P2 "${prompt}" was bought without asking (≤ $60)`);
      }
      if (prompt !== P.P2) state.notes.push(`s05: used the "${prompt}" prompt.`);
      await frameSpan(card, card, { ms: 1000 });
      await pointAt(await el(".reasons-wait li", { within: ".msg-agent:not(.msg-sim) .approval" }));
      await hold(900); // let the "Waiting for your OK" card register
      await rec.until(cues[2] - 0.8); // "Nothing is charged until I approve."
      const approveBtn = await el(".card-actions .btn-primary", { within: ".msg-agent:not(.msg-sim) .approval" });
      state.p2Amount = await page.evaluate((b) => b.textContent.trim(), approveBtn);
      await click(approveBtn);
      await rec.fast(() => waitFor(() => exists(".toast"), 15_000));
      await pause(300);
      await moveTo(await el(".meter"), { dy: 10, ms: 700 });
      await hold(1000);
    });

    // s06: the flag card (if any), then the hijacked-agent simulation.
    await scene("s06", async ({ cues }) => {
      // No wait for the "Approved and paid" toast: it sits in a corner, and the narration opens on
      // the flag card.
      await page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => {});
      const flag = (await page.$$(".flag-card")).at(-1);
      let clickCue = cues[2];
      if (flag && state.flagged) {
        await frameSpan(flag, flag, { align: "center", ms: 1300 });
        await pointAt(flag, { side: "right" });
        await rec.until(cues[2] - 0.2); // "But models can be fooled."
        clickCue = cues[3];
      }
      await page.evaluate((ms) => window.__rec.scrollByPx(-1e5, ms), rec.on ? 1300 : 1);
      await pause(400);
      const btn = await el(".safety-demo button");
      await moveTo(await el(".safety-demo .safety-line"), { ms: 900 });
      await rec.until(clickCue + 0.6); // "This button replays the exact call …"
      await click(btn);
      await rec.fast(async () => {
        await page.waitForSelector(".msg-sim .blocked", { timeout: 30_000 });
        await sleep(1300); // the chat's own smooth scroll to the new card
      });
      const sim = await el(".msg-sim");
      await frameSpan(sim, sim, { align: "top", ms: 900 });
      await moveTo(await el(".msg-sim .sim-banner strong"), { dx: 40 });
      await rec.until(cues[cues.length - 3] - 0.3); // "Denied: …"
      const reasons = await page.$$(".msg-sim .reasons-block li");
      for (const r of reasons.slice(0, 2)) {
        await pointAt(r);
        await pause(900);
      }
    });

    // s07: refund the last purchase.
    await scene("s07", async ({ hold }) => {
      // The Groq fallback model tends to miss that the sheet set was approved in the UI and answers
      // "still pending" to the bare chip; with Groq answering (or after such a take) type the
      // explicit prompt instead. Gemini gets the chip, as in the script.
      const groq = /Groq/.test(await page.$eval(".footer", (n) => n.textContent).catch(() => ""));
      if (groq || carry.returnTyped) {
        state.notes.push(`s07: typed "${P.returnTyped}" (${groq ? "Groq fallback answering" : "retake"}).`);
        await click(await el(".composer input"));
        await chatTurn(
          "return",
          async () => {
            await type(P.returnTyped, { min: 25, max: 45 });
            await pause(200);
            await page.keyboard.press("Enter");
          },
          ".msg-agent:not(.msg-sim) .tool-card.refund",
        );
      } else {
        carry.returnTyped = true; // if the chip fails, the next take types the explicit prompt
        await chatTurn("return", () => clickChip(P.returnChip), ".msg-agent:not(.msg-sim) .tool-card.refund");
        carry.returnTyped = false;
      }
      const card = (await page.$$(".msg-agent:not(.msg-sim) .tool-card.refund")).at(-1);
      await frameSpan(card, card, { ms: 900 });
      await pointAt(card, { side: "right" });
      await pause(1200);
      await moveTo(await el(".meter"), { dy: 10, ms: 900 });
      await hold(1200);
    });
    if (appScenes.findIndex((x) => x.id === "s07") <= lastNeeded) {
      await assertNoDuplicateBubbles();
      state.refundId = await page.evaluate(() => [...document.querySelectorAll(".tool-card.refund")].at(-1)?.innerText.match(/\b[A-Z0-9]{17}\b/)?.[0] ?? null).catch(() => null);
      state.captureIds = await page.evaluate(() => [...document.querySelectorAll(".receipt")].map((r) => r.innerText.match(/PayPal capture\s+([A-Z0-9-]+)/)?.[1]).filter(Boolean)).catch(() => []);
    }

    // s08: revoke the mandate.
    await scene("s08", async ({ hold }) => {
      await nav("Mandate");
      await page.waitForSelector(".revoke-panel");
      const panel = await el(".revoke-panel");
      await frameSpan(panel, panel, { ms: 700 });
      await click(await el(".revoke-panel button", { text: "Revoke mandate" }));
      await pause(400);
      await click(await el(".revoke-panel button", { text: "Yes, revoke now" }));
      await rec.fast(() => waitFor(() => exists(".pill-revoked"), 20_000)); // PayPal voids the authorization
      await pause(600);
      await page.evaluate((ms) => window.__rec.scrollByPx(-1e5, ms), rec.on ? 700 : 1);
      await moveTo(await el(".page-head .pill"), { dx: 20, dy: 8, ms: 600 });
      await pause(700);
      // The chat scrolls itself to its end on mount; cut that, so the page opens at its top on
      // the "The mandate is revoked." banner.
      await click(await el(".nav a", { text: "Agent" }));
      await rec.cut(async () => {
        await page.waitForFunction(() => document.querySelector(".nav a.active")?.textContent?.trim() === "Agent");
        await page.waitForSelector(".no-mandate");
        await sleep(1400);
        await page.evaluate(() => (document.scrollingElement.scrollTop = 0));
        await sleep(250);
      });
      await moveTo(await el(".no-mandate strong"), { dx: 60, dy: 6, ms: 600 });
      await hold(1200);
    });

    // s09: the ledger.
    await scene("s09", async ({ cues }) => {
      await waitToastGone();
      await nav("Ledger");
      await rec.fast(async () => {
        await page.waitForSelector(".ag-row", { timeout: 30_000 });
        await sleep(800);
      });
      const kpis = await page.$$(".kpi");
      for (const k of kpis) {
        await moveTo(k, { dy: 8, ms: 480 });
        await pause(120);
      }
      const cat = await page.$(".cat-spend");
      if (cat) await moveTo(cat, { dx: -150, ms: 700 });
      const grid = await el(".grid-panel");
      await frameSpan(grid, grid, { align: "top", ms: 1000 });
      await click(await el(".search-box input"));
      await type(P.ledgerFilter, { min: 90, max: 140 });
      await pause(1400);
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await pause(600);
      // Point at the red agent.hijacked_attempt row: bring it into the grid's own viewport and
      // the page's visible band first, then rest the cursor just past the action text.
      const findHij = () => page.evaluateHandle(() => [...document.querySelectorAll(".ag-row .ag-cell")].find((c) => c.textContent?.trim() === "agent.hijacked_attempt") ?? null);
      let hij = (await findHij()).asElement();
      if (hij) {
        await page.evaluate((c) => {
          const vp = document.querySelector(".ag-body-viewport");
          const r = c.getBoundingClientRect();
          const v = vp?.getBoundingClientRect();
          if (vp && (r.bottom > v.bottom || r.top < v.top)) vp.scrollTop += r.top - v.top - v.height / 3;
        }, hij);
        await sleep(300);
        hij = (await findHij()).asElement();
      }
      if (hij) {
        const b = await band();
        const r = await center(hij);
        if (r.bottom > b.bottom - 20 || r.top < b.top + 20) await frameSpan(hij, hij, { align: "center", ms: 700 });
        const rr = await center(hij);
        const textW = await hij.evaluate((c) => {
          const range = document.createRange();
          range.selectNodeContents(c);
          return range.getBoundingClientRect().width;
        });
        await moveTo({ x: rr.left + Math.min(rr.w - 8, 14 + textW + 14), y: rr.y }, { ms: 800 });
        state.hijackPointed = true;
        await pause(1300);
      } else {
        state.notes.push("s09: no agent.hijacked_attempt row in the grid.");
      }
      // Pan the grid right to the PayPal ID and Remaining columns.
      await page.evaluate((ms) => {
        const vp = document.querySelector(".ag-body-horizontal-scroll-viewport") ?? document.querySelector(".ag-center-cols-viewport");
        if (vp) return window.__rec.scrollElX(vp, vp.scrollWidth, ms);
      }, rec.on ? 1200 : 1);
      await pause(300);
      for (const h of ["PayPal ID", "Remaining"]) {
        const hd = await page.evaluateHandle((t) => [...document.querySelectorAll(".ag-header-cell")].find((c) => c.textContent?.trim() === t) ?? null, h);
        if (hd.asElement()) {
          await moveTo(hd.asElement(), { dy: 50, ms: 700 });
          await pause(700);
        }
      }
    });

    // s11: back to the revoked mandate, still.
    await scene("s11", async () => {
      await nav("Mandate");
      await page.waitForSelector(".mandate-card");
      await moveTo({ x: STAGE.appW - 220, y: STAGE.appH - 160 }, { ms: 1600 });
    });
  } catch (e) {
    const dump = join(DIRS.clips, "record-error.png");
    await page.screenshot({ path: dump }).catch(() => {});
    log(`Recording failed: ${e.message}\n  Page at failure: ${dump}`);
    throw e;
  } finally {
    if (rec.on) await rec.abort().catch(() => {});
    state.aiCalls = aiCalls;
    state.problems = problems;
    writeJson(RUN_STATE(), { ...readJson(RUN_STATE(), {}), ...state, clips: { ...(prevState.clips ?? {}), ...(state.clips ?? {}) } });
    if (problems.length) log("Problems seen:\n  " + problems.join("\n  "));
    await browser.close();
  }
  log(`Recording done: ${aiCalls} AI turn(s) sent to the app.`);
  if (only?.length && only.length < appScenes.length) log("Note: a partial re-record runs in a new session; amounts can differ from the other clips. Re-record s02-s09 together for continuity.");
  return state;
}
