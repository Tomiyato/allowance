# Ribbon: 3-minute test path for judges

**Hosted demo:** https://allowance-cpp0.onrender.com (free tier: the first load after idle can take about a minute)

**Sandbox buyer:** `sb-aktpl53694657@personal.example.com` / `Lc:)K9dT`. These are PayPal sandbox test credentials, so no real money moves.

Each browser gets its own fresh demo session. To start over, use a private window. The path takes about 3 minutes plus a few AI waits of 5 to 20 seconds each.

## The demo list

The **Gift list** page is prefilled with this text. Keep it as it is:

> Holiday gifts, $200 total. Mom $60, she loves gardening. Dad $50, coffee nerd. My nephews Leo $30 (dinosaurs) and Sam $30 (soccer). Office Secret Santa $30, something for the desk. Ask me before anything over $45. No electronics.

## The path

| # | Do this | Expect |
|---|---|---|
| 1 | Open the site. On **Step 1 · Gift list**, click **Draft with AI**. | A **Review before you approve** panel: five people (Mom $60, Dad $50, Leo $30, Sam $30, Secret Santa $30) with their interests, a total of **$200** (the sum of the envelopes, read-only), **Ask me above** $45, **electronics** blocked, max 2 per item, and an expiry no more than 29 days out ("PayPal holds the budget for up to 29 days"). Every field and person can be edited. |
| 2 | Click **Approve $200.00 with PayPal**. Sign in with the sandbox buyer and approve. | You land back on the app with the gift list **Active**, **Left to spend** $200.00, an **Envelopes** section with a meter per person, and a **PayPal authorization** ID. The approval is a $200 authorization hold, not a payment. |
| 3 | Click **Shop the list with the agent**. On the Agent page, click the suggestion **Shop my whole gift list**. | A **Gift search** card with options for each person (from Channel3), then a **Gift plan** card: one row per person with the gift, the price and a status. **Bought** rows carry a real PayPal capture ID. Under the rows: what is left on your PayPal approval. If a listing tries to give the agent orders, an **Agent flagged suspicious product text** card appears and the agent skips it. |
| 4 | Find Mom's row. If it says **Waiting for your OK** (her gift is over $45), click **Approve $…**. | The gift is charged (toast **Approved and paid $…**), the row turns **Bought** with a capture ID, and Mom's envelope goes down. If the agent picked a gift for Mom at $45 or less, it was bought directly; the ask-first rule then shows up in step 6 instead. |
| 5 | Near the top of the Agent page, in the **Safety demo** box ("The model can be fooled. Your gift list can't."), click **Simulate a hijacked agent**. | A **Red-team simulation** card: an agent that obeyed the poisoned listing tried to buy 5 × "Deluxe Herb Seed Gift Box" ($170) for Mom. **Blocked by your gift list**: 5 is over the per-item cap of 2, $170 is over Mom's envelope, and over the total left. No AI call is involved, so this works even when the AI is rate-limited. |
| 6 | Click the suggestion **Order a robot vacuum**. | **Blocked by your gift list**: category "electronics" is blocked. Nothing is charged. (Optional: **Find Mom something under $60** shows the envelope check or the ask-first card, depending on what Mom already has.) |
| 7 | Click the suggestion **Return Sam's gift**. | A **Refund issued** card with a PayPal refund ID: "Sam's envelope has $30.00 again". The topbar meter goes back up. |
| 8 | Open **Ledger**. | Two AG Grid grids. **Gift list**: Recipient, Envelope, Gift, Price, Status, PayPal capture, Left, and a pinned total row. **Ledger**: a row for every step, with a Recipient column, reasons for each policy decision, PayPal IDs and the budget left. Type `deny` in the filter to see only the blocked attempts (the hijack and the vacuum). |
| 9 | Go to **Gift list**, click **Revoke gift list**, then **Yes, revoke now**. Then ask the agent to buy anything. | The agent loses spending power immediately (enforced in code) and Ribbon voids the PayPal authorization, releasing whatever part of the hold was never captured. The ledger records PayPal's answer as a `paypal.void` row. The next purchase attempt is blocked: "The gift list is revoked, not active." |

The point of steps 4 to 6: the model can be fooled, but your gift list cannot. Three layers stand behind each gift: the model flags injected text, the deterministic policy engine checks every envelope, duplicate and threshold, and the PayPal authorization is the outer bound (the agent can only draw against the one authorization you approved, and PayPal refuses further captures once it is used up). The exact per-person budget is enforced in code before any PayPal call. The [README](../README.md#defence-in-code) has the details.

## Troubleshooting

- **The first load hangs for up to a minute.** The demo runs on Render's free tier, which spins the service down after 15 minutes without traffic. The first request wakes it up. Reload once it responds. A spin-down also resets all sessions (the store is in memory), so you may need to draft the list again.
- **"The AI is rate-limited right now…"** The free AI tiers are small. When a model is rate-limited or overloaded, the server moves to the next model in its chain (other Gemini models, then Groq) on its own. If all are busy, you see this message and nothing is bought. Wait about a minute and click **Try again**. **Simulate a hijacked agent** and the Ledger need no AI and always work.
- **The draft has no people and a note about a "simple rule-based parser".** The AI was rate-limited during step 1. Click **Draft with AI** again after a minute, or add the five people by hand in the editor (name, envelope, interests).
- **Not every person got a gift.** The agent may skip someone when nothing fits the envelope, or a pick may be blocked. The Gift plan row says why. Ask "Find Leo something under $30" (or the person's name) to fill the gap.
- **A MOCK PAYMENTS badge is visible.** The server is running without PayPal keys, so IDs start with `MOCK-` and no sandbox call is made. The hosted demo should not show this badge. If it does, please tell us.
- **Search results look like a small fixed catalog.** Channel3 was unavailable, and search fell back to the seeded catalog. The flow is the same.
- **PayPal approval returns to the Gift list page with an error.** Start over in a private window and approve again with the sandbox buyer above, not a real PayPal account. A cancelled PayPal screen also returns to the Gift list page, and the list stays a draft until you approve.
