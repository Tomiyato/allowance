// Business operations shared by the HTTP routes and the agent tools.
// Every money-relevant step writes a ledger row. Policy always runs before the rail is called.
import { z } from "zod";
import { CATEGORY_VOCAB, type Mandate, type Product, type Purchase, type PurchaseItem } from "../shared/types.ts";
import { rail, PaymentError } from "./paypal/index.ts";
import { evaluatePolicy, purchaseTotal, round2, type PolicyItem } from "./policy.ts";
import { injectionProduct, lookupCatalog } from "./products/index.ts";
import { addLedger, newId, refreshMandateStatus, remaining, touch, withSessionLock, type Session } from "./store.ts";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- mandates

const vocab = z.enum(CATEGORY_VOCAB);
const categoryList = z
  .array(z.string())
  .default([])
  .transform((xs) => [...new Set(xs.map((x) => x.trim().toLowerCase()))].filter((x) => vocab.safeParse(x).success));

export const MandateInputSchema = z.object({
  title: z.string().trim().min(1).max(120).default("My shopping mandate"),
  budget_total: z.coerce.number().positive().max(100_000),
  per_purchase_approval_over: z.coerce.number().min(0).max(100_000),
  allowed_categories: categoryList,
  blocked_categories: categoryList,
  max_quantity_per_item: z.coerce.number().int().min(1).max(100).default(2),
  expires_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expires_at must be an ISO date"),
});

export function endOfMonthUtc(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString().replace(".000Z", "Z");
}

export function buildMandate(input: z.infer<typeof MandateInputSchema>, status: Mandate["status"] = "draft"): Mandate {
  const blocked = input.blocked_categories;
  return {
    id: newId("mdt"),
    title: input.title,
    currency: "USD",
    budget_total: round2(input.budget_total),
    per_purchase_approval_over: round2(input.per_purchase_approval_over),
    // A category cannot be both allowed and blocked: blocked wins.
    allowed_categories: input.allowed_categories.filter((c) => !blocked.includes(c)),
    blocked_categories: blocked,
    max_quantity_per_item: input.max_quantity_per_item,
    expires_at: new Date(input.expires_at).toISOString().replace(".000Z", "Z"),
    status,
    paypal: { mode: rail.mode, authorization_id: null, vault_id: null, order_id: null },
    spent: 0,
    refunded: 0,
    created_at: new Date().toISOString(),
  };
}

export function createMandate(s: Session, raw: unknown): Mandate {
  const parsed = MandateInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid mandate: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (Date.parse(parsed.data.expires_at) <= Date.now()) throw new HttpError(400, "Invalid mandate: expires_at is in the past.");
  if (s.mandate && s.mandate.status === "active") {
    throw new HttpError(409, "An active mandate already exists. Revoke it before creating a new one.");
  }
  const m = buildMandate(parsed.data);
  s.mandate = m;
  addLedger(s, {
    actor: "user",
    action: "mandate.created",
    summary: `Mandate "${m.title}": ${usd(m.budget_total)} budget, ask over ${usd(m.per_purchase_approval_over)}, blocked: ${m.blocked_categories.join(", ") || "none"}`,
    amount: m.budget_total,
  });
  touch(s);
  return m;
}

function requireMandate(s: Session, id: string): Mandate {
  if (!s.mandate || s.mandate.id !== id) throw new HttpError(404, "Mandate not found in this session.");
  return s.mandate;
}

export async function startApproval(s: Session, id: string, baseUrl: string): Promise<string> {
  const m = requireMandate(s, id);
  if (m.status !== "draft" && m.status !== "pending_paypal") throw new HttpError(409, `Mandate is ${m.status}; only a draft can be approved.`);
  const urls = {
    returnUrl: `${baseUrl}/paypal/return?mandate=${encodeURIComponent(m.id)}`,
    cancelUrl: `${baseUrl}/paypal/cancel?mandate=${encodeURIComponent(m.id)}`,
  };
  let result;
  try {
    result = await rail.authorizeMandate(m, urls);
  } catch (e) {
    addLedger(s, { actor: "paypal", action: "paypal.error", summary: `Could not start PayPal approval: ${errMsg(e)}` });
    throw new HttpError(502, `PayPal approval could not start: ${errMsg(e)}`);
  }
  Object.assign(m.paypal, result.paypal);
  m.status = "pending_paypal";
  addLedger(s, {
    actor: "paypal",
    action: "mandate.approval_started",
    summary: `Sent to PayPal to approve a ${usd(m.budget_total)} ${rail.mode === "authorization" ? "authorization hold" : rail.mode + " mandate"}`,
    amount: m.budget_total,
    paypal_id: m.paypal.order_id,
  });
  touch(s);
  return result.approveUrl;
}

