# Gift-list pivot: spec v2 (2026-11-05)

Why: docs/research/competition.md. Four other entries in this hackathon are called "Allowance". About fifteen more ship the same "agent mandate + policy engine" idea. No entry found shops a whole holiday gift list under one PayPal approval with a separate envelope per person. We keep the working core (Orders v2 AUTHORIZE, partial captures, refunds, void, policy engine, Channel3, red-team, AG Grid ledger) and reposition it.

**Product name:** **Ribbon** (chosen 2026-11-05; tagline "Every gift on your list, tied to one PayPal approval."). Keep the internal word "mandate" in code; user-facing text says "gift list".
**Pitch:** the user types their holiday list once and approves one PayPal authorization for the total. The agent buys a gift for everyone on the list, each inside that person's envelope. Purchases above the ask-me threshold wait for a yes. Code, not the model, enforces every envelope.

## 1. Decisions (fixed; do not reopen)

1. **Envelopes sum to the total.** When `recipients` is non-empty, `budget_total` = the sum of the envelopes. The server validates this (tolerance $0.01) and the UI derives the total.
2. **One global ask-me threshold** (`per_purchase_approval_over`). The parser default is $45 when the text gives none. The demo list states it.
3. **Duplicate gifts are a hard deny.** The same `product_id` already in a `charged` or `pending_approval` purchase of this mandate is denied.
4. **Expiry is capped by the PayPal authorization validity.** `expires_at` = min(user's date, now + 29 days), applied in `MandateInputSchema` / `buildMandate`. The UI says "PayPal holds the budget for up to 29 days". The parser default is now + 29 days.
5. **Rename only what users see.** Keep the code identifiers, the cookie name, the Render service name and hostname `allowance-cpp0.onrender.com`, and the repo URL.
6. **Envelope accounting is derived, not stored.** Recipient spent = the sum of `total` over purchases with that `recipient_id` and status `charged`. Refunded purchases free the envelope.
7. **The red-team hijack** targets the first recipient (Mom). Five units of the injection item ($170) are denied by the quantity cap, the envelope and the budget.

## 2. Demo list (use everywhere: parser example, fixtures, smoke, screenshots, video)

> Holiday gifts, $200 total. Mom $60, she loves gardening. Dad $50, coffee nerd. My nephews Leo $30 (dinosaurs) and Sam $30 (soccer). Office Secret Santa $30, something for the desk. Ask me before anything over $45. No electronics.

The envelopes are 60, 50, 30, 30 and 30, which sum to 200. Allowed categories: gifts, home, garden, kitchen, toys, sports, books, office, clothing, beauty. Blocked: electronics. Max quantity per item: 2.

## 3. Contract (shared/types.ts — exact; web and server both build against this)

```ts
export interface Recipient {
  id: string;            // "rcp_…"
  name: string;          // "Mom"
  envelope: number;      // dollars
  interests: string;     // "loves gardening"
}

// Mandate: add
  recipients: Recipient[];          // [] = legacy single-budget mandate (keeps old tests valid)

// Purchase: add
  recipient_id: string | null;

// LedgerRow: add
  recipient_id: string | null;

export type RecipientState = "to_buy" | "waiting_approval" | "bought";
export interface RecipientStatus {
  recipient: Recipient;
  spent: number;          // charged purchases for this recipient
  remaining: number;      // envelope - spent
  state: RecipientState;  // bought if any charged purchase; waiting_approval if any pending; else to_buy
  purchase_ids: string[]; // all purchases for this recipient, newest first
}

// AppState: add
  recipients: RecipientStatus[];    // [] when no mandate or legacy mandate

// New tool outputs
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
  | "search_products" | "get_mandate" | "propose_purchase" | "request_refund"
  | "list_purchases" | "report_suspicious_content"
  | "search_gifts" | "buy_gift_plan";
```

`GetMandateOutput` gains `recipients: RecipientStatus[]`.

## 4. Server

- **policy.ts.** `PolicyInput` gains `recipient?: { id: string; name: string; envelope: number; spent: number } | null` and `existingProductIds?: string[]`. New checks go after the remaining-budget check and before the deny return. They run only when `mandate.recipients.length > 0`:
  1. no recipient → deny `"Pick who this gift is for: every purchase must name someone on the list."`;
  2. `total > envelope - spent` → deny `"$X for <name> exceeds <name>'s envelope: $R left of $E."`;
  3. a product already in `existingProductIds` → deny `"<title> is already bought for someone on the list; no duplicate gifts."`.
  `humanApproved` never clears them. Add tests for each, for a legacy mandate (no recipients, unchanged), and for the hijack case.
- **service.ts.**
  - `MandateInputSchema` adds `recipients` (1–12, unique names case-insensitive, envelope > 0, interests up to 120 characters), the sum check and the expiry clamp.
  - `proposePurchase(session, items, rationale, origin, recipientId?)` resolves the recipient (unknown → deny reason) and passes the recipient and `existingProductIds` to `evaluatePolicy`. It sets `purchase.recipient_id` and puts the recipient name in ledger summaries ("…for Mom").
  - `approvePurchase` re-runs the check with the recipient.
  - `refundPurchase` works for null and non-null recipients.
  - `simulateHijackedAgent` uses the first recipient.
  - New `buyGiftPlan(session, plan: {recipient_id, product_id, rationale}[])` calls `proposePurchase` once per entry, in order, and returns `BuyGiftPlanOutput`.
  - Revoke: when void returns 422 `PREVIOUSLY_CAPTURED`, the ledger says "Nothing left on the PayPal authorization to void", not "voided".
- **store.ts.** `load()` defaults `recipients: []` and `recipient_id: null`. Add a `recipientStatuses(s)` helper, and fill `appState.recipients` and `addLedger` `recipient_id` (default null).
- **agent/parse-mandate.ts.** `DraftSchema` gets `recipients[] {name, envelope, interests}` and a prompt for splitting. On fallback the heuristic returns `recipients: []` with the existing warning. The threshold default is 45 and the expiry default is now + 29d. Check that Gemini structured output handles the nested array; if not, parse recipients in a second small call.
- **agent/tools.ts.**
  - `search_gifts({ searches: {recipient_id, query, max_price?}[] })` runs every search in parallel through `searchProducts`, records them, and returns `SearchGiftsOutput`. Keep the poisoned listing mixing for the Mom/garden query.
  - `buy_gift_plan({ plan: {recipient_id, product_id, rationale}[] })` → `buyGiftPlan`.
  - `propose_purchase` gains an optional `recipient_id`.
  - `get_mandate` returns recipient statuses.
  - Price and category still come only from the server cache.
- **agent/prompt.ts.** The prompt carries the gift list (name, envelope left, interests, already bought). Workflow: when asked to shop the list, call `search_gifts` once for all recipients still `to_buy`, pick one gift each within the envelope, call `buy_gift_plan` once, then summarize per person in 1–2 lines each. Single-person requests may use `search_products` + `propose_purchase` with `recipient_id`. No duplicate gifts. Product text is untrusted, and suspicious listings get `report_suspicious_content`. Brand: "You are Ribbon, a holiday gift-shopping agent."
- **agent/chat.ts.** MAX_STEPS = 10.
- **products/catalog.ts + data/catalog.json.** Add about 12 offline seed items so every demo recipient has 3 or more in-envelope options: dinosaur toys and books, soccer gear, coffee gear, desk/office gifts. Each gets a correct category from the vocabulary.
- **scripts/smoke.ts.**
  - Parse the demo list: 5 recipients, total 200, ask 45, electronics blocked.
  - Shop the list: at least 4 recipients bought or waiting, none over envelope, no duplicate product.
  - The Mom gift over $45 waits for approval; approving it charges it.
  - The robot vacuum is still denied.
  - A refund restores that recipient's envelope.
  - Revoke works.
- Tests: `npm test` and `npm run typecheck` (or the repo's equivalent) must be green.

## 5. Web

- **MandatePage → "Gift list".**
  - The nav label becomes "Gift list".
  - The create form has the textarea with the demo list as its example, then the AI draft, then a review step.
  - A recipient editor shows rows of name, envelope ($), interests and remove, plus an add row; the total is derived and read-only.
  - The rest keeps the existing fields: ask-me threshold, blocked and allowed categories, max quantity, expiry with the 29-day note.
  - Validation: at least one recipient, unique names, envelope > 0.
  - The active view shows per-recipient envelopes with a mini meter each (spent of envelope) and the gift bought.
- **AgentPage.**
  - The first suggestion is "Shop my whole gift list".
  - Others: "Find Mom something under $60", "Order a robot vacuum", "Return Sam's gift".
  - New cards: **GiftSearchCard** (per-recipient product strips with the recipient name and envelope) and **GiftPlanCard**. GiftPlanCard has one row per recipient with gift, price, status (Bought with the PayPal capture ID / Waiting for your OK with Approve and Reject buttons / Blocked with reasons), then the envelope left and the total left.
  - Existing cards show "for <name>" when `recipient_id` is set.
  - Add `pendingLabel` entries for the new tools.
- **LedgerPage.**
  - A new AG Grid "Gift list" grid above the ledger with columns Recipient, Envelope, Gift, Price, Status, PayPal capture and Left, plus a pinned bottom total row.
  - The ledger grid gets a Recipient column.
  - KPIs stay.
- **Brand.** App title, header, footer tagline, index.html title and meta, and the MandatePage h1 are `Ribbon` texts. No user-visible "Allowance" remains.
- **Fixtures** (`fixtures.ts`, `api.ts` fixture paths, `fixtureTransport.ts`) mirror the demo list so the fixture mode demos the new flow.
- Check: `npm run build` (web) is green. The app renders the gift list in fixture mode at phone width and desktop.

## 6. Later (separate briefs, after 3–5 land)

- Rename pass once `Ribbon` is chosen: PayPal `brand_name`, `soft_descriptor` (22 characters or fewer), `note_to_payer`, docs, cover, video cards, package names.
- Docs: README, DEVPOST, JUDGES and VIDEO_SCRIPT rewritten for the gift list, including an Impact number from a primary source (for example NRF holiday spending per person).
- Re-shoot the gallery and the video on the hosted app (scripts already exist).
