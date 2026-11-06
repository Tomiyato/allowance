// In-memory state per anonymous session, optionally persisted to a JSON file (SPEC §8).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppState, LedgerRow, Mandate, Product, Purchase, RecipientStatus } from "../shared/types.ts";
import { aiLabel, config } from "./config.ts";
import { remainingBudget, round2 } from "./policy.ts";

export interface Session {
  id: string;
  created_at: string;
  mandate: Mandate | null;
  purchases: Purchase[];
  ledger: LedgerRow[];
  /** Products the agent has seen in this session, by id. propose_purchase only accepts these,
   *  so prices and categories always come from the product source, never from the model. */
  products: Record<string, Product>;
  /** Product source actually used by the last search (after fallback). */
  last_source: "channel3" | "catalog" | null;
  /** provider:model that produced the last step of the most recent chat turn (after any fallback). */
  ai_active: string | null;
  /** PayPal webhook event ids already written to this session's ledger (idempotency; newest last, capped). */
  webhook_event_ids: string[];
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 500;

// ---------- persistence (best effort; Render free has no persistent disk, that is fine) ----------
const storePath = config.storeFile ? resolve(config.storeFile) : null;
let saveTimer: NodeJS.Timeout | null = null;
let persistenceBroken = false;

function load() {
  if (!storePath) return;
  try {
    const data = JSON.parse(readFileSync(storePath, "utf8")) as Session[];
    for (const s of data) sessions.set(s.id, upgrade(s));
    console.log(`[store] loaded ${sessions.size} session(s) from ${storePath}`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.warn(`[store] could not load ${storePath}: ${e?.message}`);
  }
}

/** Defaults for sessions persisted before a field existed (gift-list fields: recipients, recipient_id). */
function upgrade(s: Session): Session {
  return {
    ...s,
    mandate: s.mandate ? { ...s.mandate, recipients: s.mandate.recipients ?? [] } : null,
    purchases: (s.purchases ?? []).map((p) => ({ ...p, recipient_id: p.recipient_id ?? null, shipment: p.shipment ?? null })),
    ledger: (s.ledger ?? []).map((r) => ({ ...r, recipient_id: r.recipient_id ?? null })),
    products: s.products ?? {},
    last_source: s.last_source ?? null,
    ai_active: s.ai_active ?? null,
    webhook_event_ids: s.webhook_event_ids ?? [],
  };
}

function scheduleSave() {
  if (!storePath || persistenceBroken || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...sessions.values()]));
      renameSync(tmp, storePath);
    } catch (e: any) {
      persistenceBroken = true;
      console.warn(`[store] persistence disabled (${e?.message}); continuing in memory only`);
    }
  }, 250);
}

load();