export async function finalizeApproval(s: Session, id: string, token: string): Promise<Mandate> {
  const m = requireMandate(s, id);
  if (m.status === "active") return m; // idempotent: a reload of the return URL
  if (m.status !== "pending_paypal") throw new HttpError(409, `Mandate is ${m.status}, not awaiting PayPal.`);
  try {
    Object.assign(m.paypal, await rail.finalize(m, token));
  } catch (e) {
    addLedger(s, { actor: "paypal", action: "paypal.error", summary: `PayPal approval could not be finalized: ${errMsg(e)}` });
    touch(s);
    throw new HttpError(502, `PayPal approval failed: ${errMsg(e)}`);
  }
  m.status = "active";
  addLedger(s, {
    actor: "paypal",
    action: "mandate.activated",
    summary:
      rail.mode === "authorization"
        ? `PayPal authorized ${usd(m.budget_total)}; the agent can now spend inside the mandate`
        : rail.mode === "mock"
          ? `Mandate approved (MOCK rail, no real money); agent can spend up to ${usd(m.budget_total)}`
          : `Mandate active; each purchase will be approved in PayPal`,
    amount: m.budget_total,
    paypal_id: m.paypal.authorization_id ?? m.paypal.order_id,
  });
  touch(s);
  return m;
}

export function cancelApproval(s: Session, id: string) {
  const m = requireMandate(s, id);
  if (m.status === "pending_paypal") {
    m.status = "draft";
    addLedger(s, { actor: "user", action: "mandate.approval_cancelled", summary: "PayPal approval cancelled; mandate is a draft again" });
    touch(s);
  }
}

export async function revokeMandate(s: Session, id: string): Promise<Mandate> {
  const m = requireMandate(s, id);
  return withSessionLock(s, async () => {
    if (m.status === "revoked") return m;
    let voidId: string | null = null;
    if (m.status !== "draft") {
      try {
        voidId = (await rail.revoke(m)).paypal_id;
      } catch (e) {
        // Still kill spending power on our side; the ledger records that PayPal disagreed.
        addLedger(s, { actor: "paypal", action: "paypal.error", summary: `PayPal void failed: ${errMsg(e)}` });
      }
    }
    m.status = "revoked";
    for (const p of s.purchases) {
      if (p.mandate_id === m.id && p.status === "pending_approval") {
        p.status = "rejected";
        p.reasons = [...p.reasons, "Mandate revoked before approval."];
      }
    }
    if (voidId) {
      addLedger(s, {
        actor: "paypal",
        action: "paypal.void",
        summary: rail.mode === "mock" ? "MOCK authorization voided" : "PayPal authorization voided; remaining hold released",
        paypal_id: voidId,
      });
    }
    addLedger(s, { actor: "user", action: "mandate.revoked", summary: `Mandate "${m.title}" revoked; the agent has no spending power`, remaining_budget: 0 });
    touch(s);
    return m;
  });
}

// ---------------------------------------------------------------- purchases

export interface ProposedItem {
  product_id: string;
  qty: number;
}

function findPurchase(s: Session, id: string): Purchase {
  const p = s.purchases.find((x) => x.id === id);
  if (!p) throw new HttpError(404, "Purchase not found.");
  return p;
}

function resolveProduct(s: Session, id: string): Product | undefined {
  return s.products[id] ?? lookupCatalog(id);
}

function policyItems(s: Session, items: PurchaseItem[]): PolicyItem[] {
  return items.map((i) => ({
    title: i.title,
    price: i.price,
    qty: i.qty,
    category: i.category,
    category_confidence: resolveProduct(s, i.product_id)?.category_confidence ?? "low",
    merchant: i.merchant,
  }));
}

