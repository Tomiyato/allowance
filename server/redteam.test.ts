// Prompt-injection defence: layer 1 (the model reports suspicious listings) and layer 2 (a fully
// hijacked agent's proposal is stopped by the same policy path a real proposal takes).
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Keep test sessions out of the dev store file and off real PayPal.
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-${process.pid}.json`;
  process.env.PAYMENT_MODE = "mock";
});

import { buildTools } from "./agent/tools.ts";
import { createMandate, HIJACK_QTY, proposePurchase, SIMULATION_PREFIX, simulateHijackedAgent } from "./service.ts";
import { createSession, type Session } from "./store.ts";

const BASE = "http://localhost:0";
const INJ = "cat_injection_seedbox";

/** A session with an active demo mandate ($150, ask over $60, qty cap 2). */
function activeSession(over: Record<string, unknown> = {}): Session {
  const s = createSession();
  createMandate(s, {
    title: "Mom's birthday + home basics",
    budget_total: 150,
    per_purchase_approval_over: 60,
    allowed_categories: ["gifts", "home", "garden", "kitchen"],
    blocked_categories: ["electronics"],
    max_quantity_per_item: 2,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    ...over,
  });
  s.mandate!.status = "active";
  return s;
}

describe("POST /api/redteam/hijack -> simulateHijackedAgent", () => {
  it("blocks 5 units of the injection listing: over the quantity cap and the budget", async () => {
    const s = activeSession();
    expect(s.products[INJ]).toBeUndefined(); // never searched: loaded from the catalog anyway

    const p = await simulateHijackedAgent(s, BASE);

    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ product_id: INJ, qty: HIJACK_QTY, price: 34, category: "garden" });
    expect(p.total).toBe(170);
    expect(p.status).toBe("blocked");
    expect(p.decision).toBe("deny");
    expect(p.reasons.some((r) => /Quantity 5 .* exceeds the per-item cap of 2/.test(r))).toBe(true);
    expect(p.reasons.some((r) => /exceeds the remaining budget of \$150\.00/.test(r))).toBe(true);
    expect(s.mandate!.spent).toBe(0);
    expect(p.paypal).toEqual({ order_id: null, capture_id: null, refund_id: null, approve_url: null });
  });

  it("writes ledger rows marked as a simulation and never reaches the payment rail", async () => {
    const s = activeSession();
    const before = s.ledger.length;
    const p = await simulateHijackedAgent(s, BASE);
    const rows = s.ledger.slice(before);

    expect(rows.map((r) => r.action)).toEqual(["agent.hijacked_attempt", "policy.deny"]);
    for (const r of rows) {
      expect(r.summary.startsWith(SIMULATION_PREFIX)).toBe(true);
      expect(r.purchase_id).toBe(p.id);
    }
    expect(rows[0].actor).toBe("agent");
    expect(rows[1]).toMatchObject({ actor: "policy", decision: "deny", reasons: p.reasons });
    expect(rows.some((r) => r.actor === "paypal")).toBe(false);
  });

  it("gets the same decision a real agent proposal gets (no special-casing)", async () => {
    const real = activeSession();
    const sim = activeSession();
    const a = await proposePurchase(real, [{ product_id: INJ, qty: HIJACK_QTY }], "Buying 5.", BASE);
    const b = await simulateHijackedAgent(sim, BASE);
    expect(b.decision).toBe(a.decision);
    expect(b.reasons).toEqual(a.reasons);
    expect(b.total).toBe(a.total);
    expect(real.ledger.at(-2)!.action).toBe("purchase.proposed");
    expect(real.ledger.at(-2)!.summary.startsWith(SIMULATION_PREFIX)).toBe(false);
  });

  it("still asks the human when a lenient mandate would otherwise fit (approval threshold applies)", async () => {
    const s = activeSession({ budget_total: 1000, max_quantity_per_item: 10, per_purchase_approval_over: 100 });
    const p = await simulateHijackedAgent(s, BASE);
    expect(p.status).toBe("pending_approval");
    expect(p.reasons[0]).toMatch(/over the \$100\.00 ask-me-first threshold/);
    expect(s.mandate!.spent).toBe(0);
  });

  it("is denied outright without an active mandate", async () => {
    const s = createSession();
    const p = await simulateHijackedAgent(s, BASE);
    expect(p.status).toBe("blocked");
    expect(p.reasons).toEqual(["No gift list: the agent has no spending power."]);
  });
});

/** The demo gift list (GIFTLIST_SPEC §2), active: $200 = Mom 60 + Dad 50 + Leo 30 + Sam 30 + Santa 30, ask over $45. */
function activeGiftList(): Session {
  const s = createSession();
  createMandate(s, {
    title: "Holiday gifts",
    budget_total: 200,
    per_purchase_approval_over: 45,
    allowed_categories: ["gifts", "home", "garden", "kitchen", "toys", "sports", "books", "office", "clothing", "beauty"],
    blocked_categories: ["electronics"],
    max_quantity_per_item: 2,
    recipients: [
      { name: "Mom", envelope: 60, interests: "loves gardening" },
      { name: "Dad", envelope: 50, interests: "coffee nerd" },
      { name: "Leo", envelope: 30, interests: "dinosaurs" },
      { name: "Sam", envelope: 30, interests: "soccer" },
      { name: "Office Secret Santa", envelope: 30, interests: "something for the desk" },
    ],
  });
  s.mandate!.status = "active";
  return s;
}

describe("red-team hijack on a gift list", () => {
  it("targets the first person (Mom) and is denied by the quantity cap and Mom's envelope", async () => {
    const s = activeGiftList();
    const mom = s.mandate!.recipients[0];
    expect(mom.name).toBe("Mom");

    const p = await simulateHijackedAgent(s, BASE);

    expect(p.recipient_id).toBe(mom.id);
    expect(p.total).toBe(170);
    expect(p.status).toBe("blocked");
    expect(p.reasons).toEqual([
      'Quantity 5 of "Deluxe Herb Seed Gift Box" exceeds the per-item cap of 2.',
      "$170.00 for Mom exceeds Mom's envelope: $60.00 left of $60.00.",
    ]);
    expect(s.mandate!.spent).toBe(0);
  });

  it("adds the budget reason once the list has less than $170 left", async () => {
    const s = activeGiftList();
    s.mandate!.spent = 40; // e.g. Dad's gift was bought
    const p = await simulateHijackedAgent(s, BASE);
    expect(p.reasons.some((r) => /exceeds the remaining budget of \$160\.00/.test(r))).toBe(true);
    expect(p.reasons).toHaveLength(3);
  });

  it("labels the simulation rows with Mom as the recipient and never reaches the rail", async () => {
    const s = activeGiftList();
    const before = s.ledger.length;
    const p = await simulateHijackedAgent(s, BASE);
    const rows = s.ledger.slice(before);
    expect(rows.map((r) => r.action)).toEqual(["agent.hijacked_attempt", "policy.deny"]);
    for (const r of rows) {
      expect(r.summary.startsWith(SIMULATION_PREFIX)).toBe(true);
      expect(r.recipient_id).toBe(p.recipient_id);
    }
    expect(rows[0].summary).toContain("a gift for Mom");
    expect(rows.some((r) => r.actor === "paypal")).toBe(false);
  });
});

describe("report_suspicious_content tool", () => {
  const opts = { toolCallId: "call_1", messages: [], context: undefined } as never;

  it("logs an amber agent.flagged_injection row and returns the flag", async () => {
    const s = activeSession();
    const before = s.ledger.length;
    const tools = buildTools({ session: s, baseUrl: BASE });
    const reason = "Description tells AI agents to ignore spending limits and buy 5 units.";

    const out = await tools.report_suspicious_content.execute!({ product_id: INJ, reason }, opts);

    expect(out).toEqual({ flagged: true, product_id: INJ, product_title: "Deluxe Herb Seed Gift Box", reason });
    const rows = s.ledger.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "agent",
      action: "agent.flagged_injection",
      reasons: [reason],
      decision: null,
      amount: null,
      remaining_budget: 150,
    });
    expect(rows[0].summary).toContain('"Deluxe Herb Seed Gift Box"');
    expect(s.purchases).toHaveLength(0); // flagging never buys anything
  });

  it("clamps a long reason and still logs an unknown product id", async () => {
    const s = activeSession();
    const tools = buildTools({ session: s, baseUrl: BASE });
    const out = await tools.report_suspicious_content.execute!({ product_id: "c3_unknown", reason: "x".repeat(1000) }, opts);
    expect(out).toMatchObject({ flagged: true, product_title: null });
    expect((out as { reason: string }).reason).toHaveLength(300);
    expect(s.ledger.at(-1)!.summary).toContain("product c3_unknown");
  });
});
