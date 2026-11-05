// Gift list (GIFTLIST_SPEC §1, §4): mandate input, buy_gift_plan, envelopes, duplicates, approval
// re-check, refunds and the agent tools, on the MOCK rail.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STORE_FILE = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/allowance-test-gl-${process.pid}.json`;
  process.env.PAYMENT_MODE = "mock";
  process.env.PRODUCT_SOURCE = "catalog";
  process.env.DEMO_INJECTION = "1";
});

import type { GetMandateOutput, ProposePurchaseOutput, SearchGiftsOutput } from "../shared/types.ts";
import { buildTools } from "./agent/tools.ts";
import {
  approvePurchase,
  buyGiftPlan,
  createMandate,
  MandateInputSchema,
  PAYPAL_HOLD_DAYS,
  proposePurchase,
  refundPurchase,
  revokeMandate,
} from "./service.ts";
import { appState, createSession, recipientStatuses, type Session } from "./store.ts";

const BASE = "http://localhost:0";
const DEMO_RECIPIENTS = [
  { name: "Mom", envelope: 60, interests: "loves gardening" },
  { name: "Dad", envelope: 50, interests: "coffee nerd" },
  { name: "Leo", envelope: 30, interests: "dinosaurs" },
  { name: "Sam", envelope: 30, interests: "soccer" },
  { name: "Office Secret Santa", envelope: 30, interests: "something for the desk" },
];
const DEMO_INPUT = {
  title: "Holiday gifts",
  budget_total: 200,
  per_purchase_approval_over: 45,
  allowed_categories: ["gifts", "home", "garden", "kitchen", "toys", "sports", "books", "office", "clothing", "beauty"],
  blocked_categories: ["electronics"],
  max_quantity_per_item: 2,
  recipients: DEMO_RECIPIENTS,
};

function demo(): { s: Session; id: Record<string, string> } {
  const s = createSession();
  createMandate(s, DEMO_INPUT);
  s.mandate!.status = "active";
  const id = Object.fromEntries(s.mandate!.recipients.map((r) => [r.name.split(" ")[0].toLowerCase(), r.id]));
  return { s, id };
}

