// Read-only tools from the official PayPal Agent Toolkit (@paypal/agent-toolkit/ai-sdk).
//
// Safety: two layers keep money-moving toolkit tools away from the model.
//   1. The toolkit is configured with only the read actions in TOOLKIT_ACTIONS.
//   2. selectReadOnly() drops anything the toolkit returns that is not in PAYPAL_TOOLKIT_ALLOWLIST
//      (so a toolkit upgrade that maps a new tool to one of those actions still cannot reach the model).
// Each lookup is further scoped to the PayPal ids of the caller's own gift list.
//
// Why wrapped: toolkit 1.11.0 builds its tools with its bundled `ai@4` (`{ parameters, execute }`).
// AI SDK v7 reads `inputSchema`, so passing getTools() straight to streamText gives the model an empty
// schema. We re-declare each allowlisted toolkit tool with v7 `tool()`, reusing the toolkit's own
// description, its zod schema (v7 reads it via Standard Schema) and its execute (the toolkit's PayPal call).
import { tool, type FlexibleSchema, type ToolSet } from "ai";
import type { PayPalCheckOutput, PayPalRecord, PayPalToolkitToolName, Purchase } from "../../shared/types.ts";
import { config } from "../config.ts";
import { findRecipient } from "../service.ts";
import type { Session } from "../store.ts";

/** The only toolkit tools the agent may ever see. All read-only GETs. */
export const PAYPAL_TOOLKIT_ALLOWLIST = [
  "get_order",
  "get_refund",
  "get_shipment_tracking",
] as const satisfies readonly PayPalToolkitToolName[];

/**
 * Toolkit actions enabled in its configuration: orders.get -> get_order, payments.getRefunds -> get_refund,
 * shipment.get -> get_shipment_tracking. transactions.list (list_transactions, Transaction Search) is left
 * out: the sandbox app returns 403 until "Transaction search" is enabled for it in the developer dashboard.
 */
export const TOOLKIT_ACTIONS = {
  orders: { get: true },
  payments: { getRefunds: true },
  shipment: { get: true },
} as const;

/** The shape of a toolkit tool as built by its bundled ai@4 `tool()`. */
export interface RawToolkitTool {
  description?: string;
  parameters: unknown;
  execute?: (args: any, options?: any) => Promise<unknown>;
}
export type RawToolkitTools = Record<string, RawToolkitTool>;

const ALLOWED = new Set<string>(PAYPAL_TOOLKIT_ALLOWLIST);
const isAllowed = (name: string): name is PayPalToolkitToolName => ALLOWED.has(name);

/** Keep only allowlisted toolkit tools; anything else is dropped and logged once. */
export function selectReadOnly(raw: Record<string, unknown>): Partial<Record<PayPalToolkitToolName, RawToolkitTool>> {
  const out: Partial<Record<PayPalToolkitToolName, RawToolkitTool>> = {};
  const dropped: string[] = [];
  for (const [name, t] of Object.entries(raw)) {
    if (isAllowed(name)) out[name] = t as RawToolkitTool;
    else dropped.push(name);
  }
  if (dropped.length && !warnedDropped) {
    warnedDropped = true;
    console.warn(`[paypal-toolkit] dropped non-allowlisted toolkit tools: ${dropped.join(", ")}`);
  }
  return out;
}
let warnedDropped = false;

// ------------------------------------------------------------------ loading (lazy, cached)

/** Real PayPal ids exist only on a PayPal rail with credentials. */
export function toolkitEnabled(): boolean {
  return config.paymentMode !== "mock" && Boolean(config.paypalClientId && config.paypalClientSecret);
}

/** The toolkit caches its OAuth token with no expiry; rebuild well inside the token lifetime. */
const TOOLKIT_TTL_MS = 30 * 60 * 1000;
let cached: { tools: Partial<Record<PayPalToolkitToolName, RawToolkitTool>>; at: number } | null = null;
let loading: Promise<Partial<Record<PayPalToolkitToolName, RawToolkitTool>>> | null = null;
let loadFailed = false;

