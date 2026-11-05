// PayPal sandbox buyer approval, shared by scripts/screenshots.mjs and the video recorder.
//
// Verified against the live sandbox checkout (2026-11-04, US buyer, Orders v2 AUTHORIZE with
// payment_source.paypal.experience_context):
//   1. www.sandbox.paypal.com/checkoutnow      (sometimes a cookie banner: #acceptAllButton)
//                                               email step:    #email, #btnNext
//   2. same page                                password step: #password, #btnLogin
//   3. /webapps/hermes … useraction=CONTINUE    "Pay with" page (merchant "Ribbon", the $200.00);
//                                               [data-testid=submit-button-initial] "Continue to Review Order"
//   4. redirect to <app>/paypal/return → /agent (no separate review page in this flow)
// The loop is a small state machine (detect → act → wait for a change), so it also copes with
// variants PayPal shows to other buyers: email and password on one page, a review page with
// "Continue", "Agree and continue" or "Complete Purchase", an already logged-in buyer. A step
// that does not change the page is retried, then it fails with the step's name.
//
// Credentials: PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD, loaded from .env by Node
// (loadBuyerEnv); never printed.
import { existsSync } from "node:fs";
import { join } from "node:path";

const SUBMIT_TEXT = /^(Continue to Review Order|Continue|Agree and continue|Agree & Continue|Complete Purchase|Pay Now|Agree and Pay|Save and Continue)$/i;
const SUBMIT_SEL = '[data-testid="submit-button-initial"], #payment-submit-btn, [data-testid="submit-button"]';

/** Loads PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD from <root>/.env into process.env (Node parser, no shell). */
export function loadBuyerEnv(root) {
  if (process.env.PAYPAL_BUYER_EMAIL && process.env.PAYPAL_BUYER_PASSWORD) return true;
  const file = join(root, ".env");
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* unreadable .env */
    }
  }
  return Boolean(process.env.PAYPAL_BUYER_EMAIL && process.env.PAYPAL_BUYER_PASSWORD);
}

export function onPayPal(page) {
  try {
    return /(^|\.)paypal\.com$/.test(new URL(page.url()).host);
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What the PayPal page asks for now: back | cookie | email | emailNext | password | submit | wait.
 * "Visible" means on screen and not covered by something unrelated (PayPal keeps the hidden
 * password step in the DOM with a size, so a box check alone is not enough).
 */
async function detect(page) {
  if (!onPayPal(page)) return { kind: "back" };
  return page
    .evaluate(
      (submitSel, submitSrc) => {
        const re = new RegExp(submitSrc, "i");
        const vis = (e) => {
          if (!e || e.disabled) return false;
          const r = e.getBoundingClientRect();
          if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight * 3 || r.left > innerWidth) return false;
          for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false;
            if (n.getAttribute("aria-hidden") === "true" || n.hidden || n.inert) return false;
          }
          if (r.top >= 0 && r.top < innerHeight) {
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
            const box = e.closest("div, form") ?? e.parentElement;
            if (hit && !e.contains(hit) && !hit.contains(e) && !box?.contains(hit)) return false;
          }
          return true;
        };
        const text = (b) => (b.textContent || b.value || "").trim();
        const cookie = document.querySelector("#acceptAllButton");
        if (vis(cookie)) return { kind: "cookie" };
        const email = document.querySelector("#email");
        const pass = document.querySelector("#password");
        const emailVis = vis(email);
        const passVis = vis(pass);
        if (emailVis && !email.value) return { kind: "email", withPassword: passVis };
        if (passVis && !pass.value) return { kind: "password" };
        const nextBtn = document.querySelector("#btnNext");
        if (emailVis && email.value && vis(nextBtn)) return { kind: "emailNext" };
        const submit = [...document.querySelectorAll(submitSel)].find(vis) ?? [...document.querySelectorAll("button, input[type=submit]")].find((b) => vis(b) && re.test(text(b)));
        if (submit) return { kind: "submit", label: text(submit) };
        return { kind: "wait" };
      },
      SUBMIT_SEL,
      SUBMIT_TEXT.source,
    )
    .catch(() => ({ kind: "wait" })); // mid-navigation
}

