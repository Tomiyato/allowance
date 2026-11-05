// Contract shared by server/ and web/. Change only together with both sides.

export type MandateStatus = "draft" | "pending_paypal" | "active" | "revoked" | "expired" | "exhausted";
export type PaymentMode = "authorization" | "vault" | "per_purchase" | "mock";

export interface Mandate {
  id: string;
  title: string;
  currency: "USD";
  budget_total: number;
  per_purchase_approval_over: number;
  allowed_categories: string[];
  blocked_categories: string[];
  max_quantity_per_item: number;
  expires_at: string; // ISO
  status: MandateStatus;
  paypal: { mode: PaymentMode; authorization_id: string | null; vault_id: string | null; order_id: string | null };
  spent: number;
  refunded: number;
  created_at: string;
  /** Gift list: one envelope per person. Empty = legacy single-budget mandate. Envelopes sum to budget_total. */
  recipients: Recipient[];
}

export interface Recipient {
  id: string; // "rcp_…"
  name: string; // "Mom"
  envelope: number; // dollars
  interests: string; // "loves gardening"
}

export type RecipientState = "to_buy" | "waiting_approval" | "bought";

export interface RecipientStatus {
  recipient: Recipient;
  spent: number; // charged purchases for this recipient
  remaining: number; // envelope - spent
  state: RecipientState; // bought if any charged purchase; waiting_approval if any pending; else to_buy
  purchase_ids: string[]; // all purchases for this recipient, newest first
}

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number; // in mandate currency, dollars
  currency: "USD";
  category: string; // mapped into the category vocabulary below
  category_confidence: "high" | "low";
  merchant: string;
  image_url: string | null;
  url: string | null;
  source: "channel3" | "catalog";
}

export const CATEGORY_VOCAB = [
  "gifts", "home", "garden", "kitchen", "beauty", "books", "toys", "clothing",
  "sports", "pets", "office", "groceries", "electronics", "jewelry", "other",
] as const;

export interface PurchaseItem {
  product_id: string;
  title: string;
  price: number;
  qty: number;
  category: string;
  merchant: string;
  image_url: string | null;
  url: string | null;
}

export type Decision = "allow" | "needs_approval" | "deny";

export interface PolicyResult {
  decision: Decision;
  reasons: string[];
}

export type PurchaseStatus = "pending_approval" | "charged" | "blocked" | "rejected" | "refunded" | "failed";

export interface Purchase {
  id: string;
  mandate_id: string;
  items: PurchaseItem[];
  total: number;
  status: PurchaseStatus;
  decision: Decision;
  reasons: string[];
  rationale: string; // agent's "why this one"
  paypal: {
    order_id: string | null;
    capture_id: string | null;
    refund_id: string | null;
    /** per_purchase rail: PayPal link where the buyer approves this one payment; null otherwise. */
    approve_url: string | null;
  };
  error: string | null;
  created_at: string;
  /** Gift list: who this purchase is for; null on legacy mandates. */
  recipient_id: string | null;
}

export type LedgerActor = "user" | "agent" | "policy" | "paypal";

export interface LedgerRow {
  id: string;
  ts: string;
  actor: LedgerActor;
  action: string; // e.g. "mandate.created", "search", "purchase.proposed", "policy.deny", "paypal.capture", "paypal.refund", "mandate.revoked"
  summary: string;
  amount: number | null;
  decision: Decision | null;
  reasons: string[] | null;
  paypal_id: string | null;
  purchase_id: string | null;
  remaining_budget: number | null;
  recipient_id: string | null;
}

export interface AppState {
  mandate: Mandate | null;
  remaining: number; // budget_total - spent + refunded, 0 when no mandate
  purchases: Purchase[];
  ledger: LedgerRow[];
  mode: {
    payment: PaymentMode;
    products: "channel3" | "catalog";
    ai: string;
    /** The provider:model that answered the most recent chat turn in this session; null before the first turn. */
    ai_active: string | null;
  };
  /** Gift list status per person; [] when there is no mandate or it has no recipients. */
  recipients: RecipientStatus[];
}

// Agent tool outputs. Chat UI renders tool parts by tool name.
export interface SearchProductsOutput { query: string; source: "channel3" | "catalog"; products: Product[] }
export interface GetMandateOutput { mandate: Mandate | null; remaining: number; recipients: RecipientStatus[] }
export interface ProposePurchaseOutput { purchase: Purchase; remaining: number } // card by purchase.status: charged→receipt, pending_approval→approval, blocked→blocked, failed→error
export interface RequestRefundOutput { purchase: Purchase; remaining: number }
export interface ListPurchasesOutput { purchases: Purchase[] }
/** report_suspicious_content: the model flagged product text that tries to instruct it (defence layer 1). */
export interface ReportSuspiciousOutput { flagged: true; product_id: string; product_title: string | null; reason: string }

export interface SearchGiftsOutput {
  source: "channel3" | "catalog";
  results: { recipient_id: string; recipient_name: string; query: string; products: Product[] }[];
}
export interface BuyGiftPlanOutput {
  results: { recipient_id: string; recipient_name: string; purchase: Purchase | null; error: string | null }[];
  remaining: number;
  recipients: RecipientStatus[];
}

export type AgentToolName =
  | "search_products"
  | "get_mandate"
  | "propose_purchase"
  | "request_refund"
  | "list_purchases"
  | "report_suspicious_content"
  | "search_gifts"
  | "buy_gift_plan";