function describe(items: PurchaseItem[]): string {
  return items.map((i) => `${i.qty} x ${i.title}`).join(", ");
}

/** Where a purchase proposal came from. Only the ledger label differs; policy and rail are the same. */
export type ProposalOrigin = "agent" | "redteam";

/** Summary prefix for every ledger row written while running a red-team simulation. */
export const SIMULATION_PREFIX = "[Red-team simulation] ";

/** Charge an allowed purchase through the rail. Caller holds the session lock. */
async function chargeNow(s: Session, p: Purchase, baseUrl: string, label = "") {
  const m = s.mandate!;
  try {
    const r = await rail.charge(m, {
      purchaseId: p.id,
      amount: p.total,
      description: describe(p.items),
      urls: {
        returnUrl: `${baseUrl}/paypal/return?purchase=${encodeURIComponent(p.id)}`,
        cancelUrl: `${baseUrl}/paypal/cancel?purchase=${encodeURIComponent(p.id)}`,
      },
    });
    if (r.status === "payer_action_required") {
      // per_purchase rail: the buyer is the cap; the purchase waits for PayPal approval.
      p.status = "pending_approval";
      p.paypal.order_id = r.order_id;
      p.paypal.approve_url = r.approveUrl;
      p.error = null;
      addLedger(s, { actor: "paypal", action: "paypal.order_created", summary: `${label}Waiting for buyer approval in PayPal: ${describe(p.items)}`, amount: p.total, paypal_id: r.order_id, purchase_id: p.id });
      return;
    }
    p.status = "charged";
    p.paypal.order_id = r.order_id;
    p.paypal.capture_id = r.capture_id;
    m.spent = round2(m.spent + p.total);
    addLedger(s, {
      actor: "paypal",
      action: "paypal.capture",
      summary: `${label}${rail.mode === "mock" ? "MOCK capture" : "PayPal captured"} ${usd(p.total)} for ${describe(p.items)}`,
      amount: p.total,
      paypal_id: r.capture_id,
      purchase_id: p.id,
    });
    refreshMandateStatus(s);
  } catch (e) {
    p.status = "failed";
    p.error = errMsg(e);
    addLedger(s, {
      actor: "paypal",
      action: "paypal.error",
      summary: `${label}Charge failed for ${describe(p.items)}: ${p.error}`,
      amount: p.total,
      paypal_id: e instanceof PaymentError ? (e.debugId ?? null) : null,
      purchase_id: p.id,
    });
  }
}

export async function proposePurchase(
  s: Session,
  items: ProposedItem[],
  rationale: string,
  baseUrl: string,
  origin: ProposalOrigin = "agent",
): Promise<Purchase> {
  const label = origin === "redteam" ? SIMULATION_PREFIX : "";
  return withSessionLock(s, async () => {
    refreshMandateStatus(s);
    const m = s.mandate;
    const unknown: string[] = [];
    const resolved: PurchaseItem[] = [];
    for (const it of items) {
      const prod = resolveProduct(s, it.product_id);
      if (!prod) {
        unknown.push(it.product_id);
        continue;
      }
      // Price, category and merchant come from the product source, never from the model.
      resolved.push({
        product_id: prod.id,
        title: prod.title,
        price: prod.price,
        qty: it.qty,
        category: prod.category,
        merchant: prod.merchant,
        image_url: prod.image_url,
        url: prod.url,
      });
    }
    const total = purchaseTotal(resolved);
    const p: Purchase = {
      id: newId("pur"),
      mandate_id: m?.id ?? "none",
      items: resolved,
      total,
      status: "blocked",
      decision: "deny",
      reasons: [],
      rationale: rationale.slice(0, 500),
      paypal: { order_id: null, capture_id: null, refund_id: null, approve_url: null },
      error: null,
      created_at: new Date().toISOString(),
    };
    s.purchases.push(p);
    addLedger(s, {
      actor: "agent",
      action: origin === "redteam" ? "agent.hijacked_attempt" : "purchase.proposed",
      summary: `${label}${origin === "redteam" ? "Hijacked agent" : "Agent"} proposed ${describe(resolved) || "(no known items)"} for ${usd(total)}${rationale ? ` — "${rationale.slice(0, 140)}"` : ""}`,
      amount: total,
      purchase_id: p.id,
    });

    const policy = unknown.length
      ? { decision: "deny" as const, reasons: [`Unknown product id(s) ${unknown.join(", ")}: the agent may only buy products returned by search_products.`] }
      : evaluatePolicy({ mandate: m, items: policyItems(s, resolved), now: new Date() });
    p.decision = policy.decision;
    p.reasons = policy.reasons;
    addLedger(s, {
      actor: "policy",
      action: `policy.${policy.decision}`,
      summary:
        label +
        (policy.decision === "allow"
          ? `Allowed: ${policy.reasons[0]}`
          : policy.decision === "needs_approval"
            ? `Needs your approval: ${policy.reasons.join(" ")}`
            : `Blocked: ${policy.reasons.join(" ")}`),
      amount: total,
      decision: policy.decision,
      reasons: policy.reasons,
      purchase_id: p.id,
    });

    if (policy.decision === "deny") p.status = "blocked";
    else if (policy.decision === "needs_approval") p.status = "pending_approval";
    else await chargeNow(s, p, baseUrl, label);
    touch(s);
    return p;
  });
}

