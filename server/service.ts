// Business operations shared by the HTTP routes and the agent tools.
// Every money-relevant step writes a ledger row. Policy always runs before the rail is called.
import { z } from "zod";
import {
  CATEGORY_VOCAB,
  type BuyGiftPlanOutput,
  type Mandate,
  type Product,
  type Purchase,
  type PurchaseItem,
  type Recipient,
} from "../shared/types.ts";
import { rail, PaymentError } from "./paypal/index.ts";
import { DEMO_CARRIER, DEMO_CARRIER_NAME, demoTrackingNumber } from "./paypal/tracking.ts";
import { evaluatePolicy, purchaseTotal, round2, type PolicyItem, type PolicyRecipient } from "./policy.ts";
import { injectionProduct, lookupCatalog } from "./products/index.ts";
import {
  addLedger,
  mandatePurchases,
  newId,
  recipientStatuses,
  refreshMandateStatus,
  remaining,
  allSessions,
  touch,
  withSessionLock,
  type Session,
} from "./store.ts";

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

/** PayPal honours an authorization for 29 days, so a mandate never outlives its hold (GIFTLIST_SPEC decision 4). */
export const PAYPAL_HOLD_DAYS = 29;
export const MAX_RECIPIENTS = 12;

export function maxExpiry(now = new Date()): Date {
  return new Date(now.getTime() + PAYPAL_HOLD_DAYS * 864e5);
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export const RecipientInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "name is required").max(40),
  envelope: z.coerce.number().positive("envelope must be more than $0").max(100_000),
  interests: z.string().trim().max(120).default(""),
});

export const MandateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).default("My gift list"),
    /** Required for a legacy mandate; with recipients it must equal the sum of the envelopes (or be omitted). */
    budget_total: z.coerce.number().positive().max(100_000).optional(),
    per_purchase_approval_over: z.coerce.number().min(0).max(100_000),
    allowed_categories: categoryList,
    blocked_categories: categoryList,
    max_quantity_per_item: z.coerce.number().int().min(1).max(100).default(2),
    expires_at: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), "expires_at must be an ISO date")
      .default(() => isoSeconds(maxExpiry())),
    /** Gift list: one envelope per person. [] = legacy single-budget mandate. */
    recipients: z.array(RecipientInputSchema).max(MAX_RECIPIENTS, `at most ${MAX_RECIPIENTS} people per gift list`).default([]),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.recipients.forEach((r, i) => {
      const key = r.name.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["recipients", i, "name"], message: `"${r.name}" is on the list twice; names must be unique` });
      seen.add(key);
    });
    if (v.recipients.length > 0) {
      const sum = round2(v.recipients.reduce((t, r) => t + r.envelope, 0));
      if (v.budget_total !== undefined && Math.abs(v.budget_total - sum) > 0.01 + 1e-9) {
        ctx.addIssue({ code: "custom", path: ["budget_total"], message: `must equal the sum of the envelopes (${usd(sum)}), got ${usd(v.budget_total)}` });
      }
    } else if (v.budget_total === undefined) {
      ctx.addIssue({ code: "custom", path: ["budget_total"], message: "is required" });
    }
  })
  // Decision 1: with a gift list the total is the sum of the envelopes.
  .transform((v) => ({
    ...v,
    budget_total: v.recipients.length > 0 ? round2(v.recipients.reduce((t, r) => t + r.envelope, 0)) : (v.budget_total as number),
  }));

export function endOfMonthUtc(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString().replace(".000Z", "Z");
}

export type MandateInput = z.output<typeof MandateInputSchema>;

/** Keep a well-formed, unique client id (the draft's or the web editor's rcp_xxxxxxxx), else mint one. */
function recipientIds(input: MandateInput): Recipient[] {
  const used = new Set<string>();
  return input.recipients.map((r) => {
    let id = r.id && /^rcp_[A-Za-z0-9_-]{4,40}$/.test(r.id) && !used.has(r.id) ? r.id : newId("rcp");
    while (used.has(id)) id = newId("rcp");
    used.add(id);
    return { id, name: r.name, envelope: round2(r.envelope), interests: r.interests };
  });
}

