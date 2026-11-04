# Allowance: 2-minute test path for judges

**Hosted demo:** https://allowance-cpp0.onrender.com (free tier: the first load after idle can take ~1 minute)

**Sandbox buyer:** `PAYPAL_BUYER_EMAIL_HERE` / `PAYPAL_BUYER_PASSWORD_HERE`. These are PayPal sandbox test credentials, so no real money moves.

The first load can take about a minute (see [Troubleshooting](#troubleshooting)). Each browser gets its own fresh demo session. To start over, use a private window.

## The path

| # | Do this | Expect |
|---|---|---|
| 1 | Open the site. On **Step 1 · Mandate**, keep the example rule: *"Up to $150 this month for my mom's birthday gift and home basics. Ask me before anything over $60. No electronics."* Click **Draft with AI**. | A review form appears: budget $150, "ask me above" $60, max 2 per item, expiry at the end of this month, **electronics** blocked, and gifts, home, garden, kitchen and more allowed. Every field can be edited. |
| 2 | Click **Approve with PayPal**, sign in with the sandbox buyer and approve. | You land back on the app with the mandate **active**. On the **Ledger**, `mandate.activated` carries a PayPal authorization ID. The approval creates a $150 authorization hold, not a payment. |
| 3 | Click **Talk to the agent**. Type *"Find a gardening gift for my mom around $40 and buy the best one."* | The agent searches real products (Channel3), lists up to 3 options and explains its pick. A **receipt card** shows the price, the "Why this one" note and a PayPal capture ID, and the remaining budget goes down. If a listing tries to give instructions, the agent says it skipped a likely prompt-injection attempt. |
| 4 | Type *"Order a robot vacuum."* | The agent still tries, and the card reads **Blocked by your mandate**: category "electronics" is blocked. Nothing is charged. |
| 5 | Type *"Buy a queen sheet set around $80."* | A **Waiting for your OK** card appears, because the total is over the $60 threshold. Click **Approve $…** to charge it or **Reject** to drop it. If the search finds a set for $60 or less, it is bought directly instead. |
| 6 | Near the top of the Agent page, in the **Safety demo** box, click **Simulate a hijacked agent**. | A **Red-team simulation** card shows what an agent that obeyed the poisoned listing tried to do: buy 5 units of "Deluxe Herb Seed Gift Box" for $170. The policy engine **blocks** it, because 5 is over the per-item cap of 2 and $170 is over the remaining budget. No AI call is involved, so this works even when the AI is rate-limited. |
| 7 | Type *"Return the last purchase."* (or click **Refund** on a receipt card) | A refund card shows a PayPal refund ID, and the remaining budget goes back up. |
| 8 | Go back to **Mandate** and click **Revoke mandate**, then ask the agent to buy anything. | PayPal voids the authorization (`paypal.void` in the ledger). The next purchase attempt is blocked: "Mandate is revoked, not active." |
| 9 | Open **Ledger**. | An AG Grid row for every step: your requests, searches, proposals, policy decisions with reasons (blocked rows in red), captures, refunds, the red-team attempt (`agent.hijacked_attempt` then `policy.deny`), the injection flag (`agent.flagged_injection`), the void, a running remaining-budget column, and spending by category. |

The point of steps 4 to 6: the model can be fooled, but the mandate cannot. Three layers stand behind each purchase: the model flags injected text, the deterministic policy engine decides, and the PayPal authorization is the outer bound (the agent can only draw against the one authorization you approved, and PayPal refuses further captures once it is used up). The exact budget is enforced in code by the policy engine before any PayPal call. The [README](../README.md#three-layers-of-defence) has the details.

## Troubleshooting

- **The first load hangs for up to a minute.** The demo runs on Render's free tier, which spins the service down after 15 minutes without traffic. The first request wakes it up, which takes about a minute. Reload once it responds. A spin-down also resets all sessions (the store is in memory), so you may need to create the mandate again.
- **"The AI model is busy or rate-limited right now (free tier)…"** Gemini's free quota is small. On a 429 or overload error, the server switches to the Groq fallback (`openai/gpt-oss-120b`) for that request on its own. If both are busy, you see this message and nothing is bought. Wait about a minute and click **Try again**. **Simulate a hijacked agent** and the Ledger need no AI and always work.
- **The mandate draft is filled by a "simple rule-based parser".** This happens when the AI was rate-limited during step 1. Check the fields (budget, threshold, blocked categories) and continue.
- **A MOCK PAYMENTS badge is visible.** The server is running without PayPal keys, so the IDs start with `MOCK-` and no sandbox call is made. The hosted demo should not show this badge. If it does, please tell us.
- **Search results look like a small fixed catalog.** Channel3 was unavailable, and search fell back to the seeded catalog. The flow is the same.
- **PayPal approval returns to the Mandate page with an error.** Start over in a private window and approve again (use the sandbox buyer above, not a real PayPal account). A cancelled PayPal screen also returns to the Mandate page, and the mandate stays inactive until you approve.
