import { describe, expect, it } from "vitest";
import type { Mandate, Recipient } from "../shared/types.ts";
import { evaluatePolicy, purchaseTotal, remainingBudget, type PolicyItem, type PolicyRecipient } from "./policy.ts";

const NOW = new Date("2026-11-10T12:00:00Z");

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "mdt_test",
    title: "Test",
    currency: "USD",
    budget_total: 150,
    per_purchase_approval_over: 60,
    allowed_categories: ["gifts", "home", "garden", "kitchen"],
    blocked_categories: ["electronics"],
    max_quantity_per_item: 2,
    expires_at: "2026-11-30T23:59:59Z",
    status: "active",
    paypal: { mode: "mock", authorization_id: null, vault_id: null, order_id: null },
    spent: 0,
    refunded: 0,
    created_at: "2026-11-01T00:00:00Z",
    recipients: [],
    ...over,
  };
}

const item = (over: Partial<PolicyItem> = {}): PolicyItem => ({
  title: "Herb planter",
  price: 40,
  qty: 1,
  category: "garden",
  category_confidence: "high",
  merchant: "Shop",
  ...over,
});

const run = (m: Mandate | null, items: PolicyItem[], humanApproved = false) =>
  evaluatePolicy({ mandate: m, items, now: NOW, humanApproved });

describe("evaluatePolicy", () => {
  it("allows a purchase inside every limit", () => {
    const r = run(mandate(), [item()]);
    expect(r.decision).toBe("allow");
    expect(r.reasons[0]).toMatch(/Within the gift list/);
  });

  it("denies when there is no mandate", () => {
    expect(run(null, [item()]).decision).toBe("deny");
  });

  it.each(["draft", "pending_paypal", "revoked", "expired", "exhausted"] as const)("denies when mandate is %s", (status) => {
    const r = run(mandate({ status }), [item()]);
    expect(r.decision).toBe("deny");
    expect(r.reasons[0]).toContain(status);
  });

  it("denies after expiry even if status is still active", () => {
    const r = run(mandate({ expires_at: "2026-11-09T00:00:00Z" }), [item()]);
    expect(r.decision).toBe("deny");
    expect(r.reasons[0]).toMatch(/expired/);
  });

  it("denies an empty purchase", () => {
    expect(run(mandate(), []).decision).toBe("deny");
  });

  it("denies invalid price or quantity", () => {
    expect(run(mandate(), [item({ price: 0 })]).decision).toBe("deny");
    expect(run(mandate(), [item({ qty: 0 })]).decision).toBe("deny");
    expect(run(mandate(), [item({ qty: 1.5 })]).decision).toBe("deny");
  });

  it("denies a blocked category even with an empty allow list", () => {
    const r = run(mandate({ allowed_categories: [] }), [item({ category: "electronics", title: "Robot vacuum" })]);
    expect(r.decision).toBe("deny");
    expect(r.reasons[0]).toMatch(/blocked/);
  });

  it("denies a category outside the allow list", () => {
    const r = run(mandate(), [item({ category: "toys" })]);
    expect(r.decision).toBe("deny");
    expect(r.reasons[0]).toMatch(/not in the allowed/);
  });

  it("treats an empty allow list as any non-blocked category", () => {
    expect(run(mandate({ allowed_categories: [] }), [item({ category: "toys" })]).decision).toBe("allow");
  });

  it("asks a human when the category is uncertain", () => {
    const r = run(mandate(), [item({ category_confidence: "low" })]);
    expect(r.decision).toBe("needs_approval");
    expect(r.reasons[0]).toMatch(/uncertain/);
  });

  it("deny beats needs_approval (uncertain category plus over budget)", () => {
    const r = run(mandate(), [item({ category_confidence: "low", price: 500 })]);
    expect(r.decision).toBe("deny");
  });

  it("denies a quantity above the per-item cap (prompt-injection: buy 5 units)", () => {
    const r = run(mandate(), [item({ qty: 5, price: 10 })]);
    expect(r.decision).toBe("deny");
    expect(r.reasons.join(" ")).toMatch(/per-item cap of 2/);
  });

  it("denies a total above the remaining budget, counting spent and refunded", () => {
    const m = mandate({ spent: 120, refunded: 0 });
    expect(remainingBudget(m)).toBe(30);
    expect(run(m, [item({ price: 40 })]).decision).toBe("deny");
    const refunded = mandate({ spent: 120, refunded: 40 });
    expect(run(refunded, [item({ price: 40 })]).decision).toBe("allow");
  });

  it("collects every deny reason", () => {
    const r = run(mandate(), [item({ category: "electronics", qty: 5, price: 100 })]);
    expect(r.decision).toBe("deny");
    expect(r.reasons).toHaveLength(3);
  });

  it("needs approval above the threshold; exactly the threshold is allowed", () => {
    expect(run(mandate(), [item({ price: 60 })]).decision).toBe("allow");
    const r = run(mandate(), [item({ price: 60.01 })]);
    expect(r.decision).toBe("needs_approval");
    expect(r.reasons[0]).toMatch(/threshold/);
  });

  it("applies the threshold to the purchase total, not the unit price", () => {
    expect(run(mandate(), [item({ price: 35, qty: 2 })]).decision).toBe("needs_approval");
  });

  it("human approval clears threshold and low-confidence checks but not hard limits", () => {
    expect(run(mandate(), [item({ price: 90, category_confidence: "low" })], true).decision).toBe("allow");
    expect(run(mandate({ spent: 100 }), [item({ price: 90 })], true).decision).toBe("deny");
    expect(run(mandate({ status: "revoked" }), [item()], true).decision).toBe("deny");
  });

  it("sums totals in cents without float drift", () => {
    expect(purchaseTotal([item({ price: 19.99, qty: 2 }), item({ price: 0.1, qty: 1 })])).toBe(40.08);
  });
});

