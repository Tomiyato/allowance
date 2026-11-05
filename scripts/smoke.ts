// End-to-end smoke test of the gift list (GIFTLIST_SPEC §4) against a running server.
// Uses the real AI model (Gemini, Groq fallback) and whatever payment rail the server runs.
//
//   PORT=3201 PAYMENT_MODE=mock npm start          # terminal 1
//   BASE_URL=http://localhost:3201 npm run smoke    # terminal 2
//
// With PAYMENT_MODE=authorization the approve URL is a real PayPal sandbox page: the script logs in
// headless as PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD (read from .env by Node, never printed) with
// the same helper the screenshot and video scripts use (scripts/video/paypal.mjs, puppeteer-core).
//
// Env: BASE_URL (or SMOKE_URL), else http://localhost:$PORT (default 3000); SMOKE_PAUSE_MS (default
// 65000) between LLM-heavy phases for the Gemini free tier (5 requests/minute); CHROME_PATH.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { AppState, Mandate, Purchase, RecipientStatus } from "../shared/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL ?? process.env.SMOKE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
let cookie = "";
const failures: string[] = [];
const PAUSE_MS = Number(process.env.SMOKE_PAUSE_MS ?? 65_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GIFTLIST_SPEC §2. */
const DEMO_LIST =
  "Holiday gifts, $200 total. Mom $60, she loves gardening. Dad $50, coffee nerd. My nephews Leo $30 (dinosaurs) and Sam $30 (soccer). " +
  "Office Secret Santa $30, something for the desk. Ask me before anything over $45. No electronics.";
const DEMO_ENVELOPES: Record<string, number> = { mom: 60, dad: 50, leo: 30, sam: 30, "office secret santa": 30 };

function check(cond: unknown, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures.push(label);
}

async function http(method: string, path: string, body?: unknown, redirect: "follow" | "manual" = "follow") {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await http(method, path, body);
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data as T;
}

const MONEY_TOOLS = new Set(["propose_purchase", "buy_gift_plan", "request_refund"]);

/** Parse the SSE UI message stream into chunks, then rebuild the assistant message the way useChat does. */
async function chat(history: UIMessage[], text: string): Promise<{ messages: UIMessage[]; assistant: UIMessage; error?: string }> {
  const user: UIMessage = { id: `u_${Date.now()}`, role: "user", parts: [{ type: "text", text }] };
  const messages = [...history, user];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await http("POST", "/api/chat", { id: "smoke", messages, trigger: "submit-message" });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat -> ${res.status}: ${await res.text()}`);
    const raw = await res.text();
    const chunks: UIMessageChunk[] = [];
    let error: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      const c = JSON.parse(data) as UIMessageChunk;
      if (c.type === "error") error = (c as any).errorText;
      chunks.push(c);
    }
    // Retry an errored or silent turn only if no money-moving tool ran: retrying after one could buy twice.
    const moneyRan = chunks.some((c) => c.type === "tool-input-available" && MONEY_TOOLS.has((c as any).toolName));
    const said = chunks.some((c) => c.type === "text-delta" && (c as any).delta?.trim());
    if ((error || !said) && !moneyRan && attempt < 3) {
      console.log(`  (${error ? error.slice(0, 80) : "the agent stopped without an answer or a purchase"}; waiting 65s before retry ${attempt + 1}/3)`);
      await sleep(65_000);
      continue;
    }
    const stream = new ReadableStream<UIMessageChunk>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(c);
        ctrl.close();
      },
    });
    let assistant: UIMessage | undefined;
    try {
      for await (const m of readUIMessageStream({ stream })) assistant = m;
    } catch {
      /* error chunk ends the reader; keep what was built */
    }
    assistant ??= { id: `a_${Date.now()}`, role: "assistant", parts: [] };
    return { messages: [...messages, assistant], assistant, error };
  }
  throw new Error("unreachable");
}

const purchaseLine = (p: any) => `${p.status} $${p.total} (${p.items.map((i: any) => `${i.qty}x ${i.title}`).join(", ") || "no known items"})`;

function describeAssistant(m: UIMessage) {
  for (const p of m.parts as any[]) {
    if (p.type === "text" && p.text.trim()) console.log(`  agent: ${p.text.trim().replace(/\s+/g, " ").slice(0, 900)}`);
    else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      const out = p.output;
      let detail = "";
      if (p.type === "tool-search_products") detail = `"${p.input?.query}" ${out?.products?.length ?? 0} products from ${out?.source}`;
      else if (p.type === "tool-search_gifts")
        detail = (out?.results ?? []).map((r: any) => `${r.recipient_name}: "${r.query}" ${r.products.length}`).join("; ") + ` (${out?.source})`;
      else if (p.type === "tool-buy_gift_plan")
        detail = (out?.results ?? []).map((r: any) => `${r.recipient_name}: ${r.purchase ? purchaseLine(r.purchase) : `error ${r.error}`}`).join("; ");
      else if (p.type === "tool-report_suspicious_content") detail = `flagged ${out?.product_title ?? p.input?.product_id}`;
      else if (out?.purchase) detail = purchaseLine(out.purchase);
      console.log(`  tool: ${p.type.slice(5)} [${p.state}] ${detail}`);
    }
  }
}

const toolNames = (m: UIMessage) => (m.parts as any[]).filter((p) => p.type?.startsWith("tool-")).map((p) => p.type.slice(5) as string);
const state = () => json<AppState>("GET", "/api/state");
const byName = (st: AppState, name: string) => st.recipients.find((r) => r.recipient.name.toLowerCase() === name);
const purchaseOf = (st: AppState, id: string) => st.purchases.find((p) => p.id === id);

function printList(st: AppState) {
  for (const r of st.recipients) {
    const latest = r.purchase_ids.map((id) => purchaseOf(st, id)).find(Boolean);
    const gift = latest ? `${latest.items.map((i) => i.title).join(", ")} $${latest.total} [${latest.status}]` : "-";
    const why = latest && latest.status === "blocked" ? ` reasons: ${latest.reasons.join(" ")}` : "";
    console.log(`  ${r.recipient.name.padEnd(20)} envelope $${r.recipient.envelope} spent $${r.spent} left $${r.remaining} ${r.state.padEnd(16)} ${gift}${why}`);
  }
}

// ------------------------------------------------------------ PayPal sandbox approval (headless)

async function approveInPayPal(approveUrl: string) {
  const helper = pathToFileURL(join(ROOT, "scripts/video/paypal.mjs")).href;
  const { approveOnPayPal, loadBuyerEnv, onPayPal } = (await import(helper)) as any;
  if (!loadBuyerEnv(ROOT)) throw new Error("PayPal sandbox approval needs PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD in .env.");
  const { default: puppeteer } = await import("puppeteer-core");
  const local = process.env.LOCALAPPDATA ?? "";
  const chrome =
    process.env.CHROME_PATH ??
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      join(local, "Google/Chrome/Application/chrome.exe"),
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((p) => existsSync(p));
  if (!chrome) throw new Error("No Chrome found for the PayPal approval. Set CHROME_PATH.");
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--lang=en-US"] });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    page.setDefaultTimeout(60_000);
    await page.goto(approveUrl, { waitUntil: "domcontentloaded" });
    const steps: string[] = await approveOnPayPal(page, { log: (m: string) => console.log(`  ${m}`) });
    console.log(`  PayPal steps: ${steps.join(" -> ")}`);
    // The return URL finalizes the authorization on our server (it finds the session by mandate id).
    const end = Date.now() + 60_000;
    while (Date.now() < end && (onPayPal(page) || !page.url().startsWith(BASE))) await sleep(500);
    console.log(`  browser back at ${page.url().replace(/\?.*/, "")}`);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------ main

async function main() {
  console.log(`Smoke test against ${BASE}`);
  const health = await fetch(`${BASE}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`Server not reachable at ${BASE}. Start it with npm start.`);

  console.log("\n1. Parse the demo gift list");
  const parsed = await json<{ mandate: Mandate; source: string; warning?: string }>("POST", "/api/mandates/parse", { text: DEMO_LIST });
  const d = parsed.mandate;
  console.log(`  draft (${parsed.source}${parsed.warning ? `, warning: ${parsed.warning}` : ""}): "${d.title}" total=$${d.budget_total} ask>$${d.per_purchase_approval_over} allowed=[${d.allowed_categories}] blocked=[${d.blocked_categories}] qty<=${d.max_quantity_per_item} expires=${d.expires_at}`);
  for (const r of d.recipients) console.log(`    ${r.id} ${r.name} $${r.envelope} "${r.interests}"`);
  check(d.recipients.length === 5, `5 recipients (${d.recipients.map((r) => r.name).join(", ")})`);
  check(
    d.recipients.every((r) => DEMO_ENVELOPES[r.name.toLowerCase()] === r.envelope),
    "names and envelopes Mom 60, Dad 50, Leo 30, Sam 30, Office Secret Santa 30",
  );
  check(d.budget_total === 200, "total = 200 (sum of the envelopes)");
  check(d.per_purchase_approval_over === 45, "ask-me threshold = 45");
  check(d.blocked_categories.includes("electronics") && !d.allowed_categories.includes("electronics"), "electronics blocked");
  check(Date.parse(d.expires_at) <= Date.now() + 29 * 864e5 + 60_000, "expiry within the 29-day PayPal hold");
  check(d.status === "draft", "status draft");
  if (d.recipients.length === 0) throw new Error("The parse returned no recipients; the rest of the smoke needs a gift list.");

  console.log("\n2. Create + approve the gift list");
  const { mandate } = await json<{ mandate: Mandate }>("POST", "/api/mandates", { mandate: d });
  check(mandate.recipients.map((r) => r.id).join() === d.recipients.map((r) => r.id).join(), "recipient ids from the draft are kept");
  const { approveUrl } = await json<{ approveUrl: string }>("POST", `/api/mandates/${mandate.id}/approve`);
  console.log(`  approveUrl: ${approveUrl.replace(/token=[^&]+/, "token=…")}`);
  if (/^https:\/\/www\.(sandbox\.)?paypal\.com\//.test(approveUrl)) {
    if (approveUrl.startsWith("https://www.paypal.com/")) throw new Error("Refusing to approve on live PayPal; the smoke runs on the sandbox only.");
    await approveInPayPal(approveUrl);
  } else {
    const ret = await http("GET", approveUrl.replace(/^https?:\/\/[^/]+/, ""), undefined, "manual");
    check(ret.status === 302 && ret.headers.get("location") === "/agent", "PayPal return redirects to /agent");
  }
  let st = await state();
  check(st.mandate?.status === "active", `gift list active (payment ${st.mode.payment}, products ${st.mode.products}, ai ${st.mode.ai})`);
  if (st.mandate?.paypal.authorization_id) console.log(`  authorization ${st.mandate.paypal.authorization_id}`);
  check(st.recipients.length === 5 && st.recipients.every((r) => r.state === "to_buy"), "5 recipients, all to_buy");

  console.log(`\n3. Chat: shop the whole gift list (pause ${PAUSE_MS / 1000}s for the free-tier rate limit)`);
  await sleep(PAUSE_MS);
  let convo = await chat([], "Shop my whole gift list");
  describeAssistant(convo.assistant);
  if (convo.error) console.log(`  stream error: ${convo.error}`);
  st = await state();
  console.log(`  answered by: ${st.mode.ai_active}`);
  const tools = toolNames(convo.assistant);
  check(tools.includes("search_gifts") && tools.includes("buy_gift_plan"), `used search_gifts and buy_gift_plan (${tools.join(", ")})`);
  printList(st);
  const covered = st.recipients.filter((r) => r.state === "bought" || r.state === "waiting_approval");
  check(covered.length >= 4, `at least 4 recipients bought or waiting (${covered.length})`);
  const noneOver = (s: AppState) => s.recipients.every((r) => r.spent <= r.recipient.envelope + 1e-9);
  check(noneOver(st), "no envelope exceeded");
  const live = st.purchases.filter((p) => p.status === "charged" || p.status === "pending_approval").flatMap((p) => p.items.map((i) => i.product_id));
  check(new Set(live).size === live.length, `no duplicate product (${live.length} gifts)`);

  console.log("\n4. Mom's gift over $45 waits for approval; approving it charges it");
  let mom = byName(st, "mom")!;
  let momPending = mom.purchase_ids.map((id) => purchaseOf(st, id)!).find((p) => p.status === "pending_approval" && p.total > 45);
  if (!momPending) {
    console.log(`  Mom has no pending gift over $45 after the list run (state ${mom.state}); asking for one directly.`);
    const charged = mom.purchase_ids.map((id) => purchaseOf(st, id)!).find((p) => p.status === "charged");
    if (charged) {
      await json("POST", `/api/purchases/${charged.id}/refund`, { reason: "Swap for a bigger gift" });
      console.log(`  refunded Mom's ${purchaseLine(charged)} to free her envelope`);
    }
    await sleep(PAUSE_MS);
    // Fresh conversations from here on: the gift list state lives on the server, and a short history keeps a
    // turn inside the Groq fallback's 8k tokens/minute.
    convo = await chat([], "For Mom, buy one gardening gift that costs between $46 and $60.");
    describeAssistant(convo.assistant);
    st = await state();
    mom = byName(st, "mom")!;
    momPending = mom.purchase_ids.map((id) => purchaseOf(st, id)!).find((p) => p.status === "pending_approval" && p.total > 45);
  }
  check(momPending, `Mom's gift over $45 is pending_approval${momPending ? ` (${purchaseLine(momPending)}: ${momPending.reasons.join(" ")})` : ""}`);
  if (momPending) {
    const { purchase } = await json<{ purchase: Purchase }>("POST", `/api/purchases/${momPending.id}/approve`);
    st = await state();
    mom = byName(st, "mom")!;
    check(purchase.status === "charged" && purchase.paypal.capture_id, `approved and charged (capture ${purchase.paypal.capture_id})`);
    check(mom.state === "bought" && mom.spent <= mom.recipient.envelope, `Mom bought, $${mom.spent} of $${mom.recipient.envelope}`);
  }

  console.log(`\n5. Chat: robot vacuum (pause ${PAUSE_MS / 1000}s)`);
  await sleep(PAUSE_MS);
  const before = new Set(st.purchases.map((p) => p.id));
  convo = await chat([], "Order a robot vacuum");
  describeAssistant(convo.assistant);
  if (convo.error) console.log(`  stream error: ${convo.error}`);
  st = await state();
  const vac = st.purchases.filter((p) => !before.has(p.id));
  for (const p of vac) console.log(`  ${p.status}: ${p.reasons.join(" ")}`);
  check(vac.some((p) => p.status === "blocked"), `robot vacuum denied (${vac.map((p) => p.status).join(", ") || "no proposal"})`);
  check(!vac.some((p) => p.status === "charged"), "robot vacuum was NOT charged");

  console.log("\n6. Refund restores that recipient's envelope");
  const refundable = st.recipients
    .filter((r) => r.recipient.name.toLowerCase() !== "mom")
    .map((r) => ({ r, p: r.purchase_ids.map((id) => purchaseOf(st, id)!).find((p) => p.status === "charged") }))
    .find((x) => x.p);
  if (refundable?.p) {
    const { r, p } = refundable;
    const remBefore = st.remaining;
    const { purchase } = await json<{ purchase: Purchase }>("POST", `/api/purchases/${p.id}/refund`, { reason: `${r.recipient.name} already has one` });
    st = await state();
    const after = byName(st, r.recipient.name.toLowerCase()) as RecipientStatus;
    check(purchase.status === "refunded" && purchase.paypal.refund_id, `refunded ${r.recipient.name}'s gift (refund id ${purchase.paypal.refund_id})`);
    check(Math.abs(after.remaining - (r.remaining + p.total)) < 0.01, `${r.recipient.name}'s envelope $${r.remaining} -> $${after.remaining}`);
    check(after.state === "to_buy" || after.purchase_ids.some((id) => purchaseOf(st, id)?.status === "charged"), `${r.recipient.name} back to ${after.state}`);
    check(Math.abs(st.remaining - (remBefore + p.total)) < 0.01, `total remaining $${remBefore} -> $${st.remaining}`);
  } else check(false, "refund skipped: nothing charged outside Mom");
  check(noneOver(st), "still no envelope exceeded");

  console.log("\n7. Revoke");
  const rev = await json<{ mandate: Mandate }>("POST", `/api/mandates/${mandate.id}/revoke`);
  st = await state();
  check(rev.mandate.status === "revoked" && st.mandate?.status === "revoked", "gift list revoked");
  const voidRow = [...st.ledger].reverse().find((r) => r.action === "paypal.void" || r.action === "paypal.error");
  if (voidRow) console.log(`  ${voidRow.action}: ${voidRow.summary}`);

  console.log("\nLedger:");
  const names = new Map(st.recipients.map((r) => [r.recipient.id, r.recipient.name]));
  for (const r of st.ledger) {
    const who = r.recipient_id ? (names.get(r.recipient_id) ?? r.recipient_id) : "";
    console.log(
      `  ${r.actor.padEnd(6)} ${r.action.padEnd(24)} ${r.amount === null ? "".padEnd(8) : `$${r.amount}`.padEnd(8)} rem=${String(r.remaining_budget ?? "-").padEnd(6)} ${who.slice(0, 12).padEnd(12)} ${r.summary.slice(0, 130)}`,
    );
  }

  console.log(failures.length ? `\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}` : "\nSMOKE PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e);
  process.exit(1);
});
