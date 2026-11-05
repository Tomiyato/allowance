// Drives the running app through the Ribbon demo and records one clip per app scene (clips/<id>.mp4).
//
// One fresh browser session runs the app scenes s02 → s11 in order (each scene needs the state the
// one before left behind). Only the selected scenes are recorded; the others still run, quickly, so
// the state is right. Each clip lasts at least its narration (lead + voiceover + tail), with actions
// synced to the spoken phrases (ElevenLabs alignment, lib.phraseAt), AI waits sped up and AI
// cooldowns cut.
//
// AI calls: Draft with AI (1), "Shop my whole gift list" (1 turn, several model steps), "Return
// Sam's gift" (1). A chat prompt is never resent inside a take (that would leave two identical user
// bubbles). The take restarts in a fresh browser session (new app session, new PayPal authorization),
// up to MAX_TAKES (default 3), when: a turn fails, the draft does not have the five people, the agent
// bought Mom's gift without asking (the script needs it over $45, waiting for an OK), or Sam got no
// gift to return. A cooldown between AI calls (AI_COOLDOWN, default 45 s: Groq allows 8K tokens a
// minute) is cut from the clips.
//
// Scene 3 runs the real PayPal sandbox approval (scripts/video/paypal.mjs) with the visible cursor;
// PayPal's page loads are jump cuts, and the clip marks the PayPal interval so compose shows PayPal's
// host in the window's URL bar meanwhile.
//
// Dry run without AI or PayPal: REC_FIXTURE=1 drives the app's ?fixture=1 mode (an active gift list
// with canned data) through the scenes that need neither (s06-s11) and records them into the cache, to
// test the recorder's selectors and timing. Those clips are not for the video: run the real pipeline after.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { approveOnPayPal, loadBuyerEnv, onPayPal } from "./paypal.mjs";
import { Recorder } from "./recorder.mjs";
import {
  BASE_URL, DIRS, HERE, ROOT, RUN_STATE, STAGE, T, bumpUsage, ensureDirs, findChrome, hasVoice, loadScenes, log, minClipFor,
  narrationDur, phraseAt, readJson, sentenceStarts, sleep, variantFor, writeJson,
} from "./lib.mjs";

const TURN_TIMEOUT = 150_000;
const COOLDOWN = Number(process.env.AI_COOLDOWN ?? 45) * 1000;
const MAX_TAKES = Number(process.env.MAX_TAKES ?? 3);
const ASK_OVER = 45; // the demo list's ask-me threshold
const FIXTURE = process.env.REC_FIXTURE === "1";
const FIXTURE_SKIP = new Set(["s02", "s03", "s04", "s05"]); // they need the AI or PayPal

/** A take that must restart from a fresh session (failed chat turn, unexpected outcome). */
class Retake extends Error {}