export function buildMandate(input: MandateInput, status: Mandate["status"] = "draft", now = new Date()): Mandate {
  const blocked = input.blocked_categories;
  // Decision 4: never later than the PayPal authorization can be held.
  const expires = new Date(Math.min(Date.parse(input.expires_at), maxExpiry(now).getTime()));
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
    expires_at: isoSeconds(expires),
    status,
    paypal: { mode: rail.mode, authorization_id: null, vault_id: null, order_id: null },
    spent: 0,
    refunded: 0,
    created_at: now.toISOString(),
    recipients: recipientIds(input),
  };
}

/** What users call this mandate in ledger text. */
// User-visible text always says "gift list" (also for a legacy single-budget mandate); code keeps "mandate".
const listWord = (_m: Mandate) => "Gift list";

export function createMandate(s: Session, raw: unknown): Mandate {
  const parsed = MandateInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid gift list: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (Date.parse(parsed.data.expires_at) <= Date.now()) throw new HttpError(400, "Invalid gift list: expires_at is in the past.");
  if (s.mandate && s.mandate.status === "active") {
    throw new HttpError(409, "An active gift list already exists. Revoke it before creating a new one.");
  }
  const m = buildMandate(parsed.data);
  s.mandate = m;
  const people = m.recipients.length
    ? ` for ${m.recipients.length} ${m.recipients.length === 1 ? "person" : "people"} (${m.recipients.map((r) => `${r.name} ${usd(r.envelope)}`).join(", ")})`
    : " budget";
  addLedger(s, {
    actor: "user",
    action: "mandate.created",
    summary: `${listWord(m)} "${m.title}": ${usd(m.budget_total)}${people}, ask over ${usd(m.per_purchase_approval_over)}, blocked: ${m.blocked_categories.join(", ") || "none"}`,
    amount: m.budget_total,
  });
  touch(s);
  return m;
}

function requireMandate(s: Session, id: string): Mandate {
  if (!s.mandate || s.mandate.id !== id) throw new HttpError(404, "Gift list not found in this session.");
  return s.mandate;
}

export async function startApproval(s: Session, id: string, baseUrl: string): Promise<string> {
  const m = requireMandate(s, id);
  if (m.status !== "draft" && m.status !== "pending_paypal") throw new HttpError(409, `The gift list is ${m.status}; only a draft can be approved.`);
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
    summary: `Sent to PayPal to approve a ${usd(m.budget_total)} ${rail.mode === "authorization" ? "authorization hold" : rail.mode === "mock" ? "MOCK gift list" : "gift list"}`,
    amount: m.budget_total,
    paypal_id: m.paypal.order_id,
  });
  touch(s);
  return result.approveUrl;
}

export async function finalizeApproval(s: Session, id: string, token: string): Promise<Mandate> {
  const m = requireMandate(s, id);
  if (m.status === "active") return m; // idempotent: a reload of the return URL
  if (m.status !== "pending_paypal") throw new HttpError(409, `The gift list is ${m.status}, not awaiting PayPal.`);
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
        ? `PayPal authorized ${usd(m.budget_total)}; the agent can now spend inside the ${m.recipients.length ? "envelopes" : "gift list"}`
        : rail.mode === "mock"
          ? `${listWord(m)} approved (MOCK rail, no real money); agent can spend up to ${usd(m.budget_total)}`
          : `${listWord(m)} active; each purchase will be approved in PayPal`,
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
    addLedger(s, { actor: "user", action: "mandate.approval_cancelled", summary: `PayPal approval cancelled; the ${listWord(m).toLowerCase()} is a draft again` });
    touch(s);
  }
}