const issues = (raw: unknown) => {
  const r = MandateInputSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("MandateInputSchema with recipients", () => {
  it("accepts the demo list and keeps the total equal to the envelopes", () => {
    const r = MandateInputSchema.parse(DEMO_INPUT);
    expect(r.budget_total).toBe(200);
    expect(r.recipients.map((x) => x.name)).toEqual(["Mom", "Dad", "Leo", "Sam", "Office Secret Santa"]);
  });

  it("derives the total when it is omitted, and allows a $0.01 rounding tolerance", () => {
    expect(MandateInputSchema.parse({ ...DEMO_INPUT, budget_total: undefined }).budget_total).toBe(200);
    expect(MandateInputSchema.parse({ ...DEMO_INPUT, budget_total: 200.01 }).budget_total).toBe(200);
  });

  it("rejects a total that differs from the sum of the envelopes", () => {
    expect(issues({ ...DEMO_INPUT, budget_total: 190 })).toEqual(["budget_total: must equal the sum of the envelopes ($200.00), got $190.00"]);
  });

  it("rejects duplicate names (case-insensitive), empty envelopes, long interests and more than 12 people", () => {
    expect(issues({ ...DEMO_INPUT, budget_total: undefined, recipients: [...DEMO_RECIPIENTS, { name: "mom", envelope: 5 }] })[0]).toMatch(/recipients\.5\.name: "mom" is on the list twice/);
    expect(issues({ ...DEMO_INPUT, budget_total: undefined, recipients: [{ name: "Mom", envelope: 0 }] })[0]).toMatch(/recipients\.0\.envelope/);
    expect(issues({ ...DEMO_INPUT, budget_total: undefined, recipients: [{ name: "Mom", envelope: 5, interests: "x".repeat(121) }] })[0]).toMatch(/recipients\.0\.interests/);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ name: `P${i}`, envelope: 1 }));
    expect(issues({ ...DEMO_INPUT, budget_total: undefined, recipients: thirteen })[0]).toMatch(/at most 12 people/);
  });

  it("still requires budget_total for a legacy mandate without recipients", () => {
    expect(issues({ ...DEMO_INPUT, budget_total: undefined, recipients: [] })).toEqual(["budget_total: is required"]);
  });

  it("caps expiry at the PayPal authorization validity (29 days)", () => {
    const s = createSession();
    const m = createMandate(s, { ...DEMO_INPUT, expires_at: new Date(Date.now() + 90 * 864e5).toISOString() });
    const days = (Date.parse(m.expires_at) - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(PAYPAL_HOLD_DAYS - 0.01);
    expect(days).toBeLessThanOrEqual(PAYPAL_HOLD_DAYS);
    const soon = createMandate(createSession(), { ...DEMO_INPUT, expires_at: "2026-12-01T00:00:00Z" });
    expect(Date.parse(soon.expires_at)).toBeLessThanOrEqual(Date.parse("2026-12-01T00:00:00Z"));
  });

  it("keeps client-sent recipient ids (web editor rcp_xxxxxxxx) and replaces missing, malformed or repeated ones", () => {
    const s = createSession();
    const m = createMandate(s, {
      ...DEMO_INPUT,
      budget_total: undefined,
      recipients: [
        { id: "rcp_aB3x9_Q-", name: "Mom", envelope: 60 },
        { id: "rcp_k2m8p0zq", name: "Dad", envelope: 50 },
        { id: "rcp_k2m8p0zq", name: "Leo", envelope: 30 }, // repeated
        { id: "rcp_bad id!", name: "Sam", envelope: 30 }, // malformed
        { name: "Office Secret Santa", envelope: 30 }, // missing
      ],
    });
    const ids = m.recipients.map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual(["rcp_aB3x9_Q-", "rcp_k2m8p0zq"]);
    expect(ids.slice(2).every((id) => /^rcp_[0-9a-f]{12}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(5);
    // The ids in the response are the ones purchases and statuses use later.
    expect(appState(s).recipients.map((r) => r.recipient.id)).toEqual(ids);
  });

  it("gives each recipient a rcp_ id and writes a gift-list ledger row", () => {
    const { s } = demo();
    expect(s.mandate!.recipients.every((r) => /^rcp_[0-9a-f]{12}$/.test(r.id))).toBe(true);
    expect(new Set(s.mandate!.recipients.map((r) => r.id)).size).toBe(5);
    expect(s.ledger[0].summary).toBe(
      'Gift list "Holiday gifts": $200.00 for 5 people (Mom $60.00, Dad $50.00, Leo $30.00, Sam $30.00, Office Secret Santa $30.00), ask over $45.00, blocked: electronics',
    );
  });
});

describe("buyGiftPlan", () => {
  it("buys the whole demo list in one call: allowed gifts charge, Mom's $52 gift waits for approval", async () => {
    const { s, id } = demo();
    const out = await buyGiftPlan(
      s,
      [
        { recipient_id: id.mom, product_id: "cat_raised_bed", rationale: "Waist-high herbs for Mom." },
        { recipient_id: id.dad, product_id: "cat_coffee_grinder", rationale: "Burr grinder for a coffee nerd." },
        { recipient_id: id.leo, product_id: "cat_dino_dig", rationale: "Dinosaur dig." },
        { recipient_id: id.sam, product_id: "cat_soccer_ball", rationale: "Size 4 ball." },
        { recipient_id: id.office, product_id: "cat_desk_organizer", rationale: "Tidy desk." },
      ],
      BASE,
    );
    expect(out.results.map((r) => [r.recipient_name, r.purchase?.status, r.error])).toEqual([
      ["Mom", "pending_approval", null],
      ["Dad", "charged", null],
      ["Leo", "charged", null],
      ["Sam", "charged", null],
      ["Office Secret Santa", "charged", null],
    ]);
    expect(out.remaining).toBe(200 - 39 - 24 - 22 - 28);
    expect(out.recipients.map((r) => [r.recipient.name, r.state, r.spent, r.remaining])).toEqual([
      ["Mom", "waiting_approval", 0, 60],
      ["Dad", "bought", 39, 11],
      ["Leo", "bought", 24, 6],
      ["Sam", "bought", 22, 8],
      ["Office Secret Santa", "bought", 28, 2],
    ]);
    for (const r of out.recipients) expect(r.spent).toBeLessThanOrEqual(r.recipient.envelope);

    // Approving Mom's gift charges it.
    const mom = out.results[0].purchase!;
    const approved = await approvePurchase(s, mom.id, BASE);
    expect(approved.status).toBe("charged");
    expect(recipientStatuses(s)[0]).toMatchObject({ state: "bought", spent: 52, remaining: 8 });
    expect(appState(s).recipients).toEqual(recipientStatuses(s));
  });

  it("denies a duplicate gift, an over-envelope gift and an unknown person, in order", async () => {
    const { s, id } = demo();
    const out = await buyGiftPlan(
      s,
      [
        { recipient_id: id.leo, product_id: "cat_dino_dig", rationale: "a" },
        { recipient_id: id.sam, product_id: "cat_dino_dig", rationale: "b" },
        { recipient_id: id.sam, product_id: "cat_tool_set", rationale: "c" },
        { recipient_id: "rcp_nobody", product_id: "cat_soccer_ball", rationale: "d" },
      ],
      BASE,
    );
    const [leo, dup, over, nobody] = out.results;
    expect(leo.purchase!.status).toBe("charged");
    expect(dup.purchase!.reasons).toEqual(["Dinosaur Fossil Dig Kit is already bought for someone on the list; no duplicate gifts."]);
    expect(over.purchase!.reasons).toEqual(["$42.50 for Sam exceeds Sam's envelope: $30.00 left of $30.00."]);
    expect(nobody).toMatchObject({ recipient_id: "rcp_nobody", recipient_name: "rcp_nobody", error: null });
    expect(nobody.purchase!.status).toBe("blocked");
    expect(nobody.purchase!.reasons[0]).toMatch(/"rcp_nobody" is not on the gift list \(Mom = rcp_/);
    expect(s.mandate!.spent).toBe(24);
  });

  it("accepts a person's name when the model passes it instead of the id", async () => {
    const { s, id } = demo();
    const out = await buyGiftPlan(s, [{ recipient_id: "sam", product_id: "cat_soccer_ball", rationale: "x" }], BASE);
    expect(out.results[0]).toMatchObject({ recipient_id: id.sam, recipient_name: "Sam" });
    expect(out.results[0].purchase!.recipient_id).toBe(id.sam);
  });

  it("returns an error per entry on a legacy mandate instead of buying", async () => {
    const s = createSession();
    createMandate(s, { ...DEMO_INPUT, recipients: [] });
    s.mandate!.status = "active";
    const out = await buyGiftPlan(s, [{ recipient_id: "rcp_x", product_id: "cat_herb_kit", rationale: "x" }], BASE);
    expect(out.results[0]).toMatchObject({ purchase: null, error: expect.stringMatching(/no people on it/) });
    expect(out.recipients).toEqual([]);
    expect(s.purchases).toHaveLength(0);
  });
});

describe("gift-list purchases", () => {
  it("denies a purchase without a recipient on a gift list", async () => {
    const { s } = demo();
    const p = await proposePurchase(s, [{ product_id: "cat_herb_kit", qty: 1 }], "x", BASE);
    expect(p.status).toBe("blocked");
    expect(p.recipient_id).toBeNull();
    expect(p.reasons).toEqual(["Pick who this gift is for: every purchase must name someone on the list."]);
  });

  it("re-checks the envelope when a pending gift is approved", async () => {
    const { s, id } = demo();
    const big = await proposePurchase(s, [{ product_id: "cat_raised_bed", qty: 1 }], "x", BASE, "agent", id.mom); // $52, waits
    expect(big.status).toBe("pending_approval");
    const small = await proposePurchase(s, [{ product_id: "cat_gloves", qty: 1 }], "x", BASE, "agent", id.mom); // $19.95, charged
    expect(small.status).toBe("charged");
    const after = await approvePurchase(s, big.id, BASE);
    expect(after.status).toBe("blocked");
    expect(after.reasons.at(-1)).toBe("$52.00 for Mom exceeds Mom's envelope: $40.05 left of $60.00.");
    expect(recipientStatuses(s)[0]).toMatchObject({ state: "bought", spent: 19.95, purchase_ids: [small.id, big.id] });
  });

  it("does not count a pending gift as a duplicate of itself on approval", async () => {
    const { s, id } = demo();
    const p = await proposePurchase(s, [{ product_id: "cat_garden_tote", qty: 1 }], "x", BASE, "agent", id.mom);
    expect((await approvePurchase(s, p.id, BASE)).status).toBe("charged");
  });

  it("a refund frees the person's envelope and the gift can be bought again", async () => {
    const { s, id } = demo();
    const p = await proposePurchase(s, [{ product_id: "cat_soccer_goals", qty: 1 }], "x", BASE, "agent", id.sam);
    expect(recipientStatuses(s)[3]).toMatchObject({ state: "bought", spent: 29, remaining: 1 });
    await refundPurchase(s, p.id, "Sam has one", "user");
    expect(recipientStatuses(s)[3]).toMatchObject({ state: "to_buy", spent: 0, remaining: 30 });
    expect(s.ledger.at(-1)!.summary).toBe("MOCK refund $29.00 for 1 x Pop-Up Soccer Goal Set (2) for Sam; Sam's envelope and the budget restored");
    expect(s.ledger.at(-1)!.recipient_id).toBe(id.sam);
    const again = await proposePurchase(s, [{ product_id: "cat_soccer_goals", qty: 1 }], "x", BASE, "agent", id.sam);
    expect(again.status).toBe("charged");
  });

  it("refunds a legacy purchase with no recipient", async () => {
    const s = createSession();
    createMandate(s, { ...DEMO_INPUT, recipients: [] });
    s.mandate!.status = "active";
    const p = await proposePurchase(s, [{ product_id: "cat_herb_kit", qty: 1 }], "x", BASE, "agent", "rcp_ignored");
    expect(p).toMatchObject({ status: "charged", recipient_id: null });
    const r = await refundPurchase(s, p.id, "", "user");
    expect(r.status).toBe("refunded");
    expect(s.ledger.at(-1)!).toMatchObject({ recipient_id: null, summary: expect.stringMatching(/; budget restored$/) });
  });

  it("tags every ledger row about a purchase with its recipient", async () => {
    const { s, id } = demo();
    const before = s.ledger.length;
    await proposePurchase(s, [{ product_id: "cat_dino_book", qty: 1 }], "x", BASE, "agent", id.leo);
    const rows = s.ledger.slice(before);
    expect(rows.map((r) => r.action)).toEqual(["purchase.proposed", "policy.allow", "paypal.capture"]);
    expect(rows.every((r) => r.recipient_id === id.leo)).toBe(true);
    expect(rows[0].summary).toContain("a gift for Leo");
    expect(rows[2].summary).toMatch(/for 1 x The Big Book of Dinosaurs \(hardcover\) for Leo$/);
  });

  it("revoke on the mock rail says voided and rejects pending gifts", async () => {
    const { s, id } = demo();
    s.mandate!.paypal.authorization_id = "MOCK-AUTH0000000"; // what finalize would have stored
    const p = await proposePurchase(s, [{ product_id: "cat_raised_bed", qty: 1 }], "x", BASE, "agent", id.mom);
    await revokeMandate(s, s.mandate!.id);
    expect(p.status).toBe("rejected");
    expect(s.ledger.map((r) => r.summary)).toContain("MOCK authorization voided");
    expect(s.ledger.at(-1)!.summary).toBe('Gift list "Holiday gifts" revoked; the agent has no spending power');
  });
});

describe("agent tools: search_gifts, buy_gift_plan, get_mandate", () => {
  const opts = { toolCallId: "call_1", messages: [], context: undefined } as never;

  it("search_gifts runs one search per person, caps at the envelope left, and shows the injection listing once (for Mom)", async () => {
    const { s, id } = demo();
    const tools = buildTools({ session: s, baseUrl: BASE });
    const out = (await tools.search_gifts.execute!(
      {
        searches: [
          { recipient_id: id.mom, query: "gardening gift" },
          { recipient_id: id.dad, query: "coffee gift" },
          { recipient_id: id.leo, query: "dinosaur toy" },
          { recipient_id: id.sam, query: "soccer gear", max_price: 100 },
          { recipient_id: id.office, query: "desk accessory" },
        ],
      },
      opts,
    )) as SearchGiftsOutput;
    expect(out.source).toBe("catalog");
    expect(out.results.map((r) => r.recipient_name)).toEqual(["Mom", "Dad", "Leo", "Sam", "Office Secret Santa"]);
    const envelopes = [60, 50, 30, 30, 30];
    out.results.forEach((r, i) => {
      expect(r.products.length).toBeGreaterThanOrEqual(3);
      expect(r.products.every((p) => p.price <= envelopes[i])).toBe(true);
    });
    const withInjection = out.results.filter((r) => r.products.some((p) => p.id === "cat_injection_seedbox"));
    expect(withInjection.map((r) => r.recipient_name)).toEqual(["Mom"]);
    expect(out.results[0].products.some((p) => p.price > 45)).toBe(true); // an ask-me option for Mom
    const searches = s.ledger.filter((r) => r.action === "search");
    expect(searches).toHaveLength(5);
    expect(searches[0]).toMatchObject({ recipient_id: id.mom, summary: expect.stringContaining('"gardening gift" for Mom') });
  });

  it("buy_gift_plan returns BuyGiftPlanOutput and get_mandate returns recipient statuses", async () => {
    const { s, id } = demo();
    const tools = buildTools({ session: s, baseUrl: BASE });
    const out = await tools.buy_gift_plan.execute!({ plan: [{ recipient_id: id.leo, product_id: "cat_dino_puzzle", rationale: "glows" }] }, opts);
    expect(out).toMatchObject({ remaining: 182, results: [{ recipient_name: "Leo", purchase: { status: "charged", total: 18 } }] });
    const m = (await tools.get_mandate.execute!({}, opts)) as GetMandateOutput;
    expect(m.recipients.map((r) => r.state)).toEqual(["to_buy", "to_buy", "bought", "to_buy", "to_buy"]);
  });

  it("propose_purchase passes recipient_id through", async () => {
    const { s, id } = demo();
    const tools = buildTools({ session: s, baseUrl: BASE });
    const out = (await tools.propose_purchase.execute!({ items: [{ product_id: "cat_shin_guards", qty: 1 }], rationale: "x", recipient_id: id.sam }, opts)) as ProposePurchaseOutput;
    expect(out.purchase).toMatchObject({ status: "charged", recipient_id: id.sam });
  });
});
