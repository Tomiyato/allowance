import { describe, expect, it } from "vitest";
import type { Mandate } from "../shared/types.ts";
import { evaluatePolicy, purchaseTotal, remainingBudget, type PolicyItem } from "./policy.ts";

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
    expect(r.reasons[0]).toMatch(/Within mandate/);
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