export async function revokeMandate(s: Session, id: string): Promise<Mandate> {
  const m = requireMandate(s, id);
  return withSessionLock(s, async () => {
    if (m.status === "revoked") return m;
    let voided: { paypal_id: string | null; nothing_to_void?: boolean } | null = null;
    if (m.status !== "draft") {
      try {
        voided = await rail.revoke(m);
      } catch (e) {
        // Still kill spending power on our side; the ledger records that PayPal disagreed.
        addLedger(s, { actor: "paypal", action: "paypal.error", summary: `PayPal void failed: ${errMsg(e)}` });
      }
    }
    m.status = "revoked";
    for (const p of s.purchases) {
      if (p.mandate_id === m.id && p.status === "pending_approval") {
        p.status = "rejected";
        p.reasons = [...p.reasons, `${listWord(m)} revoked before approval.`];
      }
    }
    if (voided?.paypal_id) {
      addLedger(s, {
        actor: "paypal",
        action: "paypal.void",
        summary: voided.nothing_to_void
          ? "Nothing left on the PayPal authorization to void"
          : rail.mode === "mock"
            ? "MOCK authorization voided"
            : "PayPal authorization voided; remaining hold released",
        paypal_id: voided.paypal_id,
      });
    }
    addLedger(s, { actor: "user", action: "mandate.revoked", summary: `${listWord(m)} "${m.title}" revoked; the agent has no spending power`, remaining_budget: 0 });
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
    product_id: i.product_id,
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

/** A gift-list person by id, or by name (case-insensitive) as a fallback for loose model input. */
export function findRecipient(m: Mandate | null, idOrName: string | null | undefined): Recipient | null {
  if (!m || !idOrName) return null;
  const key = idOrName.trim();
  return m.recipients.find((r) => r.id === key) ?? m.recipients.find((r) => r.name.toLowerCase() === key.toLowerCase()) ?? null;
}

/** " for Mom" when the purchase is for someone on the gift list, else "". */
function forWho(s: Session, p: Purchase): string {
  const r = p.recipient_id ? s.mandate?.recipients.find((x) => x.id === p.recipient_id) : undefined;
  return r ? ` for ${r.name}` : "";
}

/** The person's envelope and what is already charged for them (decision 6: derived, refunds free it). */
function policyRecipient(s: Session, r: Recipient | null): PolicyRecipient | null {
  if (!r) return null;
  const spent = round2(
    mandatePurchases(s)
      .filter((p) => p.recipient_id === r.id && p.status === "charged")
      .reduce((t, p) => t + p.total, 0),
  );
  return { id: r.id, name: r.name, envelope: r.envelope, spent };
}

/** Products already bought or waiting for approval under this mandate (decision 3: no duplicate gifts). */
/** Uncaptured room on the PayPal authorization: PayPal counts every capture against it, refunded or not.
 *  Applies to the authorization rail and to the mock rail that mirrors it; null for per-purchase orders. */
function holdLeft(s: Session): number | null {
  const m = s.mandate;
  if (!m || (rail.mode !== "authorization" && rail.mode !== "mock")) return null;
  const captured = mandatePurchases(s)
    .filter((p) => p.paypal.capture_id)
    .reduce((t, p) => t + p.total, 0);
  return round2(m.budget_total - captured);
}

function existingProductIds(s: Session, exceptPurchaseId: string): string[] {
  return mandatePurchases(s)
    .filter((p) => p.id !== exceptPurchaseId && (p.status === "charged" || p.status === "pending_approval"))
    .flatMap((p) => p.items.map((i) => i.product_id));
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
      addLedger(s, { actor: "paypal", action: "paypal.order_created", summary: `${label}Waiting for buyer approval in PayPal: ${describe(p.items)}${forWho(s, p)}`, amount: p.total, paypal_id: r.order_id, purchase_id: p.id });
      return;
    }
    p.status = "charged";
    p.paypal.order_id = r.order_id;
    p.paypal.capture_id = r.capture_id;
    m.spent = round2(m.spent + p.total);
    addLedger(s, {
      actor: "paypal",
      action: "paypal.capture",
      summary: `${label}${rail.mode === "mock" ? "MOCK capture" : "PayPal captured"} ${usd(p.total)} for ${describe(p.items)}${forWho(s, p)}`,
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
      summary: `${label}Charge failed for ${describe(p.items)}${forWho(s, p)}: ${p.error}`,
      amount: p.total,
      paypal_id: e instanceof PaymentError ? (e.debugId ?? null) : null,
      purchase_id: p.id,
    });
  }
  if (p.status === "charged") await shipPurchase(s, p, label);
}

/** "Mom's gift", or "the gift" / "the order" without a recipient. */
function giftOf(s: Session, p: Purchase): string {
  const r = p.recipient_id ? s.mandate?.recipients.find((x) => x.id === p.recipient_id) : undefined;
  return r ? `${r.name}'s gift` : "the order";
}

/**
 * Simulated fulfilment: right after a capture, "ship" the gift with a demo carrier and register the
 * tracking number with PayPal for that capture. Never fails the purchase: a PayPal error is logged in
 * the ledger and the purchase stays charged without a shipment. Caller holds the session lock.
 */
export async function shipPurchase(s: Session, p: Purchase, label = ""): Promise<void> {
  if (p.status !== "charged" || !p.paypal.capture_id || p.shipment || !rail.track || !s.mandate) return;
  const tracking = demoTrackingNumber();
  try {
    const t = await rail.track(s.mandate, {
      purchaseId: p.id,
      orderId: p.paypal.order_id,
      captureId: p.paypal.capture_id,
      trackingNumber: tracking,
      carrier: DEMO_CARRIER,
      carrierNameOther: DEMO_CARRIER_NAME,
      items: p.items.map((i) => ({ name: i.title.slice(0, 127), quantity: String(i.qty) })),
    });
    p.shipment = {
      carrier: DEMO_CARRIER,
      carrier_name: DEMO_CARRIER_NAME,
      tracking_number: tracking,
      status: "SHIPPED",
      tracker_id: t.tracker_id,
      shipped_at: new Date().toISOString(),
    };
    addLedger(s, {
      actor: "paypal",
      action: "paypal.tracking",
      summary:
        rail.mode === "mock"
          ? `${label}MOCK shipment: ${giftOf(s, p)} shipped with tracking ${tracking} (${DEMO_CARRIER_NAME})`
          : `${label}Shipped ${giftOf(s, p)}: tracking ${tracking} added to the PayPal ${t.via === "orders" ? "order" : "capture"} (${DEMO_CARRIER_NAME})`,
      paypal_id: t.tracker_id,
      purchase_id: p.id,
    });
  } catch (e) {
    p.shipment = null;
    addLedger(s, {
      actor: "paypal",
      action: "paypal.tracking_failed",
      summary: `${label}PayPal tracking failed: ${errMsg(e)}. The gift is still paid; it just has no tracking number.`,
      paypal_id: p.paypal.capture_id,
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
  /** Gift list: who this is for (id, or name as a fallback). Ignored on a legacy mandate. */
  recipientId?: string | null,
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
    const giftList = (m?.recipients.length ?? 0) > 0;
    const recipient = giftList ? findRecipient(m, recipientId) : null;
    const unknownRecipient = giftList && recipientId && !recipient ? recipientId : null;
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
      recipient_id: recipient?.id ?? null,
      shipment: null,
    };
    s.purchases.push(p);
    addLedger(s, {
      actor: "agent",
      action: origin === "redteam" ? "agent.hijacked_attempt" : "purchase.proposed",
      summary: `${label}${origin === "redteam" ? "Hijacked agent" : "Agent"} proposed ${describe(resolved) || "(no known items)"} for ${usd(total)}${recipient ? `, a gift for ${recipient.name}` : ""}${rationale ? ` — "${rationale.slice(0, 140)}"` : ""}`,
      amount: total,
      purchase_id: p.id,
    });

    const pre: string[] = [];
    if (unknown.length) pre.push(`Unknown product id(s) ${unknown.join(", ")}: the agent may only buy products returned by search_products.`);
    if (unknownRecipient) {
      pre.push(`"${unknownRecipient.slice(0, 60)}" is not on the gift list (${m!.recipients.map((r) => `${r.name} = ${r.id}`).join(", ")}).`);
    }
    const policy = pre.length
      ? { decision: "deny" as const, reasons: pre }
      : evaluatePolicy({
          mandate: m,
          items: policyItems(s, resolved),
          now: new Date(),
          recipient: policyRecipient(s, recipient),
          existingProductIds: existingProductIds(s, p.id),
          holdLeft: holdLeft(s),
        });
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
  // Gift list: the hijacked agent buys "for" the first person on the list (Mom in the demo).
  return proposePurchase(s, [{ product_id: inj.id, qty: HIJACK_QTY }], HIJACK_RATIONALE, baseUrl, "redteam", s.mandate?.recipients[0]?.id ?? null);
}

export interface GiftPlanEntry {
  recipient_id: string;
  product_id: string;
  rationale: string;
}

/**
 * Buy one gift per plan entry, in order, each through proposePurchase (policy, then the rail).
 * Sequential on purpose: each entry sees the envelopes, budget and duplicates left by the ones before.
 */
export async function buyGiftPlan(s: Session, plan: GiftPlanEntry[], baseUrl: string): Promise<BuyGiftPlanOutput> {
  const results: BuyGiftPlanOutput["results"] = [];
  for (const e of plan) {
    const r = findRecipient(s.mandate, e.recipient_id);
    const row = { recipient_id: r?.id ?? e.recipient_id, recipient_name: r?.name ?? e.recipient_id };
    if (s.mandate && s.mandate.recipients.length === 0) {
      results.push({ ...row, purchase: null, error: "This gift list has no people on it; use propose_purchase." });
      continue;
    }
    try {
      const purchase = await proposePurchase(s, [{ product_id: e.product_id, qty: 1 }], e.rationale, baseUrl, "agent", e.recipient_id);
      results.push({ ...row, purchase, error: purchase.status === "failed" ? purchase.error : null });
    } catch (err) {
      results.push({ ...row, purchase: null, error: errMsg(err) });
    }
  }
  return { results, remaining: remaining(s), recipients: recipientStatuses(s) };
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
    addLedger(s, { actor: "user", action: "purchase.approved", summary: `You approved ${describe(p.items)}${forWho(s, p)} (${usd(p.total)})`, amount: p.total, purchase_id: p.id });
    // Re-check every hard limit: budget, envelope, duplicates or status may have changed since the proposal.
    const policy = evaluatePolicy({
      mandate: s.mandate,
      items: policyItems(s, p.items),
      now: new Date(),
      humanApproved: true,
      recipient: policyRecipient(s, findRecipient(s.mandate, p.recipient_id)),
      existingProductIds: existingProductIds(s, p.id),
      holdLeft: holdLeft(s),
    });
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
  addLedger(s, { actor: "user", action: "purchase.rejected", summary: `You declined ${describe(p.items)}${forWho(s, p)} (${usd(p.total)}); nothing was charged`, amount: p.total, purchase_id: p.id });
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
      addLedger(s, { actor: "paypal", action: "paypal.capture", summary: `PayPal captured ${usd(p.total)} for ${describe(p.items)}${forWho(s, p)}`, amount: p.total, paypal_id: capture_id, purchase_id: p.id });
      refreshMandateStatus(s);
    } catch (e) {
      p.status = "failed";
      p.error = errMsg(e);
      addLedger(s, { actor: "paypal", action: "paypal.error", summary: `Capture failed: ${p.error}`, amount: p.total, purchase_id: p.id });
    }
    if (p.status === "charged") await shipPurchase(s, p);
    touch(s);
    return p;
  });
}

