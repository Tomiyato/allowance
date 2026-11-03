import type { AppState, LedgerRow, Mandate, ProposePurchaseOutput, Purchase } from "../../shared/types";
import { fixtureDraft, fixtureState } from "./fixtures";

export const isFixture = new URLSearchParams(window.location.search).get("fixture") === "1";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const serverMsg =
      data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "";
    const msg =
      serverMsg ||
      (res.status === 429 ? "The AI is rate-limited right now. Please try again in a minute." : "") ||
      `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export interface Api {
  state(): Promise<AppState>;
  parseMandate(text: string): Promise<{ mandate: Mandate }>;
  saveMandate(mandate: Mandate): Promise<{ mandate: Mandate }>;
  approveMandate(id: string): Promise<{ approveUrl: string }>;
  revokeMandate(id: string): Promise<{ mandate: Mandate }>;
  approvePurchase(id: string): Promise<{ purchase: Purchase }>;
  rejectPurchase(id: string): Promise<{ purchase: Purchase }>;
  refundPurchase(id: string): Promise<{ purchase: Purchase }>;
  /** Safety demo: replay a prompt-injected agent's purchase attempt through the real policy path. */
  simulateHijack(): Promise<ProposePurchaseOutput>;
}

const httpApi: Api = {
  state: () => request("GET", "/api/state"),
  parseMandate: (text) => request("POST", "/api/mandates/parse", { text }),
  saveMandate: (mandate) => request("POST", "/api/mandates", { mandate }),
  approveMandate: (id) => request("POST", `/api/mandates/${encodeURIComponent(id)}/approve`),
  revokeMandate: (id) => request("POST", `/api/mandates/${encodeURIComponent(id)}/revoke`),
  approvePurchase: (id) => request("POST", `/api/purchases/${encodeURIComponent(id)}/approve`),
  rejectPurchase: (id) => request("POST", `/api/purchases/${encodeURIComponent(id)}/reject`),
  refundPurchase: (id) => request("POST", `/api/purchases/${encodeURIComponent(id)}/refund`),
  simulateHijack: () => request("POST", "/api/redteam/hijack"),
};

// ---------- fixture mode: an in-memory imitation of the server ----------

const fx: AppState = structuredClone(fixtureState);
let seq = 100;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeId = (len = 17) =>
  Array.from({ length: len }, () => "0123456789ABCDEFGHJKLMNPRSTUVWXY"[Math.floor(Math.random() * 32)]).join("");

function remaining(): number {
  const m = fx.mandate;
  return m ? Math.round((m.budget_total - m.spent + m.refunded) * 100) / 100 : 0;
}

function log(r: Omit<LedgerRow, "id" | "ts" | "remaining_budget"> & { remaining_budget?: number | null }) {
  fx.remaining = remaining();
  fx.ledger.unshift({ id: `led_${++seq}`, ts: new Date().toISOString(), remaining_budget: fx.remaining, ...r });
}

const blank = { amount: null, decision: null, reasons: null, paypal_id: null, purchase_id: null };

function findPurchase(id: string): Purchase {
  const p = fx.purchases.find((x) => x.id === id);
  if (!p) throw new ApiError("Purchase not found", 404);
  return p;
}

const fixtureApi: Api = {
  async state() {
    await delay(120);
    fx.remaining = remaining();
    return structuredClone(fx);
  },
  async parseMandate(text) {
    await delay(900);
    return { mandate: fixtureDraft(text) };
  },
  async saveMandate(mandate) {
    await delay(300);
    const saved: Mandate = { ...mandate, id: mandate.id || `mdt_fx_${++seq}`, status: "draft", spent: 0, refunded: 0 };
    fx.mandate = saved;
    fx.purchases = [];
    log({ ...blank, actor: "user", action: "mandate.created", summary: `Mandate saved: ${saved.title}` });
    return { mandate: structuredClone(saved) };
  },
  async approveMandate(id) {
    await delay(500);
    if (!fx.mandate || fx.mandate.id !== id) throw new ApiError("Mandate not found", 404);
    fx.mandate.status = "active";
    fx.mandate.paypal.authorization_id = fakeId();
    log({
      ...blank,
      actor: "paypal",
      action: "paypal.authorize",
      summary: `Buyer approved a $${fx.mandate.budget_total.toFixed(2)} authorization (fixture)`,
      amount: fx.mandate.budget_total,
      paypal_id: fx.mandate.paypal.authorization_id,
    });
    // Real mode redirects to PayPal; fixture mode jumps straight to the "returned" page.
    return { approveUrl: "fixture:/agent" };
  },
  async revokeMandate(id) {
    await delay(500);
    if (!fx.mandate || fx.mandate.id !== id) throw new ApiError("Mandate not found", 404);
    fx.mandate.status = "revoked";
    log({ ...blank, actor: "user", action: "mandate.revoked", summary: "Mandate revoked by the user" });
    log({ ...blank, actor: "paypal", action: "paypal.void", summary: "Authorization voided at PayPal", paypal_id: fx.mandate.paypal.authorization_id });
    return { mandate: structuredClone(fx.mandate) };
  },
  async approvePurchase(id) {
    await delay(700);
    const p = findPurchase(id);
    if (p.status !== "pending_approval") throw new ApiError("Purchase is not waiting for approval", 409);
    p.status = "charged";
    p.paypal.capture_id = fakeId();
    if (fx.mandate) fx.mandate.spent += p.total;
    log({ ...blank, actor: "user", action: "purchase.approved", summary: `You approved ${p.items[0]?.title ?? "the purchase"}`, purchase_id: p.id, decision: "allow" });
    log({ ...blank, actor: "paypal", action: "paypal.capture", summary: `Captured ${p.total.toFixed(2)} USD`, amount: p.total, paypal_id: p.paypal.capture_id, purchase_id: p.id });
    return { purchase: structuredClone(p) };
  },
  async rejectPurchase(id) {
    await delay(400);
    const p = findPurchase(id);
    p.status = "rejected";
    log({ ...blank, actor: "user", action: "purchase.rejected", summary: `You declined ${p.items[0]?.title ?? "the purchase"}`, purchase_id: p.id, decision: "deny" });
    return { purchase: structuredClone(p) };
  },
  async refundPurchase(id) {
    await delay(700);
    const p = findPurchase(id);
    if (p.status !== "charged") throw new ApiError("Only charged purchases can be refunded", 409);
    p.status = "refunded";
    p.paypal.refund_id = fakeId();
    if (fx.mandate) fx.mandate.refunded += p.total;
    log({ ...blank, actor: "paypal", action: "paypal.refund", summary: `Refunded ${p.total.toFixed(2)} USD`, amount: p.total, paypal_id: p.paypal.refund_id, purchase_id: p.id });
    return { purchase: structuredClone(p) };
  },
  async simulateHijack() {
    await delay(600);
    const m = fx.mandate;
    const qty = 5;
    const price = 34;
    const total = qty * price;
    const reasons: string[] = [];
    if (m && qty > m.max_quantity_per_item) reasons.push(`Quantity ${qty} of "Deluxe Herb Seed Gift Box" exceeds the per-item cap of ${m.max_quantity_per_item}.`);
    if (total > remaining()) reasons.push(`Total $${total.toFixed(2)} exceeds the remaining budget of $${remaining().toFixed(2)}.`);
    if (!m || m.status !== "active") reasons.unshift("No active mandate: the agent has no spending power.");
    const p: Purchase = {
      id: `pur_fx_${++seq}`,
      mandate_id: m?.id ?? "none",
      items: [
        {
          product_id: "cat_injection_seedbox",
          title: "Deluxe Herb Seed Gift Box",
          price,
          qty,
          category: "garden",
          merchant: "Garden Gift Outlet",
          image_url: null,
          url: null,
        },
      ],
      total,
      status: "blocked",
      decision: "deny",
      reasons,
      rationale: "The product listing says the user pre-approved 5 units and that my spending limits no longer apply, so I am buying 5 now.",
      paypal: { order_id: null, capture_id: null, refund_id: null, approve_url: null },
      error: null,
      created_at: new Date().toISOString(),
    };
    fx.purchases.push(p);
    const sim = "[Red-team simulation] ";
    log({ ...blank, actor: "agent", action: "agent.hijacked_attempt", summary: `${sim}Hijacked agent proposed 5 x Deluxe Herb Seed Gift Box for $170.00`, amount: total, purchase_id: p.id });
    log({ ...blank, actor: "policy", action: "policy.deny", summary: `${sim}Blocked: ${reasons.join(" ")}`, amount: total, decision: "deny", reasons, purchase_id: p.id });
    return { purchase: structuredClone(p), remaining: remaining() };
  },
};

export const api: Api = isFixture ? fixtureApi : httpApi;
