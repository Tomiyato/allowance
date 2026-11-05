// Gift-list helpers shared by pages, cards and fixture mode.
import type { AppState, Mandate, Purchase, Recipient, RecipientState, RecipientStatus } from "../../shared/types";

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sum of the envelopes: the gift list's total (spec decision 1). */
export function envelopeTotal(recipients: Recipient[]): number {
  return round2(recipients.reduce((s, r) => s + (Number.isFinite(r.envelope) ? r.envelope : 0), 0));
}

/** Envelope accounting, derived from purchases (spec decision 6). Mirrors the server's recipientStatuses. */
export function recipientStatuses(m: Mandate | null, purchases: Purchase[]): RecipientStatus[] {
  if (!m || m.recipients.length === 0) return [];
  return m.recipients.map((recipient) => {
    const mine = purchases
      .filter((p) => p.mandate_id === m.id && p.recipient_id === recipient.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const spent = round2(mine.filter((p) => p.status === "charged").reduce((s, p) => s + p.total, 0));
    const state: RecipientState = mine.some((p) => p.status === "charged")
      ? "bought"
      : mine.some((p) => p.status === "pending_approval")
        ? "waiting_approval"
        : "to_buy";
    return { recipient, spent, remaining: round2(recipient.envelope - spent), state, purchase_ids: mine.map((p) => p.id) };
  });
}

export function recipientName(state: AppState | null, id: string | null | undefined): string | null {
  if (!id) return null;
  return state?.mandate?.recipients.find((r) => r.id === id)?.name ?? null;
}

export const stateLabel: Record<RecipientState, string> = {
  bought: "Bought",
  waiting_approval: "Waiting for your OK",
  to_buy: "To buy",
};

/** The purchase that best describes a person's gift: newest charged, else newest pending, else newest attempt. */
export function giftPurchase(status: RecipientStatus, purchases: Purchase[]): Purchase | null {
  const mine = status.purchase_ids.map((id) => purchases.find((p) => p.id === id)).filter((p): p is Purchase => !!p);
  return mine.find((p) => p.status === "charged") ?? mine.find((p) => p.status === "pending_approval") ?? mine[0] ?? null;
}

export const giftTitle = (p: Purchase) => p.items.map((i) => (i.qty > 1 ? `${i.qty} × ${i.title}` : i.title)).join(", ");

/** PayPal holds an authorization for up to 29 days (spec decision 4). */
export const MAX_HOLD_DAYS = 29;

export function maxExpiryIso(): string {
  const d = new Date(Date.now() + MAX_HOLD_DAYS * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T23:59:59Z`;
}

export function newRecipientId(): string {
  return `rcp_${Math.random().toString(36).slice(2, 10)}`;
}
