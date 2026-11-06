import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { AppState, PayPalCheckOutput, PayPalRecord, Purchase, RequestRefundOutput, SearchProductsOutput } from "../../shared/types";
import { api, fixtureSnapshot } from "./api";
import { fixtureGiftOptions, fixturePurchases, fixtureProducts, giftSearchOutput } from "./fixtures";
import { money } from "./format";

interface Turn {
  tool: { name: string; input: unknown; output: unknown } | null;
  reply: string;
}

const VACUUM = fixturePurchases.find((p) => p.items[0]?.product_id === "prd_robovac")!;

/** The person named in the prompt, if any ("Return Sam's gift" -> Sam). */
function personIn(prompt: string, s: AppState) {
  const lower = prompt.toLowerCase();
  return s.mandate?.recipients.find((r) => lower.includes(r.name.toLowerCase())) ?? null;
}

/** What get_order (PayPal Agent Toolkit) would return for the fixture list's one PayPal order. */
function fixtureOrderCheck(s: AppState): PayPalCheckOutput | null {
  const m = s.mandate;
  if (!m?.paypal.order_id) return null;
  const who = (p: Purchase) => m.recipients.find((r) => r.id === p.recipient_id) ?? null;
  const rec = (r: Partial<PayPalRecord> & Pick<PayPalRecord, "kind" | "id" | "status">, p: Purchase | null = null): PayPalRecord => ({
    amount: null,
    currency: "USD",
    time: p?.created_at ?? m.created_at,
    note: null,
    purchase_id: p?.id ?? null,
    recipient_id: p ? (who(p)?.id ?? null) : null,
    recipient_name: p ? (who(p)?.name ?? null) : null,
    gift: p ? p.items.map((i) => i.title).join(" + ") : null,
    ...r,
  });
  const paid = s.purchases.filter((p) => p.paypal.capture_id && (p.status === "charged" || p.status === "refunded"));
  const captured = paid.reduce((sum, p) => sum + p.total, 0);
  const records: PayPalRecord[] = [
    rec({ kind: "order", id: m.paypal.order_id, status: "COMPLETED", amount: m.budget_total, note: "intent AUTHORIZE" }),
    ...(m.paypal.authorization_id
      ? [rec({ kind: "authorization", id: m.paypal.authorization_id, status: captured > 0 ? "PARTIALLY_CAPTURED" : "CREATED", amount: m.budget_total })]
      : []),
    ...paid.map((p) => rec({ kind: "capture", id: p.paypal.capture_id!, status: p.status === "refunded" ? "REFUNDED" : "COMPLETED", amount: p.total }, p)),
    ...paid
      .filter((p) => p.paypal.refund_id)
      .map((p) => rec({ kind: "refund", id: p.paypal.refund_id!, status: "COMPLETED", amount: p.total, note: `refund of capture ${p.paypal.capture_id}` }, p)),
  ];
  return { source: "paypal_agent_toolkit", tool: "get_order", lookup_id: m.paypal.order_id, ok: true, error: null, records };
}