async function submitHandle(page) {
  const h = await page.evaluateHandle(
    (submitSel, submitSrc) => {
      const re = new RegExp(submitSrc, "i");
      const ok = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.disabled;
      };
      return (
        [...document.querySelectorAll(submitSel)].find(ok) ??
        [...document.querySelectorAll("button, input[type=submit]")].find((b) => ok(b) && re.test((b.textContent || b.value || "").trim())) ??
        null
      );
    },
    SUBMIT_SEL,
    SUBMIT_TEXT.source,
  );
  return h.asElement();
}

/** Plain puppeteer actions (the gallery script). The recorder passes visible-cursor versions. */
export const plainUi = {
  async click(page, el) {
    await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
    await sleep(150);
    await el.click();
  },
  async type(page, el, text) {
    await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
    await el.click();
    await page.keyboard.type(text, { delay: 25 });
  },
  /** Runs fn while PayPal loads (the recorder speeds this up or cuts it). */
  wait: (fn) => fn(),
};

const keyOf = (page, s) => `${s.kind}|${s.label ?? ""}|${(() => {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return "";
  }
})()}`;

/**
 * Logs in as the sandbox buyer and approves, until the browser leaves paypal.com.
 * onStep(kind, state) runs before each action: "email", "password", "submit" (state.label); and
 * "back" once the app has the browser again. Returns the steps taken.
 */
export async function approveOnPayPal(page, { email, password, ui = plainUi, onStep = async () => {}, timeout = 180_000, log = () => {} } = {}) {
  email ??= process.env.PAYPAL_BUYER_EMAIL;
  password ??= process.env.PAYPAL_BUYER_PASSWORD;
  if (!email || !password) throw new Error("PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD are not set.");
  const end = Date.now() + timeout;
  const steps = [];
  const tries = new Map();

  /** Waits until the page asks for something (not "wait"), or until it differs from `prevKey`. */
  const settle = (prevKey, maxMs) =>
    ui.wait(async () => {
      const stop = Math.min(end, Date.now() + maxMs);
      let s = { kind: "wait" };
      while (Date.now() < stop) {
        s = await detect(page);
        if (s.kind === "back") return s;
        // A step is ready once it is stable for a moment (PayPal animates between steps).
        if (s.kind !== "wait" && keyOf(page, s) !== prevKey) {
          await sleep(350);
          const again = await detect(page);
          if (again.kind === s.kind) return again;
        }
        await sleep(250);
      }
      return s;
    });

  let state = await settle(null, 60_000);
  while (state.kind !== "back") {
    if (Date.now() > end) throw new Error(`Still on PayPal after ${Math.round(timeout / 1000)} s (last step: ${state.kind}).`);
    if (state.kind === "wait") {
      state = await settle(null, 30_000);
      if (state.kind === "wait") throw new Error("PayPal page shows nothing to act on.");
      continue;
    }
    const key = keyOf(page, state);
    const n = (tries.get(key) ?? 0) + 1;
    tries.set(key, n);
    if (n > 3) throw new Error(`PayPal page stuck at the ${state.kind} step.`);
    log(`PayPal step: ${state.kind}${state.label ? ` (${state.label})` : ""}${n > 1 ? `, retry ${n - 1}` : ""}`);
    steps.push(state.kind === "submit" ? `submit:${state.label}` : state.kind);

    if (state.kind === "cookie") {
      await page.click("#acceptAllButton").catch(() => {});
    } else if (state.kind === "email") {
      await onStep("email", state);
      await ui.type(page, await page.$("#email"), email, { secret: false });
      if (state.withPassword) {
        await ui.type(page, await page.$("#password"), password, { secret: true });
        await ui.click(page, await page.$("#btnLogin"));
      } else {
        const btn = await page.$("#btnNext");
        if (btn) await ui.click(page, btn);
        else await page.keyboard.press("Enter");
      }
    } else if (state.kind === "emailNext") {
      await ui.click(page, await page.$("#btnNext"));
    } else if (state.kind === "password") {
      await onStep("password", state);
      await ui.type(page, await page.$("#password"), password, { secret: true });
      const btn = await page.$("#btnLogin");
      if (btn) await ui.click(page, btn);
      else await page.keyboard.press("Enter");
    } else if (state.kind === "submit") {
      await onStep("submit", state);
      const btn = await submitHandle(page);
      if (btn) await ui.click(page, btn);
    }
    state = await settle(key, 20_000);
  }
  await onStep("back", state);
  steps.push("back");
  return steps;
}