// ---------------------------------------------------------------- gift list (GIFTLIST_SPEC §4)

const DEMO: Recipient[] = [
  { id: "rcp_mom", name: "Mom", envelope: 60, interests: "loves gardening" },
  { id: "rcp_dad", name: "Dad", envelope: 50, interests: "coffee nerd" },
  { id: "rcp_leo", name: "Leo", envelope: 30, interests: "dinosaurs" },
  { id: "rcp_sam", name: "Sam", envelope: 30, interests: "soccer" },
  { id: "rcp_santa", name: "Office Secret Santa", envelope: 30, interests: "something for the desk" },
];

/** The demo list: $200 = 60 + 50 + 30 + 30 + 30, ask over $45, no electronics, qty cap 2. */
const giftList = (over: Partial<Mandate> = {}) =>
  mandate({
    budget_total: 200,
    per_purchase_approval_over: 45,
    allowed_categories: ["gifts", "home", "garden", "kitchen", "toys", "sports", "books", "office", "clothing", "beauty"],
    recipients: DEMO,
    ...over,
  });

const mom = (spent = 0): PolicyRecipient => ({ id: "rcp_mom", name: "Mom", envelope: 60, spent });

const gift = (
  m: Mandate,
  items: PolicyItem[],
  opts: { recipient?: PolicyRecipient | null; existing?: string[]; humanApproved?: boolean } = {},
) =>
  evaluatePolicy({
    mandate: m,
    items,
    now: NOW,
    recipient: opts.recipient,
    existingProductIds: opts.existing,
    humanApproved: opts.humanApproved,
  });