/** Picks a canned turn for the prompt; the refund turn really refunds in the fixture store. */
async function planTurn(prompt: string): Promise<Turn> {
  const s = fixtureSnapshot();
  const person = personIn(prompt, s);

  // "What did PayPal record for Mom?" / "Did PayPal really refund Sam?": a read-only lookup, checked before
  // the refund turn so that asking about a refund never issues one.
  const check = /paypal/i.test(prompt) && /record|really|according|check|confirm|say/i.test(prompt) ? fixtureOrderCheck(s) : null;
  if (check) {
    const mine = check.records.filter((r) => person && r.recipient_id === person.id && (r.kind === "capture" || r.kind === "refund"));
    const lines = mine.map((r) => `${r.kind === "refund" ? "a refund" : "a capture"} of ${money(r.amount ?? 0)} (${r.status.toLowerCase()}, ${r.id})`);
    return {
      tool: { name: "get_order", input: { id: check.lookup_id }, output: check },
      reply: person
        ? lines.length
          ? `Fixture mode: PayPal's record for ${person.name} shows ${lines.join(" and ")} on your list's one PayPal order. With the backend running, this comes live from PayPal through the read-only Agent Toolkit.`
          : `Fixture mode: PayPal has no payment for ${person.name} on your list's order yet.`
        : "Fixture mode: here is what PayPal recorded on your list's one order. With the backend running, this comes live from PayPal through the read-only Agent Toolkit.",
    };
  }

  if (/return|refund/i.test(prompt)) {
    const charged = s.purchases
      .filter((p) => p.status === "charged" && (!person || p.recipient_id === person.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!charged) return { tool: null, reply: `There is nothing bought${person ? ` for ${person.name}` : ""} to return.` };
    const out = await api.refundPurchase(charged.id);
    const after = fixtureSnapshot();
    const output: RequestRefundOutput = { purchase: out.purchase, remaining: after.remaining };
    const st = after.recipients.find((r) => r.recipient.id === charged.recipient_id);
    return {
      tool: { name: "request_refund", input: { purchase_id: charged.id, reason: "Return requested" }, output },
      reply: st
        ? `Refunded ${st.recipient.name}'s gift through PayPal. ${st.recipient.name}'s envelope is back to ${money(st.remaining)}, so I can pick something else.`
        : "Refunded through PayPal. Your budget went back up.",
    };
  }

  if (/vacuum/i.test(prompt)) {
    return {
      tool: { name: "propose_purchase", input: { items: [{ product_id: "prd_robovac", qty: 1 }], rationale: VACUUM.rationale }, output: { purchase: VACUUM, remaining: s.remaining } },
      reply: "Your gift list blocks electronics, and a vacuum is not for anyone on it, so I did not buy it. Nothing was charged.",
    };
  }

  if (/shop|whole|everyone|gift list/i.test(prompt) && s.recipients.length > 0) {
    const toBuy = s.recipients.filter((r) => r.state === "to_buy").map((r) => r.recipient);
    if (toBuy.length === 0) return { tool: null, reply: "Everyone on your list already has a gift bought or waiting for your OK." };
    const output = giftSearchOutput(toBuy);
    return {
      tool: { name: "search_gifts", input: { searches: output.results.map((r) => ({ recipient_id: r.recipient_id, query: r.query })) }, output },
      reply: `Fixture mode: here are options for the ${toBuy.length === 1 ? "person" : `${toBuy.length} people`} still to buy. With the backend running, I would pick one gift each inside the envelope and buy them in one plan.`,
    };
  }

  const products = (person && fixtureGiftOptions[person.id]?.products) || fixtureProducts;
  const output: SearchProductsOutput = { query: prompt, source: "catalog", products: products.slice(0, 3) };
  return {
    tool: { name: "search_products", input: { query: prompt }, output },
    reply: "Fixture mode: here is what a search looks like. With the backend running, I would compare these, check the envelope and buy the best fit.",
  };
}

/** Plays a canned agent turn (tool call with an in-progress state, then text) for ?fixture=1. */
export class FixtureChatTransport implements ChatTransport<UIMessage> {
  async sendMessages({ messages, abortSignal }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]) {
    const last = messages[messages.length - 1];
    const prompt = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim() || "something nice";
    const id = Math.random().toString(36).slice(2, 8);
    const turn = await planTurn(prompt);

    const toolChunks: Array<[number, UIMessageChunk]> = turn.tool
      ? [
          [0, { type: "start-step" }],
          [150, { type: "tool-input-start", toolCallId: `fx_${id}`, toolName: turn.tool.name }],
          [100, { type: "tool-input-available", toolCallId: `fx_${id}`, toolName: turn.tool.name, input: turn.tool.input }],
          [1400, { type: "tool-output-available", toolCallId: `fx_${id}`, output: turn.tool.output }],
          [0, { type: "finish-step" }],
        ]
      : [];
    const script: Array<[number, UIMessageChunk]> = [
      [0, { type: "start" }],
      ...toolChunks,
      [0, { type: "start-step" }],
      [200, { type: "text-start", id: `t_${id}` }],
      ...turn.reply.split(/(?<= )/).map((w): [number, UIMessageChunk] => [35, { type: "text-delta", id: `t_${id}`, delta: w }]),
      [0, { type: "text-end", id: `t_${id}` }],
      [0, { type: "finish-step" }],
      [0, { type: "finish" }],
    ];

    let i = 0;
    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        if (abortSignal?.aborted || i >= script.length) {
          controller.close();
          return;
        }
        const [wait, chunk] = script[i++];
        if (wait) await new Promise((r) => setTimeout(r, wait));
        controller.enqueue(chunk);
      },
    });
  }

  async reconnectToStream() {
    return null;
  }
}