async function construct() {
  // Lazy: the toolkit bundle (mathjs, paypal-server-sdk, its own ai@4) takes ~1.5 s to import.
  const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/ai-sdk");
  const toolkit = new PayPalAgentToolkit({
    clientId: config.paypalClientId!,
    clientSecret: config.paypalClientSecret!,
    configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: config.paypalEnv !== "live" } },
  });
  return selectReadOnly(toolkit.getTools());
}

/** The allowlisted toolkit tools, or null when the toolkit is off or failed to load (the agent works without them). */
export async function loadPayPalToolkit(): Promise<Partial<Record<PayPalToolkitToolName, RawToolkitTool>> | null> {
  if (!toolkitEnabled() || loadFailed) return null;
  if (cached && Date.now() - cached.at < TOOLKIT_TTL_MS) return cached.tools;
  loading ??= construct()
    .then((tools) => {
      cached = { tools, at: Date.now() };
      return tools;
    })
    .finally(() => {
      loading = null;
    });
  try {
    return await loading;
  } catch (e) {
    loadFailed = true;
    console.error("[paypal-toolkit] could not load @paypal/agent-toolkit; PayPal lookups are off:", (e as Error).message);
    return null;
  }
}

/** Forget the toolkit instance (and its token) so the next turn builds a fresh one. */
function resetToolkit() {
  cached = null;
}

// ------------------------------------------------------------------ scope and summaries

/** Every PayPal id that belongs to this session's gift list. */
export function sessionPayPalIds(s: Session): Set<string> {
  const ids = new Set<string>();
  const add = (v: string | null | undefined) => v && ids.add(v);
  add(s.mandate?.paypal.order_id);
  add(s.mandate?.paypal.authorization_id);
  for (const p of s.purchases) {
    if (s.mandate && p.mandate_id !== s.mandate.id) continue;
    add(p.paypal.order_id);
    add(p.paypal.capture_id);
    add(p.paypal.refund_id);
  }
  return ids;
}