describe("evaluatePolicy: gift list", () => {
  it("allows a gift inside the person's envelope", () => {
    const r = gift(giftList(), [item({ product_id: "cat_herb_kit", price: 38 })], { recipient: mom() });
    expect(r.decision).toBe("allow");
  });

  it("denies a purchase that names no recipient", () => {
    for (const recipient of [undefined, null]) {
      const r = gift(giftList(), [item()], { recipient });
      expect(r.decision).toBe("deny");
      expect(r.reasons).toContain("Pick who this gift is for: every purchase must name someone on the list.");
    }
  });

  it("denies a gift that exceeds the envelope, counting what is already charged", () => {
    const r = gift(giftList(), [item({ price: 40 })], { recipient: mom(30) });
    expect(r.decision).toBe("deny");
    expect(r.reasons).toEqual(["$40.00 for Mom exceeds Mom's envelope: $30.00 left of $60.00."]);
    // Exactly the envelope left is fine (then the threshold may still ask).
    expect(gift(giftList(), [item({ price: 30 })], { recipient: mom(30) }).decision).toBe("allow");
  });

  it("denies a duplicate gift already bought or pending for anyone on the list", () => {
    const r = gift(giftList(), [item({ product_id: "cat_herb_kit", title: "Indoor Herb Garden Starter Kit", price: 38 })], {
      recipient: mom(),
      existing: ["cat_soccer_ball", "cat_herb_kit"],
    });
    expect(r.decision).toBe("deny");
    expect(r.reasons).toEqual(["Indoor Herb Garden Starter Kit is already bought for someone on the list; no duplicate gifts."]);
  });

  it("human approval clears the threshold but never the recipient, envelope or duplicate checks", () => {
    const m = giftList();
    // Over the $45 threshold inside the envelope: needs approval, then allowed once approved.
    expect(gift(m, [item({ price: 52 })], { recipient: mom() }).decision).toBe("needs_approval");
    expect(gift(m, [item({ price: 52 })], { recipient: mom(), humanApproved: true }).decision).toBe("allow");
    // Hard gift-list limits survive approval.
    expect(gift(m, [item()], { recipient: null, humanApproved: true }).decision).toBe("deny");
    expect(gift(m, [item({ price: 52 })], { recipient: mom(20), humanApproved: true }).decision).toBe("deny");
    expect(gift(m, [item({ product_id: "x1" })], { recipient: mom(), existing: ["x1"], humanApproved: true }).decision).toBe("deny");
  });

  it("puts the gift-list reasons after the budget reason", () => {
    const r = gift(giftList({ spent: 190 }), [item({ price: 40 })], { recipient: mom(30) });
    expect(r.reasons).toEqual([
      "Total $40.00 exceeds the remaining budget of $10.00.",
      "$40.00 for Mom exceeds Mom's envelope: $30.00 left of $60.00.",
    ]);
  });

  it("leaves a legacy mandate (no recipients) unchanged: no recipient needed, envelopes and duplicates ignored", () => {
    const legacy = mandate();
    const items = [item({ product_id: "cat_herb_kit" })];
    const plain = evaluatePolicy({ mandate: legacy, items, now: NOW });
    const withGiftInputs = gift(legacy, items, { recipient: { id: "r", name: "X", envelope: 1, spent: 1 }, existing: ["cat_herb_kit"] });
    expect(plain).toEqual({ decision: "allow", reasons: [expect.stringMatching(/Within the gift list/)] });
    expect(withGiftInputs).toEqual(plain);
  });

  it("denies the red-team hijack for Mom (5 x $34 = $170): quantity cap and envelope", () => {
    const hijack = [item({ product_id: "cat_injection_seedbox", title: "Deluxe Herb Seed Gift Box", price: 34, qty: 5 })];
    const r = gift(giftList(), hijack, { recipient: mom() });
    expect(r.decision).toBe("deny");
    expect(r.reasons).toEqual([
      'Quantity 5 of "Deluxe Herb Seed Gift Box" exceeds the per-item cap of 2.',
      "$170.00 for Mom exceeds Mom's envelope: $60.00 left of $60.00.",
    ]);
    // Once $40 is spent elsewhere on the list the $170 also breaks the total budget.
    const later = gift(giftList({ spent: 40 }), hijack, { recipient: mom() });
    expect(later.reasons).toHaveLength(3);
    expect(later.reasons[1]).toBe("Total $170.00 exceeds the remaining budget of $160.00.");
    // And a human cannot approve it through.
    expect(gift(giftList(), hijack, { recipient: mom(), humanApproved: true }).decision).toBe("deny");
  });
});
