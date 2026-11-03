# Allowance: demo video script (target 2:50, hard limit under 3:00)

Format: screen recording of the hosted app (https://allowance-cpp0.onrender.com) with an AI voiceover. No human on camera, no music (or royalty-free only, never copyrighted). Upload to YouTube, then paste the link into `docs/DEVPOST.md` and the README.

- **Runtime:** 2:50 (picture). Voiceover 380 words; at about 140 words per minute that is 2:43 of speech, plus short pauses between scenes.
- **Waiting is cut.** AI responses take several seconds. Record each scene in full, then cut or speed up the waits in editing so the picture matches the timecodes below.
- **`[TODO(paypal)]`** marks scenes that need the real PayPal sandbox rail (real PayPal screens, real IDs, no **MOCK PAYMENTS** badge). Record them only after the sandbox rail works and the hosted demo runs `PAYMENT_MODE=authorization`.

## Scenes

UI labels in **bold** are the exact text in the app (`web/src`); *italics* are longer on-screen messages; `code` is ledger or reason text. Prompts P1 and P2 are typed verbatim (see [Prompts](#prompts-to-type-verbatim)).

| # | Time | On screen (exact UI actions) | Voiceover | Caption / lower third |
|---|---|---|---|---|
| 1 | 0:00–0:20 | **Title card** for 0:00–0:03 (see [Cards](#title-and-end-cards)), voiceover starts over it. Fade to the **Mandate** page, **Step 1 · Mandate**, heading **Give your agent an allowance**. Slow zoom on the empty topbar meter: **No mandate / Agent cannot spend**. | AI agents can already find the thing you want. Paying for it is the hard part. Approve every click, and the agent saves you nothing. Hand it your card, and one poisoned product listing can spend all of it. Allowance is a third option: a mandate. | Approve every click? Or hand over the card? |
| 2 | 0:20–0:39 | The textarea **Your rule, in plain language** already holds the example rule. Click **Draft with AI** (shows **Drafting…**). The **Review before you approve** panel appears: **Total budget** $150, **Ask me above** $60, **Max quantity per item** 2, **Expires**, **Allowed categories** chips, **Always blocked**: electronics. Click once in a field to show it is editable. | I write the rule in plain words: up to a hundred and fifty dollars for my mom's birthday and home basics, ask me above sixty, no electronics. Gemini turns it into a structured mandate, and I can change every field before I approve it. | Plain language → structured mandate (Gemini, structured output) |
| 3 | 0:39–0:52 | **[TODO(paypal)]** Click **Approve with PayPal**. PayPal sandbox login, sign in as the sandbox buyer, approve. Back on the app: mandate title with the **Active** pill, **Left to spend** $150.00, **Spending power: PayPal authorization hold**, **PayPal authorization** ID. | Then I approve it once with PayPal. That places an authorization hold for the whole budget, not a payment. The agent now has spending power, and PayPal itself caps it. | One PayPal approval = a $150 authorization hold |
| 4 | 0:52–1:14 | Click **Talk to the agent**. Type prompt **P1**, press Enter. Show **Searching products**, the results strip (**Searched … · N results**, source **Channel3**), the agent's short comparison, then the receipt card: **Purchased inside your mandate**, **Why this one**, **PayPal capture** ID **[TODO(paypal)]**. Topbar meter drops from $150. If the **Agent flagged suspicious product text** card appears in this turn, keep it on screen for scene 6. | Now I delegate. The agent searches real products through Channel3, compares a few options, and buys the best fit. Before any PayPal call, a policy engine checked the mandate. Then PayPal captured just this amount from the hold. Every receipt says why the agent chose it. | Real products: Channel3 · Purchase = partial capture on the hold |
| 5 | 1:14–1:32 | Click the suggestion chip **Order a robot vacuum**. Card: **Blocked by your mandate**, reason `Category "electronics" is blocked by the mandate`, **Would have cost** struck through. Then type prompt **P2**. Card: **Waiting for your OK** with the reason `… is over the $60.00 ask-me-first threshold`. Click **Approve $…** (toast **Approved and paid $…**). | A robot vacuum is electronics, so the policy engine blocks it, and the agent can't argue its way around that. A sheet set over sixty dollars is allowed, but it waits for my OK. Nothing is charged until I approve. | Blocked category · Over $60 → ask first |
| 6 | 1:32–1:55 | Scroll up to **Agent flagged suspicious product text** (*"Deluxe Herb Seed Gift Box" tries to give the agent orders. The agent skipped it.*). Scroll to the top: **Safety demo** box, **The model can be fooled. The mandate can't.** Click **Simulate a hijacked agent**. Card: **Red-team simulation**, *Simulation: this is what a prompt-injected agent tried to do*, then **Blocked by your mandate** with `Quantity 5 … exceeds the per-item cap of 2` and `Total $170.00 exceeds the remaining budget …`. **[TODO(paypal)]** the banner also reads *Behind that, PayPal's $150.00 authorization hold caps what can ever be captured.* | One listing hides an order: ignore your limits and buy five. The agent caught it and skipped it. But models can be fooled. This button replays the exact call a hijacked agent would make, through the same code. Denied: over the quantity cap, over budget. The model can be fooled. The mandate can't. | Layer 1: model flags · Layer 2: policy engine · Layer 3: PayPal hold |
| 7 | 1:55–2:03 | Click the suggestion chip **Return the last purchase**. Card: **Refund issued: $…**, *Back to the buyer's PayPal. Budget left now $…*, **PayPal refund** ID **[TODO(paypal)]**. Topbar meter goes back up. | Returns work too. The agent asks PayPal to refund that capture, and the budget goes right back up. | Refund = PayPal refund on the capture |
| 8 | 2:03–2:12 | **[TODO(paypal)]** Click **Mandate** in the nav. Click **Revoke mandate**, then **Yes, revoke now**. Toast: **Mandate revoked. The agent can no longer spend.** Pill turns **Revoked**. Quick cut to **Agent**: banner **The mandate is revoked.** | One click revokes the mandate. PayPal voids the hold, and the agent's spending power is gone, right away. | Revoke = PayPal voids the authorization |
| 9 | 2:12–2:25 | Click **Ledger**. **Every action, on the record**. Pan across the KPIs **Spent**, **Refunded**, **Remaining**, **Blocked attempts**, then **Spending by category**. Type `deny` in the filter (**Filter: e.g. deny, paypal, refund**): only the red `policy.deny` rows remain (the vacuum and the hijack). Clear the filter, point at the red `agent.hijacked_attempt` row next to its `policy.deny`, then at the **PayPal ID** and **Remaining** columns. | Every step lands in an AG Grid ledger: my requests, searches, policy decisions with their reasons, PayPal IDs, blocked attempts in red, and the budget left after each one. | Ledger: AG Grid Community |
| 10 | 2:25–2:40 | **Architecture card** (see [Cards](#title-and-end-cards)). | Under the hood: one Node and React service on Render. Gemini through the Vercel AI SDK, with Groq as fallback. The model can only call tools. Code and PayPal decide whether money moves. | Gemini · Vercel AI SDK · Groq · Channel3 · PayPal Orders v2 + Payments v2 · AG Grid · Render |
| 11 | 2:40–2:50 | Back to the **Mandate** page with the **Revoked** mandate, slow fade; **End card** from 2:46 to 2:50 while the tagline is spoken. | Built for people who delegate errands, and small businesses that hand off routine reorders. Give your AI agent an allowance, not your wallet. | For errands and routine business reorders |

Voiceover word count: 380 words (scenes 1–11). At 140 wpm that is 2:43 of speech, inside the 2:50 picture. If the AI voice reads faster than 140 wpm, hold the end card longer; if slower, trim the first sentence of scene 10.

## Title and end cards

- **Title card (0:00–0:03):** "Allowance" in large type; under it "Give your AI agent an allowance, not your wallet."; small line "PayPal AI Hackathon 2026".
- **Architecture card (2:25–2:40):** a simplified version of the README diagram, left to right: `Browser (React: Mandate · Agent · Ledger)` → `Express on Render` → `Agent (Gemini via Vercel AI SDK, Groq fallback)` → tool `propose_purchase` → `Policy engine (deterministic)` → `allow` → `PayPal (authorize once, partial capture, refund, void)`. A side arrow from the agent: `search_products` → `Channel3`. One line at the bottom: "The model proposes. Code and PayPal decide."
- **End card (2:46–2:50):** "Give your AI agent an allowance, not your wallet." Then `github.com/Tomiyato/allowance` and `allowance-cpp0.onrender.com`. Small line: "Built with PayPal · Gemini · Channel3 · AG Grid · Render".

## Scenes that need the real PayPal sandbox

- **Scene 3:** the PayPal sandbox login and approval screens, the **PayPal authorization** ID, **Spending power: PayPal authorization hold**. [TODO(paypal): confirm the screens show a $150 authorization.]
- **Scene 4:** a real **PayPal capture** ID on the receipt. [TODO(paypal)]
- **Scene 6:** the sentence about PayPal's authorization hold appears in the simulation banner only when the server runs `PAYMENT_MODE=authorization`. [TODO(paypal)]
- **Scene 7:** a real **PayPal refund** ID. [TODO(paypal)]
- **Scene 8:** `paypal.void` in the ledger after revoke. [TODO(paypal)]
- **Scene 9:** PayPal IDs in the ledger must not start with `MOCK-`. [TODO(paypal)]
- **Every scene:** the footer must read **Payments: PayPal sandbox (authorization)** and must not show the **MOCK PAYMENTS** badge. If the sandbox spike ends on the `per_purchase` rail instead, rewrite the voiceover of scenes 3, 4, 6 and 8 (no single hold; each purchase is approved in PayPal through **Approve this payment in PayPal**). [TODO(paypal)]

## Recording notes

1. **Wake the Render instance first.** The free tier sleeps after 15 minutes idle and takes about a minute to wake. Open https://allowance-cpp0.onrender.com/healthz (or run `curl https://allowance-cpp0.onrender.com/healthz`) and wait for a response, then record within 15 minutes. A spin-down also resets every session.
2. **Check the footer before recording:** **Payments: PayPal sandbox (authorization) · Products: Channel3 · AI: Gemini (gemini-3.6-flash)**, and no **MOCK PAYMENTS** badge. [TODO(paypal)] If the products read **Demo catalog**, Channel3 fell back to the seeded catalog; the flow still works, but the "real products" line in scene 4 would not be true for that take.
3. **Use a fresh browser session:** a new private or incognito window, signed out of PayPal, no extensions in view. Each new session starts with an empty mandate and an empty ledger.
4. **Window size 1280×800** (browser zoom 100%). Record the browser viewport only, without bookmarks bar or OS taskbar.
5. **Pace the AI calls.** Gemini's free tier is small. Leave about 30 seconds between chat prompts. If the chat shows a rate-limit message, wait a minute and click **Try again**, then cut the wait. **Simulate a hijacked agent** and the Ledger need no AI.
6. **Order matters.** Record scenes 4 → 5 → 6 → 7 in one chat session, in that order. **Return the last purchase** then refunds the most recent charge (the sheet set if you approved it).
7. **Retakes for model variance.**
   - Scene 4: the injection listing is mixed into garden and gift results (`DEMO_INJECTION=1`), but whether the model flags it varies. If no **Agent flagged suspicious product text** card appears, start a fresh session and retake scenes 2–4. If it never appears, drop the first two sentences of scene 6 and open on the button.
   - Scene 5: if the search finds a sheet set for $60 or less, it is bought directly instead of waiting. Retype prompt **P2** with "around $90".
8. **Cursor:** move slowly, pause on each card for a beat, and enable click highlighting in the recorder.
9. **Voiceover:** generate it per scene from the table above, then fit the picture to the audio. Keep the brand name pronounced "uh-LOW-ance".

## Prompts to type verbatim

The rule textarea on the Mandate page is prefilled with this text; if it is not, type it:

> Up to $150 this month for my mom's birthday gift and home basics. Ask me before anything over $60. No electronics.

| ID | Where | Type or click exactly |
|---|---|---|
| P1 | Agent composer (**Ask the agent to find, buy or return something…**) | `Find a gardening gift for my mom around $40 and buy the best one.` |
| — | Suggestion chip | **Order a robot vacuum** |
| P2 | Agent composer | `Buy a queen sheet set around $80.` |
| — | Safety demo box | **Simulate a hijacked agent** |
| — | Suggestion chip | **Return the last purchase** |