const amountOf = (a: any) => {
  const n = Number(a?.value);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** The capture id a refund's "up" link points at. */
const upCaptureId = (links: unknown) =>
  (Array.isArray(links) ? links : [])
    .map((l: any) => /\/captures\/([^/?]+)/.exec(String(l?.rel === "up" ? l.href : ""))?.[1])
    .find(Boolean) ?? null;

function purchaseIndex(s: Session) {
  const byId = new Map<string, Purchase>();
  for (const p of s.purchases) {
    byId.set(p.id, p);
    if (p.paypal.capture_id) byId.set(p.paypal.capture_id, p);
    if (p.paypal.refund_id) byId.set(p.paypal.refund_id, p);
  }
  return byId;
}

/** Turn PayPal's raw JSON into compact records, labelled with the Ribbon purchase and person they belong to. */
export function summarize(toolName: PayPalToolkitToolName, data: any, s: Session): PayPalRecord[] {
  const index = purchaseIndex(s);
  const record = (r: Omit<PayPalRecord, "purchase_id" | "recipient_id" | "recipient_name" | "gift">, ...keys: (string | null)[]): PayPalRecord => {
    // Ribbon sets invoice_id = purchase id on captures and `${purchase id}-r` on refunds.
    const p = keys.map((k) => (k ? index.get(k.replace(/-r$/, "")) : undefined)).find(Boolean) ?? null;
    const who = p ? findRecipient(s.mandate, p.recipient_id) : null;
    return {
      ...r,
      purchase_id: p?.id ?? null,
      recipient_id: who?.id ?? null,
      recipient_name: who?.name ?? null,
      gift: p ? p.items.map((i) => i.title).join(" + ") : null,
    };
  };

  if (toolName === "get_order") {
    const units: any[] = Array.isArray(data?.purchase_units) ? data.purchase_units : [];
    const total = units.reduce((sum, u) => sum + (amountOf(u?.amount) ?? 0), 0);
    const out: PayPalRecord[] = [
      record({
        kind: "order",
        id: String(data?.id ?? ""),
        status: String(data?.status ?? "UNKNOWN"),
        amount: units.length ? Math.round(total * 100) / 100 : null,
        currency: str(units[0]?.amount?.currency_code),
        time: str(data?.update_time) ?? str(data?.create_time),
        note: data?.intent ? `intent ${data.intent}` : null,
      }),
    ];
    for (const u of units) {
      const pay = u?.payments ?? {};
      for (const a of pay.authorizations ?? [])
        out.push(record({ kind: "authorization", id: a.id, status: a.status, amount: amountOf(a.amount), currency: str(a.amount?.currency_code), time: str(a.create_time), note: a.expiration_time ? `hold valid until ${String(a.expiration_time).slice(0, 10)}` : null }));
      for (const c of pay.captures ?? [])
        out.push(record({ kind: "capture", id: c.id, status: c.status, amount: amountOf(c.amount), currency: str(c.amount?.currency_code), time: str(c.create_time), note: c.final_capture ? "final capture" : null }, str(c.invoice_id), c.id));
      for (const r of pay.refunds ?? []) {
        const cap = upCaptureId(r.links);
        out.push(record({ kind: "refund", id: r.id, status: r.status, amount: amountOf(r.amount), currency: str(r.amount?.currency_code), time: str(r.create_time), note: cap ? `refund of capture ${cap}` : null }, str(r.invoice_id), r.id, cap));
      }
      // Orders v2 tracker ids are `{capture_id}-{tracking_number}`.
      for (const t of u?.shipping?.trackers ?? []) {
        const [capId, ...rest] = String(t.id ?? "").split("-");
        out.push(record({ kind: "tracker", id: String(t.id ?? ""), status: String(t.status ?? "UNKNOWN"), amount: null, currency: null, time: str(t.update_time) ?? str(t.create_time), note: rest.length ? `tracking ${rest.join("-")}` : null }, capId || null));
      }
    }
    return out;
  }

  if (toolName === "get_refund") {
    const cap = upCaptureId(data?.links);
    return [
      record(
        { kind: "refund", id: String(data?.id ?? ""), status: String(data?.status ?? "UNKNOWN"), amount: amountOf(data?.amount), currency: str(data?.amount?.currency_code), time: str(data?.create_time), note: [cap ? `refund of capture ${cap}` : null, str(data?.note_to_payer)].filter(Boolean).join("; ") || null },
        str(data?.invoice_id),
        str(data?.id),
        cap,
      ),
    ];
  }

  // get_shipment_tracking: GET /v1/shipping/trackers?transaction_id=… returns { trackers: [...] }.
  const trackers: any[] = Array.isArray(data?.trackers) ? data.trackers : Array.isArray(data) ? data : data?.tracking_number ? [data] : [];
  return trackers.map((t) => {
    const carrier = t.carrier === "OTHER" ? (str(t.carrier_name_other) ?? "OTHER") : str(t.carrier);
    return record(
      { kind: "tracker", id: String(t.tracking_number ?? t.id ?? ""), status: String(t.status ?? "UNKNOWN"), amount: null, currency: null, time: isoTime(t.last_updated_time) ?? isoTime(t.create_time), note: [carrier, t.transaction_id ? `capture ${t.transaction_id}` : null].filter(Boolean).join(", ") || null },
      str(t.transaction_id),
    );
  });
}

/** v1 trackers report times as epoch-millisecond strings; everything else is ISO already. */
function isoTime(v: unknown): string | null {
  if (typeof v === "number" || (typeof v === "string" && /^\d{10,13}$/.test(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return str(v);
}

/** The toolkit's run() returns JSON text: the PayPal resource, or { ok:false, status, message } / { error: { message } }. */
function parseToolkitResult(raw: unknown): { data: any; error: string | null; status: number | null } {
  let data: any = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return { data: null, error: raw.slice(0, 300), status: null };
    }
  }
  if (data && typeof data === "object" && (data.ok === false || data.error)) {
    const msg = data.message ?? data.error?.message ?? "PayPal returned an error";
    const status = typeof data.status === "number" ? data.status : null;
    return { data: null, error: `${status ? `PayPal ${status}: ` : ""}${String(msg).slice(0, 300)}`, status };
  }
  return { data, error: null, status: null };
}

function lookupIdOf(toolName: PayPalToolkitToolName, input: any): string {
  if (toolName === "get_order") return String(input?.id ?? "");
  if (toolName === "get_refund") return String(input?.refund_id ?? "");
  return String(input?.transaction_id ?? input?.order_id ?? "");
}

const SCOPE_NOTE =
  "Read-only: this looks up PayPal's own records through the official PayPal Agent Toolkit; it never moves money. " +
  "Only ids from this gift list are allowed (the list's PayPal order id, or a purchase's PayPal capture or refund id from list_purchases).";

const EXTRA: Record<PayPalToolkitToolName, string> = {
  get_order:
    "On a gift list, the list's one PayPal order holds the authorization and every gift's capture and refund, so one call shows what PayPal recorded for everyone.",
  get_refund: "Use the purchase's PayPal refund id (paypal_refund_id in list_purchases).",
  get_shipment_tracking: "Pass the gift's PayPal capture id as transaction_id.",
};

/** v7 tools for the allowlisted toolkit tools, scoped to this session's PayPal ids. */
export function buildPayPalToolkitTools(
  s: Session,
  raw: Partial<Record<PayPalToolkitToolName, RawToolkitTool>> | null | undefined,
): ToolSet {
  const tools: ToolSet = {};
  if (!raw) return tools;
  for (const [name, t] of Object.entries(selectReadOnly(raw)) as [PayPalToolkitToolName, RawToolkitTool][]) {
    if (!t?.execute) continue;
    const exec = t.execute;
    tools[name] = tool({
      description: `${SCOPE_NOTE}\n${(t.description ?? "").trim()}\n${EXTRA[name]}`,
      // The toolkit's own zod (v3) schema; AI SDK v7 reads it through Standard Schema.
      inputSchema: t.parameters as FlexibleSchema<Record<string, unknown>>,
      execute: async (input): Promise<PayPalCheckOutput> => {
        const lookup_id = lookupIdOf(name, input);
        const base = { source: "paypal_agent_toolkit" as const, tool: name, lookup_id };
        const own = sessionPayPalIds(s);
        const asked = [input?.id, input?.refund_id, input?.transaction_id, input?.order_id].filter((v): v is string => typeof v === "string" && !!v);
        const foreign = asked.find((id) => !own.has(id));
        if (!asked.length || foreign) {
          return { ...base, ok: false, records: [], error: `${foreign ?? "That id"} is not a PayPal id from this gift list. Ribbon only looks up its own PayPal records.` };
        }
        if (name === "get_shipment_tracking" && !input?.transaction_id && s.mandate?.paypal.order_id === input?.order_id) {
          return { ...base, ok: false, records: [], error: "The gift list's order holds every gift; pass that gift's PayPal capture id as transaction_id." };
        }
        try {
          const { data, error, status } = parseToolkitResult(await exec(input));
          if (status === 401) resetToolkit();
          if (error) return { ...base, ok: false, records: [], error };
          return { ...base, ok: true, records: summarize(name, data, s), error: null };
        } catch (e) {
          return { ...base, ok: false, records: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
        }
      },
      toModelOutput: ({ output }) => ({
        type: "json",
        value: {
          source: "PayPal's own records via the PayPal Agent Toolkit (read-only)",
          lookup_id: output.lookup_id,
          ...(output.error ? { error: output.error } : {}),
          records: output.records.map((r) =>
            Object.fromEntries(
              Object.entries({ kind: r.kind, id: r.id, status: r.status, amount: r.amount, for: r.recipient_name, gift: r.gift, purchase_id: r.purchase_id, note: r.note, time: r.time }).filter(([, v]) => v != null),
            ),
          ),
        },
      }),
    });
  }
  return tools;
}