export async function record({ only } = {}) {
  const carry = {};
  for (let take = 1; ; take++) {
    try {
      return await recordTake({ only, take, carry });
    } catch (e) {
      if (!(e instanceof Retake) || take >= MAX_TAKES) throw e;
      const wait = 75;
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
  const state = { ...prevState, recordedAt: new Date().toISOString(), base: BASE_URL, take, notes: [], turns: [] };
  carry.discarded ??= [];
  state.discardedTakes = carry.discarded;

  const health = await fetch(`${BASE_URL}/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`The app is not answering at ${BASE_URL}/healthz. Wake it first (see the header of scripts/video/run.mjs).`);
  const mode = await fetch(`${BASE_URL}/api/state`).then((r) => r.json()).catch(() => null);
  state.mode = mode?.mode ?? null;
  log(`Take ${take}. App at ${BASE_URL}: payments=${mode?.mode?.payment} products=${mode?.mode?.products} ai=${mode?.mode?.ai}`);

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

  /** The last (or first) element matching sel, optionally containing text, optionally inside the last `within`. */
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
  const maybe = (sel, opts) => el(sel, opts).catch(() => null);

  let cursorPos = { x: 1180, y: 640 };
  async function moveTo(target, { dx = 0, dy = 0, ms } = {}) {
    const p = target.x != null ? target : await center(target);
    const x = Math.round(p.x + dx);
    const y = Math.round(p.y + dy);
    cursorPos = { x, y };
    await page.evaluate((x, y, ms) => window.__rec.moveTo(x, y, ms), x, y, rec.on ? (ms ?? null) : 1);
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
  const scrollTop = (ms = 900) => page.evaluate((ms) => window.__rec.scrollByPx(-1e5, ms), rec.on ? ms : 1);

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
  const apiState = () => page.evaluate(() => fetch("/api/state", { credentials: "same-origin" }).then((r) => r.json()));

  async function cooldown() {
    if (FIXTURE) return;
    const left = COOLDOWN - (Date.now() - lastAi);
    if (left > 0) {
      log(`  AI cooldown ${Math.round(left / 1000)} s${rec.on ? " (cut)" : ""}`);
      await rec.cut(() => sleep(left));
    }
  }

  /** Which model answered the last chat turn (the server's mode.ai_active). */
  async function noteModel(label) {
    const s = await apiState().catch(() => null);
    const model = s?.mode?.ai_active ?? null;
    state.turns.push({ label, model });
    log(`  ${label}: answered by ${model ?? "? (not reported by the API)"}`);
  }

  /**
   * Sends a chat turn once and waits (sped up) for a new card matching doneSel. A failed turn
   * discards the take (Retake): resending would leave two identical user bubbles on screen.
   */
  async function chatTurn(label, send, doneSel, { max } = {}) {
    await cooldown();
    const before = await count(doneSel);
    log(`  ${label}: sending`);
    aiCalls++;
    bumpUsage("app_ai_turns");
    await send();
    let outcome = "timeout";
    const started = Date.now();
    await rec.fast(
      async () => {
        // A card can settle only after the turn ends (the refund card reads "Refund not completed"
        // until the app state refreshes), so an idle composer gets a grace period before giving up.
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
        await sleep(700); // let the last tokens, the meter and the chat's own scroll settle
      },
      { max },
    );
    lastAi = Date.now();
    await noteModel(label);
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

  /** The real rail is on screen: no MOCK or FIXTURE text, the authorization footer. */
  async function assertReal(id) {
    if (onPayPal(page) || FIXTURE) return;
    const t = await page.evaluate(() => document.body.innerText);
    if (/MOCK|FIXTURE/.test(t)) throw new Error(`${id}: MOCK or FIXTURE text on screen; record against the PAYMENT_MODE=authorization app.`);
    if (!/PayPal sandbox \(authorization\)/.test(t)) throw new Error(`${id}: the footer does not read "PayPal sandbox (authorization)".`);
  }

  async function nav(label) {
    await click(await el(".nav a", { text: label }));
    await page.waitForFunction((l) => document.querySelector(".nav a.active")?.textContent?.trim() === l, {}, label);
    await sleep(rec.on ? 450 : 200);
  }

  /** A row of the last Gift plan card, by person. */
  const planRow = (name) =>
    page.evaluateHandle(
      (name) => [...([...document.querySelectorAll(".msg-agent .gift-plan")].at(-1)?.querySelectorAll(".gp-row") ?? [])].find((r) => r.querySelector(".gp-who strong")?.textContent.trim() === name) ?? null,
      name,
    ).then((h) => h.asElement());
  const rowInfo = (row) =>
    row
      ? row.evaluate((r) => ({
          kind: [...r.classList].find((c) => c.startsWith("gp-") && c !== "gp-row") ?? "?",
          gift: r.querySelector(".gp-gift")?.textContent ?? null,
          price: r.querySelector(".gp-price")?.textContent ?? null,
          capture: r.querySelector(".pp-id code")?.textContent ?? null,
        }))
      : { kind: "missing" };

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
        await type(text, secret ? { min: 25, max: 40 } : { min: 8, max: 16 });
        await pause(150);
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
          await pause(300);
          const amount = await page.evaluateHandle(() => [...document.querySelectorAll("span, p, div")].find((n) => n.children.length === 0 && /\$200\.00/.test(n.textContent)) ?? null);
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
    const lead = T.lead + (scene.voiceDelay ?? 0);
    const cues = sentenceStarts(scene, variant).map((t) => lead + t);
    /** Clip time at which `phrase` is spoken (the scene's narration starts `lead` into the clip). */
    const at = (phrase, opts) => {
      const t = phraseAt(scene, phrase, { variant, ...opts });
      if (t == null) {
        log(`  WARN ${id}: phrase "${phrase}" not in the narration`);
        return 0;
      }
      return lead + t;
    };
    return { min: minClipFor(scene, narr), cues, narr, at };
  }

  async function scene(id, fn) {
    const idx = appScenes.findIndex((s) => s.id === id);
    if (idx > lastNeeded) return false;
    if (FIXTURE && FIXTURE_SKIP.has(id)) return false;
    const on = selected.has(id);
    const t = timing(id);
    // A closing beat that never makes the clip longer than its narration needs.
    t.hold = async (ms) => {
      if (!rec.on) return;
      const left = t.min - rec.elapsed();
      if (left > 0) await sleep(Math.min(ms, left * 1000));
    };
    t.until = (s) => rec.until(s);
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
  const ran = (id) => appScenes.findIndex((x) => x.id === id) <= lastNeeded;

  // ------------------------------------------------------------------ the demo

  try {
    if (FIXTURE) {
      await page.goto(`${BASE_URL}/agent?fixture=1`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".composer input");
    } else {
      await page.goto(`${BASE_URL}/mandate`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#rule");
      const prefilled = await page.$eval("#rule", (n) => n.value);
      if (prefilled.trim() !== P.giftList) throw new Error("The Gift list textarea does not hold the demo list from GIFTLIST_SPEC §2.");
    }
    await page.evaluate(() => document.fonts.ready);
    await sleep(600);

    // s02: the demo list → Draft with AI → five envelopes in the review.
    await scene("s02", async ({ at, until, hold }) => {
      const rule = await el("#rule");
      const rr = await center(rule);
      await moveTo({ x: rr.left + 30, y: rr.top + 34 }, { ms: 700 });
      await moveTo({ x: rr.left + rr.w * 0.8, y: rr.top + 34 }, { ms: 1100 });
      const draftBtn = await el("button", { text: "Draft with AI" });
      await moveTo(draftBtn, { ms: 600 });
      await until(Math.max(0, at("Two hundred") - 2.4));
      await cooldown();
      log("  Draft with AI");
      aiCalls++;
      bumpUsage("app_ai_turns");
      await click(draftBtn);
      await rec.fast(async () => {
        await waitFor(() => exists(".review .rcp-row"), 60_000);
        await waitFor(async () => !(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Drafting")))), 30_000);
        await sleep(400);
      });
      lastAi = Date.now();
      state.turns.push({ label: "draft", model: null });
      const people = await page.$$eval(".review .rcp-row", (rows) => rows.map((r) => `${r.querySelector(".rcp-name input").value} $${r.querySelector(".rcp-env input").value}`));
      log(`  draft: ${people.join(", ") || "no people"}`);
      if (people.length !== 5) throw new Retake(`the draft has ${people.length} people, not 5`);
      state.draft = people;
      const rcp = await el(".review .rcp");
      await frameSpan(rcp, rcp, { ms: 1100 });
      await pointAt(await el(".review .rcp-total strong"), { ms: 600 });
      const rows = await page.$$(".review .rcp-row");
      const marks = ["Mom sixty", "Dad fifty", "Leo", "Sam", "Secret Santa"];
      for (const [i, row] of rows.entries()) {
        await until(at(marks[i]) - 0.25);
        const env = await row.$(".rcp-env");
        await moveTo(env, { dx: 30, dy: 2, ms: 450 });
      }
      await until(at("Ask me") - 0.9);
      const askField = await el(".review .field", { text: "Ask me above" });
      await frameSpan(askField, await el(".review .cat-picker"), { ms: 900 });
      await moveTo(await askField.$("input"), { dx: 40, ms: 500 });
      await until(at("no electronics") - 0.3);
      const elec = await page.evaluateHandle(() => [...document.querySelectorAll(".review .cat-picker fieldset")].at(-1)?.querySelector(".chip.on-block") ?? null);
      if (elec.asElement()) await pointAt(elec.asElement(), { ms: 600 });
      await until(at("Gemini") - 0.5);
      await frameSpan(rcp, rcp, { ms: 900 });
      await until(at("change any") - 0.4);
      await click(await rows[0].$(".rcp-env input"));
      await hold(1200);
    });

    // s03: Approve $200.00 with PayPal → the real sandbox login and approval → the active gift list.
    await scene("s03", async ({ at, until, hold }) => {
      const approve = await el("button.btn-paypal", { text: "with PayPal" });
      await frameSpan(approve, approve, { align: "center", ms: 500 });
      await click(approve);
      await rec.cut(() => waitFor(async () => onPayPal(page) || page.url().includes("/agent"), 45_000));
      if (!onPayPal(page)) throw new Error("The app did not open PayPal (mock rail?).");
      await paypalApprove({ holdReview: 900 });
      await rec.cut(async () => {
        const ok = await waitFor(() => page.evaluate(() => !!document.querySelector(".meter .pill-active")), 45_000);
        if (!ok) throw new Error("The gift list never became active after the PayPal approval.");
        await page.waitForNetworkIdle({ idleTime: 400, timeout: 15_000 }).catch(() => {});
        // PayPal returns to /agent; cut straight to the active gift list.
        if (!(await exists(".mandate-card"))) {
          await page.evaluate(() => [...document.querySelectorAll(".nav a")].find((a) => a.textContent.trim() === "Gift list")?.click());
          await page.waitForSelector(".env-rows", { timeout: 15_000 });
          await sleep(500);
        }
        await page.evaluate(() => (document.scrollingElement.scrollTop = 0));
        await sleep(200);
      });
      await rec.restartCast();
      await page.evaluate((p) => window.__rec?.place(p.x, p.y), cursorPos).catch(() => {});
      await page.waitForSelector(".env-rows");
      await moveTo(await el(".page-head .pill"), { dx: 30, dy: 8, ms: 450 });
      await pause(200);
      await moveTo(await el(".budget-hero .hero-num"), { dx: 70, dy: 4, ms: 450 });
      await until(at("five envelopes") - 1.2);
      const env = await el(".env");
      await frameSpan(env, env, { ms: 800 });
      await pointAt(await el(".env-head .panel-title"), { ms: 450 });
      await moveTo(await el(".env-rows .env-meter", { last: false }), { dy: 10, ms: 600 });
      await pause(300);
      await moveTo(await el(".env-rows .env-meter"), { dy: 10, ms: 900 });
      await pause(300);
      const auth = await page.evaluateHandle(() => [...document.querySelectorAll(".rules dt")].find((d) => d.textContent === "PayPal authorization")?.parentElement ?? null);
      if (auth.asElement()) {
        await frameSpan(env, auth.asElement(), { ms: 700 });
        await moveTo(await auth.asElement().$("code"), { dx: 20, dy: 4, ms: 500 });
      }
      await hold(1000);
    });
    if (ran("s03") && !FIXTURE) {
      const s = await apiState();
      state.authorizationId = s.mandate?.paypal?.authorization_id ?? null;
      state.mandateMode = s.mandate?.paypal?.mode ?? null;
      log(`  PayPal authorization ${state.authorizationId}`);
    }

    // s04: shop the whole list in one pass.
    await scene("s04", async ({ at, until, hold }) => {
      const cta = await el(".cta-row button", { text: "Shop the list" });
      await frameSpan(cta, cta, { align: "center", ms: 600 });
      await click(cta);
      await page.waitForSelector(".composer input");
      await page.waitForSelector("button.chip-suggest");
      await pause(300);
      const chip = await el("button.chip-suggest", { text: P.shopChip });
      await moveTo(chip, { ms: 700 });
      await until(at("shop my whole") + 0.2);
      await chatTurn("shop", () => click(chip), ".msg-agent .gift-plan", { max: 4.5 });
      // Sanity of the take: Mom's gift waits for an OK, Sam has a gift to return.
      const mom = await rowInfo(await planRow("Mom"));
      const sam = await rowInfo(await planRow("Sam"));
      log(`  Mom: ${mom.kind} ${mom.price ?? ""} ${mom.gift ?? ""}; Sam: ${sam.kind} ${sam.price ?? ""}`);
      state.mom = mom;
      if (mom.kind !== "gp-waiting") {
        carry.discarded.push({ take, mom });
        throw new Retake(`Mom's gift is ${mom.kind} at ${mom.price} (the script needs it over $${ASK_OVER}, waiting for an OK)`);
      }
      if (sam.kind !== "gp-bought") throw new Retake(`Sam's row is ${sam.kind}, nothing to return`);
      const search = await el(".msg-agent .gift-search");
      await frameSpan(search, search, { align: "top", ms: 1000 });
      await pointAt(await el(".tool-source", { within: ".msg-agent .gift-search" }), { side: "right", ms: 600 });
      // Pan down the strips while the narration names the search.
      const persons = await page.$$(".msg-agent .gift-search .gs-person");
      const panEnd = Math.max(at("picks one gift") + 1.2, rec.elapsed() + 2);
      const step = (panEnd - rec.elapsed()) / Math.max(1, persons.length);
      for (const p of persons) {
        await frameSpan(p, p, { align: "center", ms: Math.max(500, step * 700) });
        await moveTo(await p.$(".gs-name"), { dx: 60, ms: 400 });
        await until(rec.elapsed() + step * 0.25);
      }
      const flag = (await page.$$(".flag-card")).at(-1);
      state.flagged = Boolean(flag);
      if (flag) {
        await frameSpan(flag, flag, { align: "center", ms: 700 });
        await pointAt(flag, { side: "right", ms: 500 });
        await pause(1200);
      }
      await until(at("Each gift is checked") - 0.6);
      const plan = await el(".msg-agent .gift-plan");
      await frameSpan(plan, plan, { align: "top", ms: 1000 });
      await pointAt(await el(".card-banner strong", { within: ".msg-agent .gift-plan" }), { side: "right", ms: 600 });
      await until(at("PayPal captures") - 0.2);
      const cap = await maybe(".gp-bought .pp-id code", { within: ".msg-agent .gift-plan", last: false });
      if (cap) await moveTo(cap, { dx: 30, ms: 600 });
      await hold(1200);
    });

    // s05: the gift plan, then Mom's approval.
    await scene("s05", async ({ at, until, hold }) => {
      const plan = await el(".msg-agent .gift-plan");
      const firstBought = await maybe(".gp-bought", { within: ".msg-agent .gift-plan", last: false });
      await frameSpan(plan, plan, { ms: 700 });
      if (firstBought) {
        await until(at("the gift,") - 0.2);
        await moveTo(await firstBought.$(".gp-gift"), { dy: 2, ms: 500 });
        await until(at("the price") - 0.2);
        await moveTo(await firstBought.$(".gp-price"), { dx: 30, ms: 450 });
        await until(at("PayPal capture") - 0.2);
        await moveTo(await firstBought.$(".pp-id code"), { dx: 30, ms: 450 });
      }
      await until(at("what's left") - 0.3);
      const foot = await el(".gp-foot", { within: ".msg-agent .gift-plan" });
      await frameSpan(foot, foot, { ms: 600 });
      await pointAt(await foot.$("span"), { ms: 500 });
      await until(at("Mom's gift") - 0.4);
      const mom = await planRow("Mom");
      await frameSpan(mom, mom, { align: "center", ms: 700 });
      const why = await mom.$(".gp-why-wait");
      if (why) await pointAt(why, { ms: 500 });
      const btn = await mom.$(".gp-actions .btn-primary");
      state.momAmount = await btn.evaluate((b) => b.textContent.trim());
      await moveTo(btn, { ms: 700 });
      await until(at("One click") - 0.1);
      await click(btn);
      await rec.fast(() => waitFor(async () => (await rowInfo(await planRow("Mom"))).kind === "gp-bought", 20_000));
      await pause(400);
      const after = await rowInfo(await planRow("Mom"));
      state.momCapture = after.capture;
      log(`  Mom approved: ${after.kind} ${after.capture}`);
      if (after.kind !== "gp-bought") state.notes.push(`s05: Mom's row is ${after.kind} after Approve.`);
      const momCode = await (await planRow("Mom"))?.$(".pp-id code");
      if (momCode) await moveTo(momCode, { dx: 30, ms: 500 });
      await pause(600);
      await pointAt(await (await el(".gp-foot", { within: ".msg-agent .gift-plan" })).$("strong"), { side: "right", ms: 600 });
      await hold(1500);
    });

    // s06: the poisoned listing, then the hijacked-agent simulation.
    await scene("s06", async ({ at, until }) => {
      await page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => {});
      // The listing that hides an order: the flag card if the agent raised one, else the tile in Mom's options.
      const flag = (await page.$$(".flag-card")).at(-1);
      const tile = await page.evaluateHandle(() => [...document.querySelectorAll(".msg-agent .gift-search .gift-tile")].find((t) => /Deluxe Herb Seed/i.test(t.textContent)) ?? null).then((h) => h.asElement());
      const target = flag ?? tile;
      state.injectionShown = flag ? "flag-card" : tile ? "tile" : "none";
      if (target) {
        if (!flag) {
          await tile.evaluate((t) => {
            const strip = t.closest(".gs-strip");
            if (strip) strip.scrollLeft += t.getBoundingClientRect().left - strip.getBoundingClientRect().left - 40;
          });
        }
        await frameSpan(target, target, { align: "center", ms: 1200 });
        await pointAt(target, { side: flag ? "right" : "left", ms: 600 });
      }
      await until(at("Models can be fooled") - 0.3);
      await scrollTop(1100);
      await pause(200);
      await moveTo(await el(".safety-demo .safety-line"), { dx: -40, ms: 700 });
      const btn = await el(".safety-demo button");
      await until(at("this button") - 0.3);
      await click(btn);
      await rec.fast(async () => {
        await page.waitForSelector(".msg-sim .blocked", { timeout: 30_000 });
        await sleep(1400); // the chat's own smooth scroll to the new card
      });
      const sim = await el(".msg-sim");
      await frameSpan(sim, sim, { align: "top", ms: 900 });
      await moveTo(await el(".msg-sim .sim-banner strong"), { dx: 40, ms: 500 });
      await until(at("Five gift boxes") - 0.3);
      const attempt = await maybe(".msg-sim .attempt");
      if (attempt) {
        await frameSpan(sim, attempt, { ms: 600 });
        await pointAt(attempt, { ms: 500 });
      }
      await until(at("Blocked:") - 0.3);
      const reasons = await page.$$(".msg-sim .reasons-block li");
      if (reasons.length) await frameSpan(await el(".msg-sim .card-banner"), reasons.at(-1), { ms: 600 });
      await pointAt(reasons[0], { ms: 400 });
      await until(at("over Mom's envelope") - 0.2);
      const env = (await Promise.all(reasons.map(async (r) => ((await r.evaluate((n) => n.textContent)).includes("envelope") ? r : null)))).find(Boolean) ?? reasons[1];
      if (env) await pointAt(env, { ms: 400 });
      state.hijackReasons = await page.$$eval(".msg-sim .reasons-block li", (ls) => ls.map((l) => l.textContent.trim()));
    });

    // s07: return Sam's gift.
    await scene("s07", async ({ at, until, hold }) => {
      const chip = await el("button.chip-suggest", { text: P.returnChip });
      await moveTo(chip, { ms: 900 });
      await until(at("Return Sam") + 0.1);
      await chatTurn("return", () => click(chip), ".msg-agent .tool-card.refund", { max: 2.4 });
      const card = (await page.$$(".msg-agent .tool-card.refund")).at(-1);
      await frameSpan(card, card, { ms: 800 });
      await pointAt(await card.$(".card-banner span"), { ms: 500 });
      await until(at("his thirty") - 0.2);
      await moveTo(await card.$(".card-banner span"), { dx: 120, ms: 700 });
      await pause(600);
      const rid = await card.$(".pp-id code");
      if (rid) await moveTo(rid, { dx: 30, ms: 500 });
      await pause(700);
      await moveTo(await el(".meter"), { dy: 10, ms: 800 });
      await hold(1200);
    });
    if (ran("s07")) {
      await assertNoDuplicateBubbles();
      const refund = await page.evaluate(() => [...document.querySelectorAll(".tool-card.refund")].at(-1)?.innerText ?? "");
      state.refundText = refund.split("\n").slice(0, 2).join(" ");
      if (!/Sam's envelope has \$30\.00 again/.test(refund)) state.notes.push(`s07: refund card reads "${state.refundText}"`);
    }

    // s08: the ledger.
    await scene("s08", async ({ at, until }) => {
      await click(await el(".nav a", { text: "Ledger" }));
      // The Ledger page (AG Grid) is lazy-loaded: cut its blank loading panel.
      await rec.cut(async () => {
        await page.waitForFunction(() => document.querySelector(".nav a.active")?.textContent?.trim() === "Ledger");
        await page.waitForSelector(".gift-grid .ag-row", { timeout: 30_000 });
        await page.waitForSelector(".grid-panel:not(.gift-grid) .ag-row", { timeout: 30_000 });
        await sleep(700);
      });
      await rec.restartCast();
      const gg = await el(".gift-grid");
      await frameSpan(gg, gg, { align: "top", ms: 900 });
      const header = async (grid, name) =>
        page.evaluateHandle((grid, name) => [...document.querySelectorAll(`${grid} .ag-header-cell`)].find((c) => c.textContent?.trim() === name) ?? null, grid, name).then((h) => h.asElement());
      for (const [phrase, col] of [["each person", "Recipient"], ["their envelope", "Envelope"], ["the gift and", "Gift"], ["PayPal capture", "PayPal capture"]]) {
        await until(at(phrase) - 0.25);
        const h = await header(".gift-grid", col);
        if (h) await moveTo(h, { dy: 46, ms: 450 });
      }
      await until(at("Below it") - 0.3);
      const lg = await el(".grid-panel:not(.gift-grid)");
      await frameSpan(lg, lg, { align: "top", ms: 1000 });
      const rows = await page.$$(".grid-panel:not(.gift-grid) .ag-center-cols-container .ag-row");
      for (const r of rows.slice(0, 4)) {
        await moveTo(r, { dx: -120, ms: 420 });
        await pause(80);
      }
      await until(at("the blocked attempt") - 1.6);
      await click(await el(".search-box input"));
      await type(P.ledgerFilter, { min: 90, max: 130 });
      await pause(300);
      const red = await maybe(".grid-panel:not(.gift-grid) .ag-row.row-deny", { last: false });
      if (red) await moveTo(red, { dx: -100, ms: 600 });
      await pause(1000);
      await click(await el(".search-box input"));
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await pause(250);
      const rh = await header(".grid-panel:not(.gift-grid)", "Recipient");
      if (rh) await moveTo(rh, { dy: 50, ms: 500 });
      await pause(400);
      await page.evaluate((ms) => {
        const vp = [...document.querySelectorAll(".grid-panel:not(.gift-grid) .ag-body-horizontal-scroll-viewport, .grid-panel:not(.gift-grid) .ag-center-cols-viewport")][0];
        if (vp) return window.__rec.scrollElX(vp, vp.scrollWidth, ms);
      }, rec.on ? 900 : 1);
      await pause(150);
      const ph = await header(".grid-panel:not(.gift-grid)", "PayPal ID");
      if (ph) await moveTo(ph, { dy: 50, ms: 500 });
      await pause(700);
    });

    // s09: revoke, then the paypal.void row in the ledger.
    await scene("s09", async ({ at, until, hold }) => {
      await nav("Gift list");
      await page.waitForSelector(".revoke-panel");
      const panel = await el(".revoke-panel");
      await frameSpan(panel, panel, { ms: 700 });
      await click(await el(".revoke-panel button", { text: "Revoke gift list" }));
      await pause(250);
      const yes = await el(".revoke-panel button", { text: "Yes, revoke now" });
      await moveTo(yes, { ms: 400 });
      await until(at("revokes it") - 0.2);
      await click(yes);
      await rec.fast(() => waitFor(() => exists(".pill-revoked"), 20_000)); // PayPal voids the authorization
      await pause(300);
      await scrollTop(700);
      await moveTo(await el(".page-head .pill"), { dx: 20, dy: 8, ms: 500 });
      await until(at("PayPal releases") - 1.4);
      await nav("Ledger");
      await page.waitForSelector(".grid-panel:not(.gift-grid) .ag-row");
      await sleep(300);
      const lg = await el(".grid-panel:not(.gift-grid)");
      await frameSpan(lg, lg, { align: "top", ms: 800 });
      const voidCell = await page.evaluateHandle(() => [...document.querySelectorAll(".grid-panel:not(.gift-grid) .ag-cell")].find((c) => c.textContent?.trim() === "paypal.void") ?? null).then((h) => h.asElement());
      if (voidCell) {
        const summary = await voidCell.evaluate((c) => c.parentElement.querySelector('[col-id="summary"]')?.textContent?.trim() ?? null);
        state.voidSummary = summary;
        log(`  paypal.void: ${summary}`);
        const sc = await maybe('.grid-panel:not(.gift-grid) .ag-row [col-id="summary"]', { text: summary ?? "voided" });
        await moveTo(sc ?? voidCell, { dx: sc ? -40 : 30, ms: 600 });
      } else {
        state.notes.push("s09: no paypal.void row in the ledger.");
      }
      await hold(1600);
    });

    // s11: back to the revoked gift list, a slow scroll over the envelopes.
    await scene("s11", async () => {
      await nav("Gift list");
      await page.waitForSelector(".env-rows");
      await page.evaluate((ms) => window.__rec.scrollByPx(330, ms), rec.on ? 2200 : 1);
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
    const final = await apiState().catch(() => null);
    if (final) {
      state.purchases = final.purchases.map((p) => ({ for: final.mandate?.recipients.find((r) => r.id === p.recipient_id)?.name ?? null, total: p.total, status: p.status, capture: p.paypal.capture_id, refund: p.paypal.refund_id, title: p.items[0]?.title }));
    }
    writeJson(RUN_STATE(), { ...readJson(RUN_STATE(), {}), ...state, clips: { ...(prevState.clips ?? {}), ...(state.clips ?? {}) } });
    if (problems.length) log("Problems seen:\n  " + problems.join("\n  "));
    await browser.close();
  }
  log(`Recording done: ${aiCalls} AI turn(s) sent to the app.`);
  if (only?.length && only.length < appScenes.length) log("Note: a partial re-record runs in a new session; amounts and IDs can differ from the other clips. Re-record s02-s11 together for continuity.");
  return state;
}

// Keep the hasVoice import used (scenes without narration set their own minimum clip length).
void hasVoice;
