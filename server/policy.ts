// Deterministic spending-policy engine (SPEC §4, gift-list checks: GIFTLIST_SPEC §4). Pure: no I/O, no clock reads, no LLM.
// The LLM can only *propose*; this function decides whether money may move.
import type { Mandate, PolicyResult } from "../shared/types.ts";

export interface PolicyItem {
  /** Product id; needed for the gift-list duplicate check. */
  product_id?: string;
  title: string;
  price: number; // unit price, dollars
  qty: number;
  category: string;
  category_confidence?: "high" | "low";
  merchant?: string;
}

export interface PolicyInput {
  mandate: Mandate | null;
  items: PolicyItem[];
  now: Date;
  /** True when a human already approved this exact purchase: the approval threshold
   *  and low-confidence checks no longer apply, every hard limit still does. */
  humanApproved?: boolean;
  /** Gift list: who the purchase is for, with that person's envelope and what is already charged
   *  for them. Only read when the mandate has recipients; null/undefined there = no recipient named. */
  recipient?: PolicyRecipient | null;
  /** Gift list: product ids already in a charged or pending_approval purchase of this mandate
   *  (excluding the purchase being evaluated). */
  existingProductIds?: string[];
  /** Uncaptured room left on the PayPal authorization hold (budget minus every capture, refunded or
   *  not: a refund goes back to the buyer, it does not refill the hold). null/undefined = no hold. */
  holdLeft?: number | null;
}

export interface PolicyRecipient {
  id: string;
  name: string;
  envelope: number;
  spent: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function remainingBudget(m: Mandate): number {
  return round2(m.budget_total - m.spent + m.refunded);
}

export function purchaseTotal(items: PolicyItem[]): number {
  return round2(items.reduce((s, i) => s + i.price * i.qty, 0));
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { mandate: m, items, now } = input;

  // 1. Mandate status and expiry — nothing else matters if there is no spending power.
  if (!m) return { decision: "deny", reasons: ["No gift list: the agent has no spending power."] };
  if (m.status !== "active") {
    return { decision: "deny", reasons: [`The gift list is ${m.status}, not active.`] };
  }
  if (now.getTime() > Date.parse(m.expires_at)) {
    return { decision: "deny", reasons: [`The gift list expired at ${m.expires_at}.`] };
  }
  if (items.length === 0) return { decision: "deny", reasons: ["Purchase has no items."] };

  const deny: string[] = [];
  const ask: string[] = [];

  for (const it of items) {
    if (!Number.isFinite(it.price) || it.price <= 0) deny.push(`"${it.title}" has an invalid price.`);
    if (!Number.isInteger(it.qty) || it.qty < 1) deny.push(`"${it.title}" has an invalid quantity (${it.qty}).`);
  }

  // 2. Category: blocked list wins, then the allow list (empty allow list = any non-blocked category).
  const blocked = new Set(m.blocked_categories.map((c) => c.toLowerCase()));
  const allowed = new Set(m.allowed_categories.map((c) => c.toLowerCase()));
  for (const it of items) {
    const cat = it.category.toLowerCase();
    if (blocked.has(cat)) deny.push(`Category "${cat}" is blocked on this gift list ("${it.title}").`);
    else if (allowed.size > 0 && !allowed.has(cat)) {
      deny.push(`Category "${cat}" is not in the allowed categories (${[...allowed].join(", ")}) ("${it.title}").`);
    }
  }

  // 3. Low category confidence: we are not sure the category check above is right — ask the human.
  for (const it of items) {
    if (it.category_confidence === "low" && !input.humanApproved) {
      ask.push(`Category of "${it.title}" is uncertain (mapped to "${it.category}"); needs a human check.`);
    }
  }

  // 4. Quantity cap per item.
  for (const it of items) {
    if (it.qty > m.max_quantity_per_item) {
      deny.push(`Quantity ${it.qty} of "${it.title}" exceeds the per-item cap of ${m.max_quantity_per_item}.`);
    }
  }

  // 5. Remaining budget.
  const total = purchaseTotal(items);
  const remaining = remainingBudget(m);
  if (total > remaining + 1e-9) {
    deny.push(`Total ${usd(total)} exceeds the remaining budget of ${usd(remaining)}.`);
  }
  if (input.holdLeft != null && total > input.holdLeft + 1e-9) {
    deny.push(
      `The PayPal hold has ${usd(Math.max(0, input.holdLeft))} left to capture; refunds go back to your PayPal account, not onto the hold.`,
    );
  }

  // 6. Gift list (only when the mandate has recipients): every purchase names a person, fits that
  //    person's envelope, and never repeats a gift already bought or waiting for approval.
  if ((m.recipients?.length ?? 0) > 0) {
    const r = input.recipient;
    if (!r) {
      deny.push("Pick who this gift is for: every purchase must name someone on the list.");
    } else {
      const left = round2(r.envelope - r.spent);
      if (total > left + 1e-9) {
        deny.push(`${usd(total)} for ${r.name} exceeds ${r.name}'s envelope: ${usd(Math.max(0, left))} left of ${usd(r.envelope)}.`);
      }
    }
    const taken = new Set(input.existingProductIds ?? []);
    for (const it of items) {
      if (it.product_id && taken.has(it.product_id)) {
        deny.push(`${it.title} is already bought for someone on the list; no duplicate gifts.`);
      }
    }
  }

  if (deny.length > 0) return { decision: "deny", reasons: deny };

  // 7. Approval threshold (strictly "over": exactly the threshold is allowed).
  if (total > m.per_purchase_approval_over + 1e-9 && !input.humanApproved) {
    ask.push(`Total ${usd(total)} is over the ${usd(m.per_purchase_approval_over)} ask-me-first threshold.`);
  }

  if (ask.length > 0) return { decision: "needs_approval", reasons: ask };

  return {
    decision: "allow",
    reasons: [
      input.humanApproved
        ? `Approved by the user; ${usd(total)} fits the remaining ${usd(remaining)}.`
        : `Within the gift list: ${usd(total)} of ${usd(remaining)} remaining, categories allowed, quantity within cap.`,
    ],
  };
}