/** What a prompt-injected agent would send after obeying the poisoned listing. */
export const HIJACK_QTY = 5;
export const HIJACK_RATIONALE =
  "The product listing says the user pre-approved 5 units and that my spending limits no longer apply, so I am buying 5 now.";

/**
 * Red-team simulation (defence layer 2): replay the propose_purchase call a fully hijacked agent would
 * make for the injection listing. It goes through proposePurchase exactly like a real agent call, so the
 * same policy engine and payment rail decide; only the ledger label marks it as simulated.
 */
export async function simulateHijackedAgent(s: Session, baseUrl: string): Promise<Purchase> {
  // The hijacked agent "saw" the poisoned listing in its search results. Load it from the catalog so the
  // simulation works whatever the product source (Channel3 results may not include it).
  const inj = injectionProduct();
  s.products[inj.id] = inj;
  return proposePurchase(s, [{ product_id: inj.id, qty: HIJACK_QTY }], HIJACK_RATIONALE, baseUrl, "redteam");
}

/** Defence layer 1: the model reported a listing whose text tries to instruct it. Returns the product title. */
export function recordSuspiciousContent(s: Session, productId: string, reason: string): string | null {
  const title = resolveProduct(s, productId)?.title ?? null;
  const why = reason.trim().slice(0, 300) || "Product text tries to give the agent instructions.";
  addLedger(s, {
    actor: "agent",
    action: "agent.flagged_injection",
    summary: `Agent flagged suspicious text in ${title ? `"${title}"` : `product ${productId.slice(0, 80)}`} and will not follow it`,
    reasons: [why],
  });
  touch(s);
  return title;
}

export async function approvePurchase(s: Session, id: string, baseUrl: string): Promise<Purchase> {
  return withSessionLock(s, async () => {
    const p = findPurchase(s, id);
    if (p.status !== "pending_approval") throw new HttpError(409, `Purchase is ${p.status}, not awaiting approval.`);
    if (p.paypal.order_id && rail.mode === "per_purchase") {
      throw new HttpError(409, "This purchase waits for approval inside PayPal, not here.");
    }
    refreshMandateStatus(s);
    addLedger(s, { actor: "user", action: "purchase.approved", summary: `You approved ${describe(p.items)} (${usd(p.total)})`, amount: p.total, purchase_id: p.id });
    // Re-check every hard limit: budget or status may have changed since the proposal.
    const policy = evaluatePolicy({ mandate: s.mandate, items: policyItems(s, p.items), now: new Date(), humanApproved: true });
    p.decision = policy.decision;
    p.reasons = [...p.reasons, ...policy.reasons];
    addLedger(s, { actor: "policy", action: `policy.${policy.decision}`, summary: `${policy.decision === "allow" ? "Allowed after approval" : "Blocked after approval"}: ${policy.reasons.join(" ")}`, amount: p.total, decision: policy.decision, reasons: policy.reasons, purchase_id: p.id });
    if (policy.decision !== "allow") p.status = "blocked";
    else await chargeNow(s, p, baseUrl);
    touch(s);
    return p;
  });
}