// ---------- sessions ----------
export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function createSession(): Session {
  if (sessions.size >= MAX_SESSIONS) {
    // Drop the oldest session to bound memory.
    const oldest = [...sessions.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (oldest) sessions.delete(oldest.id);
  }
  const s: Session = {
    id: randomBytes(16).toString("hex"),
    created_at: new Date().toISOString(),
    mandate: null,
    purchases: [],
    ledger: [],
    products: {},
    last_source: null,
    ai_active: null,
    webhook_event_ids: [],
  };
  sessions.set(s.id, s);
  scheduleSave();
  return s;
}

/** Every session in memory (PayPal webhooks are not tied to a cookie, so they search all of them). */
export function allSessions(): IterableIterator<Session> {
  return sessions.values();
}

export function findSessionByMandate(mandateId: string): Session | undefined {
  for (const s of sessions.values()) if (s.mandate?.id === mandateId) return s;
  return undefined;
}

/** Call after any mutation of a session. */
export function touch(_s: Session) {
  scheduleSave();
}

// ---------- derived state ----------
export function remaining(s: Session): number {
  return s.mandate ? Math.max(0, remainingBudget(s.mandate)) : 0;
}

/** Recompute time- and budget-driven status transitions (active <-> exhausted, -> expired). */
export function refreshMandateStatus(s: Session, now = new Date()) {
  const m = s.mandate;
  if (!m) return;
  if ((m.status === "active" || m.status === "exhausted") && now.getTime() > Date.parse(m.expires_at)) {
    m.status = "expired";
    addLedger(s, { actor: "policy", action: "mandate.expired", summary: `Gift list "${m.title}" expired` });
    return;
  }
  if (m.status === "active" && remainingBudget(m) <= 0.004) {
    m.status = "exhausted";
    addLedger(s, { actor: "policy", action: "mandate.exhausted", summary: "Budget fully spent; the gift list is used up" });
  } else if (m.status === "exhausted" && remainingBudget(m) > 0.004) {
    m.status = "active";
    addLedger(s, { actor: "policy", action: "mandate.reactivated", summary: "Budget available again after a refund" });
  }
}

/** Purchases of the session's current mandate, in creation order. */
export function mandatePurchases(s: Session): Purchase[] {
  const mid = s.mandate?.id;
  return mid ? s.purchases.filter((p) => p.mandate_id === mid) : [];
}

/**
 * Gift list status per person, derived from purchases (GIFTLIST_SPEC decision 6): spent = charged
 * totals for that person, so a refund frees the envelope. [] without a mandate or recipients.
 */
export function recipientStatuses(s: Session): RecipientStatus[] {
  const m = s.mandate;
  if (!m || !m.recipients?.length) return [];
  const purchases = mandatePurchases(s);
  return m.recipients.map((r) => {
    const mine = purchases.filter((p) => p.recipient_id === r.id);
    const spent = round2(mine.filter((p) => p.status === "charged").reduce((sum, p) => sum + p.total, 0));
    const state = mine.some((p) => p.status === "charged")
      ? "bought"
      : mine.some((p) => p.status === "pending_approval")
        ? "waiting_approval"
        : "to_buy";
    return {
      recipient: r,
      spent,
      remaining: round2(r.envelope - spent),
      state,
      purchase_ids: mine.map((p) => p.id).reverse(),
    };
  });
}

export function appState(s: Session): AppState {
  refreshMandateStatus(s);
  return {
    mandate: s.mandate,
    remaining: remaining(s),
    purchases: mandatePurchases(s),
    ledger: s.ledger,
    mode: { payment: config.paymentMode, products: s.last_source ?? config.productSource, ai: aiLabel(), ai_active: s.ai_active },
    recipients: recipientStatuses(s),
  };
}

// ---------- ledger ----------
export type LedgerInput = Pick<LedgerRow, "actor" | "action" | "summary"> &
  Partial<Omit<LedgerRow, "id" | "ts" | "actor" | "action" | "summary">>;

export function addLedger(s: Session, row: LedgerInput): LedgerRow {
  const full: LedgerRow = {
    id: newId("led"),
    ts: new Date().toISOString(),
    actor: row.actor,
    action: row.action,
    summary: row.summary,
    amount: row.amount ?? null,
    decision: row.decision ?? null,
    reasons: row.reasons ?? null,
    paypal_id: row.paypal_id ?? null,
    purchase_id: row.purchase_id ?? null,
    remaining_budget: row.remaining_budget !== undefined ? row.remaining_budget : s.mandate ? remaining(s) : null,
    // Rows about a purchase inherit its recipient unless the caller says otherwise.
    recipient_id:
      row.recipient_id !== undefined
        ? row.recipient_id
        : row.purchase_id
          ? (s.purchases.find((p) => p.id === row.purchase_id)?.recipient_id ?? null)
          : null,
  };
  s.ledger.push(full);
  scheduleSave();
  return full;
}

// ---------- per-session mutex: policy check + charge must not interleave ----------
const locks = new Map<string, Promise<unknown>>();
export function withSessionLock<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(s.id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    s.id,
    next.catch(() => undefined),
  );
  return next;
}
