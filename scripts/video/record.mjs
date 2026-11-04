// Drives the running app through the demo and records one clip per app scene (clips/<id>.mp4).
//
// One fresh browser session runs scenes s01 → s11 in order (each scene needs the state the one
// before left behind). Only the selected scenes are recorded; the others still run, quickly, so
// the state is right. Each clip lasts at least its narration (lead + voiceover + tail), with
// actions synced to sentence cues, AI waits sped up and AI cooldowns cut.
//
// AI calls: Draft with AI (1), P1, robot vacuum, P2, return = 5 chat turns (each one or more
// model steps), plus one retry per turn if no card appears. A 25 s cooldown between AI calls
// keeps Gemini's free tier happy; cooldowns are off camera or cut.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { Recorder } from "./recorder.mjs";
import {
  BASE_URL, DIRS, HERE, RUN_STATE, STAGE, T, bumpUsage, ensureDirs, findChrome, loadScenes, log, minClipFor,
  narrationDur, readJson, sentenceCues, sleep, variantFor, writeJson,
} from "./lib.mjs";

const TURN_TIMEOUT = 75_000;
const COOLDOWN = Number(process.env.AI_COOLDOWN ?? 25) * 1000;

export async function record({ only } = {}) {
  ensureDirs();
  const cfg = loadScenes();
  const P = cfg.prompts;
  const appScenes = cfg.scenes.filter((s) => s.type === "app");
  const selected = new Set(only?.length ? only : appScenes.map((s) => s.id));
  const lastNeeded = Math.max(...appScenes.map((s, i) => (selected.has(s.id) ? i : -1)));
  if (lastNeeded < 0) throw new Error(`No app scene matches ${[...selected].join(", ")}`);
  const prevState = readJson(RUN_STATE(), {});
  const state = { ...prevState, recordedAt: new Date().toISOString(), base: BASE_URL, notes: [] };

  const health = await fetch(`${BASE_URL}/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`The app is not answering at ${BASE_URL}/healthz. Start it first (see the header of scripts/video/run.mjs).`);
  const mode = await fetch(`${BASE_URL}/api/state`).then((r) => r.json()).catch(() => null);
  state.mode = mode?.mode ?? null;
  log(`App at ${BASE_URL}: payments=${mode?.mode?.payment} products=${mode?.mode?.products} ai=${mode?.mode?.ai}`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !process.env.HEADFUL,
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-features=Translate", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
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

  async function moveTo(target, { dx = 0, dy = 0, ms } = {}) {
    const p = target.x != null ? target : await center(target);
    const x = Math.round(p.x + dx);
    const y = Math.round(p.y + dy);
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
    const b = await band();
    const f = await center(first);
    const l = await center(last ?? first);
    const room = b.bottom - b.top - 2 * pad;
    let dy;
    if (align === "top" || l.bottom - f.top <= room) dy = f.top - b.top - pad;
    else dy = l.bottom - (b.bottom - pad);
    if (align === "center" && l.bottom - f.top <= room) dy = (f.top + l.bottom) / 2 - (b.top + b.bottom) / 2;
    if (Math.abs(dy) < 4) return;
    await page.evaluate((dy, ms) => window.__rec.scrollByPx(dy, ms), dy, rec.on ? ms : 1);
    await pause(150);
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

  /** Sends a chat turn and waits (sped up) for a new card matching doneSel; resends once. */
  async function chatTurn(label, send, doneSel) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await cooldown();
      const before = await count(doneSel);
      log(`  ${label}: sending (attempt ${attempt})`);
      aiCalls++;
      bumpUsage("app_ai_turns");
      await send();
      let outcome = "timeout";
      const started = Date.now();
      await rec.fast(async () => {
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
          if (!busy && Date.now() - started > 4000) {
            outcome = "ended without the expected card";
            break;
          }
        }
        await sleep(600); // let the last tokens and the meter settle
      });
      lastAi = Date.now();
      if (outcome === "ok") {
        log(`  ${label}: done in ${Math.round((Date.now() - started) / 1000)} s`);
        return true;
      }
      log(`  ${label}: ${outcome}`);
      state.notes.push(`${label} attempt ${attempt}: ${outcome}`);
      await rec.cut(async () => {
        if (await isBusy()) await page.evaluate(() => [...document.querySelectorAll(".composer button")].find((b) => b.textContent?.trim() === "Stop")?.click());
        if (await exists(".chat-error")) await page.evaluate(() => [...document.querySelectorAll(".chat-error button")].find((b) => b.textContent?.includes("Dismiss"))?.click());
        await waitFor(async () => !(await isBusy()), 10_000);
      });
    }
    return false;
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
   * With PAYMENT_MODE=authorization, Approve with PayPal opens the sandbox approval.
   * Best effort: logs in as PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD and approves (the login selectors
   * are not verified against the live sandbox login page). Without them, run with HEADFUL=1 and approve by hand; the
   * recorder waits up to 3 min for the return to the app (that wait is sped up in the clip).
   */
  async function paypalApprove() {
    log(`  PayPal page: ${new URL(page.url()).host}`);
    state.notes.push("s03: recorded the PayPal sandbox approval.");
    const email = process.env.PAYPAL_BUYER_EMAIL;
    const pass = process.env.PAYPAL_BUYER_PASSWORD;
    const back = () => rec.fast(() => waitFor(() => page.evaluate(() => !location.host.includes("paypal.com")), 180_000));
    if (!email || !pass) {
      log("  Set PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD, or run with HEADFUL=1 and approve by hand within 3 min.");
      return back();
    }
    try {
      await page.waitForSelector("#email", { visible: true, timeout: 30_000 });
      await click(await page.$("#email"));
      await type(email);
      const next = await page.$("#btnNext");
      if (next) {
        await click(next);
        await page.waitForSelector("#password", { visible: true, timeout: 30_000 });
      }
      await click(await page.$("#password"));
      await type(pass, { min: 20, max: 40 });
      await click(await page.$("#btnLogin"));
      const submit = '#payment-submit-btn, [data-testid="submit-button-initial"]';
      await page.waitForSelector(submit, { visible: true, timeout: 45_000 });
      await pause(1500);
      await click(await page.$(submit));
    } catch (e) {
      log(`  PayPal automation stopped (${e.message}); finish by hand with HEADFUL=1 within 3 min.`);
    }
    return back();
  }

  // ------------------------------------------------------------------ scene timing

  const sceneById = Object.fromEntries(cfg.scenes.map((s) => [s.id, s]));
  function timing(id) {
    const scene = sceneById[id];
    const variant = variantFor(scene, state);
    const narr = narrationDur(id, variant);
    if (narr == null) throw new Error(`No narration for ${id}; run TTS first (npm run video -- --tts-only).`);
    const text = variant === "noFlag" ? scene.voiceoverNoFlag : scene.voiceover;
    const offset = scene.prefixCard ? T.titleCard - T.titleXfade : 0; // clip starts this far into the segment
    const cues = sentenceCues(text).map((c) => T.lead + (scene.voiceDelay ?? 0) + c.frac * narr - offset);
    return { min: minClipFor(scene, narr), cues, narr };
  }

  async function scene(id, fn) {
    const idx = appScenes.findIndex((s) => s.id === id);
    if (idx > lastNeeded) return false;
    const on = selected.has(id);
    const t = timing(id);
    log(`Scene ${id}${on ? "" : " (not recorded)"}: narration ${t.narr.toFixed(1)} s, clip ≥ ${t.min.toFixed(1)} s`);
    if (on) await rec.start(id);
    await fn(t);
    if (on) {
      await rec.until(t.min);
      const info = await rec.stop();
      state.clips ??= {};
      state.clips[id] = { dur: info.dur, min: Number(t.min.toFixed(2)), recordedAt: new Date().toISOString() };
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

    // s03: Approve with PayPal (mock rail returns straight to the app), then the active mandate.
    await scene("s03", async ({ cues }) => {
      const approve = await el("button.btn-paypal", { text: "Approve with PayPal" });
      await frameSpan(approve, approve, { align: "center", ms: 700 });
      await pause(300);
      await click(approve);
      await sleep(1500);
      if (/paypal\.com/.test(page.url())) await paypalApprove();
      await rec.fast(async () => {
        const ok = await waitFor(() => page.evaluate(() => !!document.querySelector(".meter .pill-active")), 30_000);
        if (!ok) throw new Error("The mandate never became active after Approve with PayPal.");
        await sleep(500);
      });
      await rec.restartCast();
      if (!(await exists(".mandate-card"))) await nav("Mandate");
      await page.waitForSelector(".mandate-card");
      await pause(500);
      await moveTo(await el(".page-head .pill"), { dx: 30, dy: 8 });
      await pause(600);
      await moveTo(await el(".budget-hero .hero-num"), { dx: 60, dy: 4 });
      await rec.until(cues[2] - 0.4); // "The agent now has spending power …"
      await moveTo(await el(".rules dt", { text: "Spending power" }), { dx: 40, dy: 22 });
      await pause(1200);
      await moveTo(await el(".meter"), { dy: 10 });
    });
    state.mandateMode = await page.evaluate(() => [...document.querySelectorAll(".rules dt")].find((d) => d.textContent === "Spending power")?.nextElementSibling?.textContent ?? null).catch(() => null);

    // s04: delegate a purchase.
    await scene("s04", async ({ cues }) => {
      await click(await el("button", { text: "Talk to the agent" }));
      await page.waitForSelector(".composer input");
      await pause(500);
      await click(await el(".composer input"));
      const ok = await chatTurn(
        "P1",
        async () => {
          await page.evaluate(() => (document.querySelector(".composer input").value = ""));
          await type(P.P1);
          await pause(300);
          await page.keyboard.press("Enter");
        },
        ".msg-agent:not(.msg-sim) .receipt, .msg-agent:not(.msg-sim) .approval",
      );
      if (!ok) throw new Error("P1: no purchase card after two attempts.");
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
      await pause(1600);
      await moveTo(await el(".meter"), { dy: 10 });
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
    await scene("s05", async ({ cues }) => {
      await cooldown();
      const ok = await chatTurn("robot vacuum", () => clickChip(P.vacuumChip), ".msg-agent:not(.msg-sim) .blocked");
      if (!ok) throw new Error("Robot vacuum: no blocked card after two attempts.");
      const blocked = await el(".msg-agent:not(.msg-sim) .blocked");
      const bubble = await page.evaluateHandle((c) => [...document.querySelectorAll(".msg-user")].filter((u) => u.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? c, blocked);
      await frameSpan(bubble.asElement(), blocked, { ms: 900 });
      await pointAt(await el(".reasons-block li", { within: ".msg-agent:not(.msg-sim) .blocked" }));
      await pause(900);
      const strike = await page.$(".msg-agent:not(.msg-sim) .blocked .strike");
      if (strike) await moveTo(strike, { dx: 10 });
      await rec.until(cues[1] - 3.5); // "A sheet set over sixty dollars …"
      let card = null;
      for (const prompt of [P.P2, P.P2_retry]) {
        await click(await el(".composer input"));
        const done = await chatTurn(
          "P2",
          async () => {
            await page.evaluate(() => (document.querySelector(".composer input").value = ""));
            await type(prompt);
            await pause(250);
            await page.keyboard.press("Enter");
          },
          ".msg-agent:not(.msg-sim) .approval, .msg-agent:not(.msg-sim) .receipt",
        );
        if (!done) throw new Error("P2: no card after two attempts.");
        card = await el(".msg-agent:not(.msg-sim) .approval, .msg-agent:not(.msg-sim) .receipt");
        if (await page.evaluate((c) => c.classList.contains("approval"), card)) break;
        state.notes.push(`s05: "${prompt}" was bought directly (≤ $60); retried with the $90 prompt.`);
        card = null;
      }
      if (!card) throw new Error("P2: the sheet set never waited for approval.");
      await frameSpan(card, card, { ms: 1000 });
      await pointAt(await el(".reasons-wait li", { within: ".msg-agent:not(.msg-sim) .approval" }));
      await pause(1800); // let the "Waiting for your OK" card register
      await rec.until(cues[2] - 0.8); // "Nothing is charged until I approve."
      const approveBtn = await el(".card-actions .btn-primary", { within: ".msg-agent:not(.msg-sim) .approval" });
      state.p2Amount = await page.evaluate((b) => b.textContent.trim(), approveBtn);
      await click(approveBtn);
      await waitFor(() => exists(".toast"), 10_000);
      await pause(700);
      await moveTo(await el(".meter"), { dy: 10, ms: 1000 });
      await pause(1000);
    });

    // s06: the flag card (if any), then the hijacked-agent simulation.
    await scene("s06", async ({ cues }) => {
      await waitToastGone();
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
    await scene("s07", async () => {
      await cooldown();
      const ok = await chatTurn("return", () => clickChip(P.returnChip), ".msg-agent:not(.msg-sim) .tool-card.refund");
      if (!ok) state.notes.push("s07: no refund card after two attempts.");
      const card = (await page.$$(".msg-agent:not(.msg-sim) .tool-card.refund")).at(-1) ?? (await el(".msg-agent:not(.msg-sim)"));
      await frameSpan(card, card, { ms: 900 });
      await pointAt(card, { side: "right" });
      await pause(1600);
      await moveTo(await el(".meter"), { dy: 10, ms: 1000 });
    });

    // s08: revoke the mandate.
    await scene("s08", async () => {
      await nav("Mandate");
      await page.waitForSelector(".revoke-panel");
      const panel = await el(".revoke-panel");
      await frameSpan(panel, panel, { ms: 800 });
      await click(await el(".revoke-panel button", { text: "Revoke mandate" }));
      await pause(500);
      await click(await el(".revoke-panel button", { text: "Yes, revoke now" }));
      await waitFor(() => exists(".pill-revoked"), 15_000);
      await pause(900);
      await page.evaluate((ms) => window.__rec.scrollByPx(-1e5, ms), rec.on ? 800 : 1);
      await moveTo(await el(".page-head .pill"), { dx: 20, dy: 8 });
      await pause(1000);
      await nav("Agent");
      await page.waitForSelector(".no-mandate");
      await sleep(700); // the chat scrolls itself to the end on mount
      await page.evaluate((ms) => window.__rec.scrollByPx(-1e5, ms), rec.on ? 700 : 1);
      await moveTo(await el(".no-mandate strong"), { dx: 60, dy: 6 });
      await pause(1200);
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
        await moveTo(k, { dy: 8, ms: 520 });
        await pause(250);
      }
      const cat = await page.$(".cat-spend");
      if (cat) await moveTo(cat, { dx: -150, ms: 700 });
      const grid = await el(".grid-panel");
      await frameSpan(grid, grid, { align: "top", ms: 1000 });
      await click(await el(".search-box input"));
      await type(P.ledgerFilter, { min: 90, max: 140 });
      await pause(1800);
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await pause(500);
      const hij = await page.evaluateHandle(() => [...document.querySelectorAll(".ag-center-cols-container .ag-cell")].find((c) => c.textContent?.includes("hijacked_attempt")) ?? null);
      if (hij.asElement()) {
        await moveTo(hij.asElement(), { dx: 10 });
        await pause(900);
      } else {
        state.notes.push("s09: no agent.hijacked_attempt row visible in the grid.");
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
          await moveTo(hd.asElement(), { dy: 50, ms: 800 });
          await pause(900);
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
    if (rec.on) await rec.stop().catch(() => {});
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