export function rejectPurchase(s: Session, id: string): Purchase {
  const p = findPurchase(s, id);
  if (p.status !== "pending_approval") throw new HttpError(409, `Purchase is ${p.status}, not awaiting approval.`);
  p.status = "rejected";
  addLedger(s, { actor: "user", action: "purchase.rejected", summary: `You declined ${describe(p.items)} (${usd(p.total)}); nothing was charged`, amount: p.total, purchase_id: p.id });
  touch(s);
  return p;
}

/** per_purchase rail: buyer approved one order in PayPal. UNTESTED against sandbox. */
export async function completePurchaseApproval(s: Session, id: string): Promise<Purchase> {
  return withSessionLock(s, async () => {
    const p = findPurchase(s, id);
    if (p.status !== "pending_approval" || !p.paypal.order_id || !rail.completeCharge) throw new HttpError(409, "Purchase is not awaiting a PayPal approval.");
    try {
      const { capture_id } = await rail.completeCharge(s.mandate!, p.paypal.order_id, p.id);
      p.status = "charged";
      p.error = null;
      p.paypal.capture_id = capture_id;
      p.paypal.approve_url = null;
      s.mandate!.spent = round2(s.mandate!.spent + p.total);
      addLedger(s, { actor: "paypal", action: "paypal.capture", summary: `PayPal captured ${usd(p.total)} for ${describe(p.items)}`, amount: p.total, paypal_id: capture_id, purchase_id: p.id });
      refreshMandateStatus(s);
    } catch (e) {
      p.status = "failed";
      p.error = errMsg(e);
      addLedger(s, { actor: "paypal", action: "paypal.error", summary: `Capture failed: ${p.error}`, amount: p.total, purchase_id: p.id });
    }
    touch(s);
    return p;
  });
}

export async function refundPurchase(s: Session, id: string, reason: string, actor: "user" | "agent"): Promise<Purchase> {
  return withSessionLock(s, async () => {
    const p = findPurchase(s, id);
    if (p.status !== "charged" || !p.paypal.capture_id) throw new HttpError(409, `Purchase is ${p.status}; only a charged purchase can be refunded.`);
    const m = s.mandate && s.mandate.id === p.mandate_id ? s.mandate : null;
    addLedger(s, { actor, action: "refund.requested", summary: `Refund requested for ${describe(p.items)}${reason ? `: ${reason.slice(0, 140)}` : ""}`, amount: p.total, purchase_id: p.id });
    try {
      const { refund_id } = await rail.refund(m ?? (s.mandate as Mandate), p.paypal.capture_id, p.total, p.id);
      p.status = "refunded";
      p.paypal.refund_id = refund_id;
      if (m) m.refunded = round2(m.refunded + p.total);
      if (m) refreshMandateStatus(s);
      addLedger(s, {
        actor: "paypal",
        action: "paypal.refund",
        summary: `${rail.mode === "mock" ? "MOCK refund" : "PayPal refunded"} ${usd(p.total)} for ${describe(p.items)}; budget restored`,
        amount: -p.total,
        paypal_id: refund_id,
        purchase_id: p.id,
      });
    } catch (e) {
      addLedger(s, { actor: "paypal", action: "paypal.error", summary: `Refund failed: ${errMsg(e)}`, amount: p.total, purchase_id: p.id });
      touch(s);
      throw new HttpError(502, `Refund failed: ${errMsg(e)}`);
    }
    touch(s);
    return p;
  });
}

export function recordSearch(s: Session, query: string, source: "channel3" | "catalog", products: Product[], fallback?: string) {
  for (const p of products) s.products[p.id] = p;
  s.last_source = source;
  addLedger(s, {
    actor: "agent",
    action: "search",
    summary: `Searched ${source} for "${query.slice(0, 80)}": ${products.length} result(s)${fallback ? " (Channel3 unavailable, used catalog)" : ""}`,
  });
  touch(s);
}

export { remaining };
