// End-to-end smoke test against a running server (npm run dev, then npm run smoke).
// Uses the real AI model. Env: BASE_URL (or SMOKE_URL), else http://localhost:$PORT (default 3000).
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { AppState, Mandate, Purchase } from "../shared/types.ts";

const BASE = (process.env.BASE_URL ?? process.env.SMOKE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
let cookie = "";
const failures: string[] = [];
// Gemini free tier allows 5 requests/minute: pause between LLM-heavy phases.
const PAUSE_MS = Number(process.env.SMOKE_PAUSE_MS ?? 45_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    // Retry only if nothing happened yet (no tool ran): retrying after a tool ran could buy twice.
    const toolRan = chunks.some((c) => c.type === "tool-output-available");
    if (error && !toolRan && attempt < 3) {
      console.log(`  (${error.slice(0, 80)}; waiting 65s before retry ${attempt + 1}/3)`);
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

function describeAssistant(m: UIMessage) {
  for (const p of m.parts as any[]) {
    if (p.type === "text" && p.text.trim()) console.log(`  agent: ${p.text.trim().replace(/\s+/g, " ").slice(0, 400)}`);
    else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      const out = p.output;
      let detail = "";
      if (p.type === "tool-search_products") detail = `${out?.products?.length ?? 0} products from ${out?.source}`;
      else if (out?.purchase) detail = `purchase ${out.purchase.status} $${out.purchase.total} (${out.purchase.items.map((i: any) => `${i.qty}x ${i.title}`).join(", ")})`;
      console.log(`  tool: ${p.type.slice(5)} [${p.state}] ${detail}`);
    }
  }
}

const state = () => json<AppState>("GET", "/api/state");

async function main() {
  console.log(`Smoke test against ${BASE}`);
  const health = await fetch(`${BASE}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`Server not reachable at ${BASE}. Start it with npm run dev.`);

  console.log("\n1. Parse mandate from text");
  const parsed = await json<{ mandate: Mandate; source: string; warning?: string }>("POST", "/api/mandates/parse", {
    text: "Up to $150 this month for my mom's birthday gift and home basics. Ask me before anything over $60. No electronics.",
  });
  const d = parsed.mandate;
  console.log(`  draft (${parsed.source}): "${d.title}" budget=$${d.budget_total} ask>$${d.per_purchase_approval_over} allowed=[${d.allowed_categories}] blocked=[${d.blocked_categories}] qty<=${d.max_quantity_per_item} expires=${d.expires_at}`);
  check(d.budget_total === 150, "budget_total = 150");
  check(d.per_purchase_approval_over === 60, "per_purchase_approval_over = 60");
  check(d.blocked_categories.includes("electronics"), "electronics blocked");
  check(d.allowed_categories.includes("gifts") && d.allowed_categories.includes("home"), "gifts and home allowed");
  check(d.status === "draft", "status draft");

  console.log("\n2. Create + approve mandate");
  const { mandate } = await json<{ mandate: Mandate }>("POST", "/api/mandates", { mandate: d });
  const { approveUrl } = await json<{ approveUrl: string }>("POST", `/api/mandates/${mandate.id}/approve`);
  console.log(`  approveUrl: ${approveUrl}`);
  const ret = await http("GET", approveUrl.startsWith("http") ? approveUrl.replace(/^https?:\/\/[^/]+/, "") : approveUrl, undefined, "manual");
  check(ret.status === 302 && ret.headers.get("location") === "/agent", "PayPal return redirects to /agent");
  let st = await state();
  check(st.mandate?.status === "active", `mandate active (mode ${st.mode.payment}, products ${st.mode.products}, ai ${st.mode.ai})`);

  console.log("\n3. Chat: gardening gift");
  let convo = await chat([], "Find a gardening gift for my mom around $40 and buy the best one");
  describeAssistant(convo.assistant);
  if (convo.error) console.log(`  stream error: ${convo.error}`);
  st = await state();
  const charged = st.purchases.find((p) => p.status === "charged");
  check(charged, "a purchase was charged");
  if (charged) console.log(`  charged: ${charged.items.map((i) => i.title).join(", ")} $${charged.total} capture=${charged.paypal.capture_id} remaining=$${st.remaining}`);
  const blockedEarly = st.purchases.filter((p) => p.status === "blocked");
  if (blockedEarly.length) console.log(`  blocked attempts so far: ${blockedEarly.map((p) => p.reasons.join(" ")).join(" | ")}`);

  console.log("\n4. Chat: robot vacuum");
  const before = new Set(st.purchases.map((p) => p.id));
  convo = await chat(convo.messages, "Buy a robot vacuum");
  describeAssistant(convo.assistant);
  if (convo.error) console.log(`  stream error: ${convo.error}`);
  st = await state();
  const vac = st.purchases.filter((p) => !before.has(p.id));
  check(vac.some((p) => p.status === "blocked" || p.status === "pending_approval"), `robot vacuum blocked or pending_approval (${vac.map((p) => p.status).join(", ") || "no proposal"})`);
  check(!vac.some((p) => p.status === "charged"), "robot vacuum was NOT charged");
  for (const p of vac) console.log(`  ${p.status}: ${p.reasons.join(" ")}`);

  console.log("\n5. Refund first purchase");
  if (charged) {
    const remBefore = st.remaining;
    const { purchase } = await json<{ purchase: Purchase }>("POST", `/api/purchases/${charged.id}/refund`, { reason: "Mom already has that" });
    st = await state();
    check(purchase.status === "refunded" && purchase.paypal.refund_id, `refunded (refund id ${purchase.paypal.refund_id})`);
    check(Math.abs(st.remaining - (remBefore + charged.total)) < 0.01, `remaining restored $${remBefore} -> $${st.remaining}`);
  } else check(false, "refund skipped: nothing charged");

  console.log("\n6. Revoke");
  const rev = await json<{ mandate: Mandate }>("POST", `/api/mandates/${mandate.id}/revoke`);
  st = await state();
  check(rev.mandate.status === "revoked" && st.mandate?.status === "revoked", "mandate revoked");

  console.log("\nLedger:");
  for (const r of st.ledger) {
    console.log(`  ${r.actor.padEnd(6)} ${r.action.padEnd(26)} ${r.amount === null ? "" : `$${r.amount}`.padEnd(8)} rem=${r.remaining_budget ?? "-"}  ${r.summary.slice(0, 110)}`);
  }

  console.log(failures.length ? `\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}` : "\nSMOKE PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e);
  process.exit(1);
});