export async function refundPurchase(s: Session, id: string, reason: string, actor: "user" | "agent"): Promise<Purchase> {
  return withSessionLock(s, async () => {
    const p = findPurchase(s, id);
    if (p.status !== "charged" || !p.paypal.capture_id) throw new HttpError(409, `Purchase is ${p.status}; only a charged purchase can be refunded.`);
    const m = s.mandate && s.mandate.id === p.mandate_id ? s.mandate : null;
    const who = findRecipient(m, p.recipient_id);
    addLedger(s, { actor, action: "refund.requested", summary: `Refund requested for ${describe(p.items)}${forWho(s, p)}${reason ? `: ${reason.slice(0, 140)}` : ""}`, amount: p.total, purchase_id: p.id });
    try {
      const { refund_id } = await rail.refund(m ?? (s.mandate as Mandate), p.paypal.capture_id, p.total, p.id);
      p.status = "refunded";
      p.paypal.refund_id = refund_id;
      if (m) m.refunded = round2(m.refunded + p.total);
      if (m) refreshMandateStatus(s);
      addLedger(s, {
        actor: "paypal",
        action: "paypal.refund",
        summary: `${rail.mode === "mock" ? "MOCK refund" : "PayPal refunded"} ${usd(p.total)} for ${describe(p.items)}${forWho(s, p)}; ${who ? `${who.name}'s envelope and the budget` : "budget"} restored`,
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

export function recordSearch(
  s: Session,
  query: string,
  source: "channel3" | "catalog",
  products: Product[],
  fallback?: string,
  recipient?: Recipient | null,
) {
  for (const p of products) s.products[p.id] = p;
  s.last_source = source;
  addLedger(s, {
    actor: "agent",
    action: "search",
    summary: `Searched ${source} for "${query.slice(0, 80)}"${recipient ? ` for ${recipient.name}` : ""}: ${products.length} result(s)${fallback ? " (Channel3 unavailable, used catalog)" : ""}`,
    recipient_id: recipient?.id ?? null,
  });
  touch(s);
}

// ---------------------------------------------------------------- PayPal webhooks

/** The part of a PayPal webhook event Ribbon reads (verified before it gets here). */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  create_time?: string;
  resource?: any;
}

export type WebhookOutcome =
  | { matched: false; reason: string }
  | { matched: true; duplicate: boolean; session_id: string; ledger_id: string | null; summary: string };

/** Event ids already seen that matched no session: log them once, not on every PayPal retry. */
const unmatchedSeen = new Set<string>();
const MAX_EVENT_IDS = 200;

type ResourceKind = "capture" | "refund" | "authorization" | "order" | "other";

function resourceKind(eventType: string): ResourceKind {
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") return "refund";
  if (eventType.startsWith("PAYMENT.CAPTURE.")) return "capture";
  if (eventType.startsWith("PAYMENT.AUTHORIZATION.")) return "authorization";
  if (eventType.startsWith("CHECKOUT.ORDER.")) return "order";
  return "other";
}

/** The capture a refund belongs to, from its `up` link (…/v2/payments/captures/{id}). */
function upCaptureId(resource: any): string | null {
  const href = (resource?.links ?? []).find((l: any) => l?.rel === "up")?.href;
  return typeof href === "string" ? (/\/captures\/([A-Za-z0-9]+)/.exec(href)?.[1] ?? null) : null;
}

interface WebhookMatch {
  purchase: Purchase | null;
  mandate: Mandate | null;
  noun: string;
}

/** Find what this event is about in one session, by PayPal id first, then by our own invoice/custom ids. */
function matchWebhook(s: Session, kind: ResourceKind, r: any): WebhookMatch | null {
  const rid = typeof r?.id === "string" ? r.id : null;
  if (!rid) return null;
  const invoice = typeof r?.invoice_id === "string" ? r.invoice_id : null;
  const purchases = s.purchases;
  const m = s.mandate;
  const byPurchase = (p: Purchase | undefined, noun: string): WebhookMatch | null => (p ? { purchase: p, mandate: m && m.id === p.mandate_id ? m : null, noun } : null);
  switch (kind) {
    case "capture":
      return byPurchase(purchases.find((p) => p.paypal.capture_id === rid) ?? (invoice ? purchases.find((p) => p.id === invoice) : undefined), "capture");
    case "refund": {
      const up = upCaptureId(r);
      return byPurchase(
        purchases.find((p) => p.paypal.refund_id === rid) ??
          (invoice ? purchases.find((p) => `${p.id}-r` === invoice) : undefined) ??
          (up ? purchases.find((p) => p.paypal.capture_id === up) : undefined),
        "refund",
      );
    }
    case "authorization":
      return m && m.paypal.authorization_id === rid ? { purchase: null, mandate: m, noun: "authorization" } : null;
    case "order":
      if (m && m.paypal.order_id === rid) return { purchase: null, mandate: m, noun: "order" };
      // per_purchase rail: every purchase has its own order.
      return byPurchase(purchases.find((p) => p.paypal.order_id === rid && p.paypal.order_id !== m?.paypal.order_id), "order");
    default:
      if (m && (m.paypal.authorization_id === rid || m.paypal.order_id === rid)) return { purchase: null, mandate: m, noun: "PayPal object" };
      return byPurchase(purchases.find((p) => p.paypal.capture_id === rid || p.paypal.refund_id === rid), "PayPal object");
  }
}

/**
 * A verified PayPal webhook becomes one ledger row in the session that owns the capture, refund,
 * authorization or order. A confirmation trail only: balances, statuses and envelopes never change here
 * (the policy engine and the rail are the source of truth, so a missed or late webhook changes nothing).
 * Idempotent by event id. Events about unknown resources only get a log line.
 */
export function recordPayPalWebhook(event: PayPalWebhookEvent, sessions: Iterable<Session> = allSessions()): WebhookOutcome {
  const kind = resourceKind(event.event_type);
  const r = event.resource ?? {};
  for (const s of sessions) {
    const hit = matchWebhook(s, kind, r);
    if (!hit) continue;
    if (s.webhook_event_ids.includes(event.id)) {
      return { matched: true, duplicate: true, session_id: s.id, ledger_id: null, summary: "" };
    }
    const status = typeof r.status === "string" ? r.status : "";
    const who = hit.purchase ? forWho(s, hit.purchase) : "";
    const summary = `PayPal confirmed: ${hit.noun} ${r.id}${status ? ` ${status}` : ""}${who} (webhook ${event.event_type})`;
    const row = addLedger(s, {
      actor: "paypal",
      action: "paypal.webhook",
      summary,
      paypal_id: r.id,
      purchase_id: hit.purchase?.id ?? null,
    });
    s.webhook_event_ids.push(event.id);
    if (s.webhook_event_ids.length > MAX_EVENT_IDS) s.webhook_event_ids.splice(0, s.webhook_event_ids.length - MAX_EVENT_IDS);
    touch(s);
    return { matched: true, duplicate: false, session_id: s.id, ledger_id: row.id, summary };
  }
  if (!unmatchedSeen.has(event.id)) {
    unmatchedSeen.add(event.id);
    if (unmatchedSeen.size > 1000) unmatchedSeen.delete(unmatchedSeen.values().next().value as string);
    console.log(`[paypal] webhook ${event.event_type} ${event.id}: resource ${r?.id ?? "(none)"} is not in any session; logged only`);
  }
  return { matched: false, reason: `No session has ${kind} ${r?.id ?? "(no id)"}` };
}

export { remaining };
