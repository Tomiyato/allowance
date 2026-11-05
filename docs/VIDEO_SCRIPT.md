# Ribbon: demo video script (target 2:50, hard limit under 3:00)

Format: screen recording of the hosted app (https://allowance-cpp0.onrender.com) with an AI voiceover (ElevenLabs v4). No human on camera, no music (or royalty-free only, never copyrighted). Upload to YouTube, then paste the link into `docs/DEVPOST.md` and the README.

- **Runtime:** 2:50 (picture). Voiceover 365 words; at about 140 words per minute that is about 2:36 of speech, plus short pauses between scenes.
- **Waiting is cut.** AI responses take several seconds, and shopping the whole list takes longer. Record each scene in full, then cut or speed up the waits (with the "sped up" badge) so the picture matches the timecodes below.
- **Real PayPal sandbox scenes** (3, 4, 5, 7, 9) need the real rail: real PayPal screens, real IDs, no **MOCK PAYMENTS** badge. Record on the hosted demo running `PAYMENT_MODE=authorization`.
- **Pipeline:** `scripts/video/scenes.json` and `scripts/video/record.mjs` still follow the previous script. Update them from this file before running `npm run video`.

## Audio tags

The voiceover column marks a few ElevenLabs v4 audio tags in square brackets, for example `[warm]` or `[excited]`. Use them sparingly: at most one per scene, at the start of a sentence. **Tags are spoken direction only. They never appear in captions or subtitles**; strip every `[...]` before writing the caption track.

## Scenes

UI labels in **bold** are the exact text in the app (`web/src`); *italics* are longer on-screen messages; `code` is ledger or reason text.

| # | Time | On screen (exact UI actions) | Voiceover | Caption / lower third |
|---|---|---|---|---|
| 1 | 0:00–0:17 | **Title card** (see [Cards](#cards)): "Ribbon", the tagline and two fact tiles (a static card; a slow push-in from 0:03 keeps it alive): **36%** "Setting and sticking to a budget: shoppers' top holiday plan" and **63%** "would spend hours searching for the perfect gift", source line "PayPal 2026 Holiday Shopping Survey". Fade to the **Gift list** page at 0:16. | [warm] PayPal's own holiday survey found that shoppers' number one plan is to set a budget and stick to it. And sixty-three percent would spend hours hunting for the perfect gift. Ribbon does the hunting. Code does the sticking. | PayPal 2026 Holiday Shopping Survey: budget is the #1 plan (36%) |
| 2 | 0:17–0:39 | **Step 1 · Gift list**, heading **Every gift on your list, tied to one PayPal approval**. The textarea **Your gift list, in plain language** holds the demo list. Click **Draft with AI** (shows **Drafting…**). The **Review before you approve** panel: five rows (Mom $60, Dad $50, Leo $30, Sam $30, Secret Santa $30) with interests, the total $200 marked *sum of the envelopes*, **Ask me above** $45, electronics under *refused even if asked*. Click once into Mom's envelope to show it is editable. | I type my list once. Two hundred dollars: Mom sixty, Dad fifty, my nephews Leo and Sam thirty each, and thirty for the office Secret Santa. Ask me before anything over forty-five, and no electronics. Gemini drafts an envelope for each person, and I can change any of it. | One sentence → five envelopes (Gemini, structured output) |
| 3 | 0:39–0:51 | Click **Approve $200.00 with PayPal**. PayPal sandbox login, sign in as the sandbox buyer, approve. Back on the app: the **Active** pill, **Left to spend** $200.00, **Envelopes** with five empty meters, the **PayPal authorization** ID. | Then I approve two hundred dollars with PayPal, once. That's an authorization hold, not a payment, and Ribbon splits it into five envelopes. | One PayPal approval = one $200 authorization, five envelopes |
| 4 | 0:51–1:13 | Click **Shop the list with the agent**. Click the suggestion **Shop my whole gift list**. Show **Searching gifts for everyone on the list**, then the **Gift search** card with a strip of options per person (source **Channel3**), then **Buying each gift inside its envelope**. If the **Agent flagged suspicious product text** card appears, hold on it for a beat. | [excited] Now the fun part: shop my whole gift list. The agent searches real products for all five people at once, through Channel3, picks one gift each, and buys them in a single pass. Each gift is checked in code against its own envelope. Then PayPal captures just that amount. | One pass: search everyone, buy everyone · Channel3 |
| 5 | 1:13–1:28 | The **Gift plan** card: *Gift plan: N of 5 bought*, a row per person with gift, price, **Bought** and a **PayPal capture** ID; Mom's row **Waiting for your OK** with `Total $… is over the $45.00 ask-me-first threshold.` Click **Approve $…** in Mom's row. Toast **Approved and paid $…**; the row turns **Bought**. Point at **Left on your PayPal approval**. | The gift plan shows everyone: the gift, the price, the PayPal capture, and what's left. Mom's gift is over forty-five dollars, so it waited for my yes. One click, and it's paid. | Over $45 → it waits for your yes |
| 6 | 1:28–1:48 | Scroll to the top of the Agent page: the **Safety demo** box, *The model can be fooled. Your gift list can't.* Click **Simulate a hijacked agent**. Card: **Red-team simulation**, *Simulation: this is what a prompt-injected agent tried to do*, then **Blocked by your gift list** with `Quantity 5 of "Deluxe Herb Seed Gift Box" exceeds the per-item cap of 2.` and `$170.00 for Mom exceeds Mom's envelope: …` | [serious] One listing hides an order: ignore your limits and buy five. Models can be fooled, so this button plays a hijacked agent through the same code. Five gift boxes, a hundred and seventy dollars, for Mom. Blocked: over the quantity cap, and over Mom's envelope. | A hijacked agent, blocked in code |
| 7 | 1:48–1:58 | Click the suggestion **Return Sam's gift**. Card: **Refund issued: $… for Sam**, *Back to the buyer's PayPal. Sam's envelope has $30.00 again*, **PayPal refund** ID. The topbar meter goes back up. | Sam already has one? Return Sam's gift. PayPal refunds it, and his thirty dollars go right back into his envelope. | Refund → back into Sam's envelope |
| 8 | 1:58–2:15 | Click **Ledger**. **Every action, on the record**. Pan the **Gift list** grid: Recipient, Envelope, Gift, Price, Status, PayPal capture, Left, and the pinned total row. Scroll to the ledger grid, type `deny` in **Filter: e.g. deny, paypal, refund**: only the red rows remain (the hijack). Clear the filter; point at the **Recipient** and **PayPal ID** columns. | Every step lands in AG Grid. The gift list shows each person, their envelope, the gift and its PayPal capture. Below it, the ledger: searches, decisions with their reasons, captures, refunds, and the blocked attempt in red. | AG Grid: gift list + ledger |
| 9 | 2:15–2:26 | Click **Gift list** in the nav. Click **Revoke gift list**, then **Yes, revoke now**. Toast: **Gift list revoked. The agent can no longer spend.** The pill turns **Revoked**. | And one click revokes it. The agent loses spending power immediately, and PayPal releases whatever is left on the hold. | Revoke: spending power ends in code at once |
| 10 | 2:26–2:43 | **Architecture card** in three steps (see [Cards](#cards)). | Under the hood: one Node and React service on Render. Gemini through the Vercel AI SDK, with a Groq fallback. The model only calls tools. A policy engine checks every envelope, and PayPal is the outer bound. | Gemini · Vercel AI SDK · Groq · Channel3 · PayPal Orders v2 + Payments v2 · AG Grid · Render |
| 11 | 2:43–2:50 | Back to the **Gift list** page, slow fade; **End card** from 2:45 while the tagline is spoken. | [warm] Ribbon. Every gift on your list, tied to one PayPal approval. | (none; the end card carries the tagline) |

Voiceover word count: 365 words (scenes 1–11, tags not counted). At 140 wpm that is about 2:36 of speech; each scene's time allows its words at 140 wpm plus about a second of pause, inside the 2:50 picture. If the voice reads slower, cut "Now the fun part:" in scene 4 and "Sam already has one?" in scene 7; if faster, hold the end card longer.

## Cards

All cards use the app's palette from `web/src/styles.css` (ivory `#fbf7ee`, garnet `#8e1b2f`, gold `#c9a24b`, evergreen `#1e6b47`) and the bow mark from `web/src/components/Icon.tsx`. Sources: `scripts/video/cards/*.html`, 1920×1080.

- **Title card (0:00–0:16):** the bow mark and "Ribbon" in the serif wordmark; under it "Every gift on your list, tied to one PayPal approval."; then two fact tiles: **36%** "Setting and sticking to a budget is shoppers' top holiday plan" and **63%** "would spend hours searching online for the perfect gift"; source line "PayPal 2026 Holiday Shopping Survey (Morning Consult, n=2,005 US adults)"; small line "PayPal AI Hackathon 2026".
- **Architecture card (2:26–2:43):** left to right: `Browser (React: Gift list · Agent · Ledger, AG Grid)` → `Express on Render` → `Agent (Gemini via Vercel AI SDK, Groq fallback)` → `buy_gift_plan` → `Policy engine (envelopes, duplicates, ask-me threshold)` → `allow` → `PayPal (authorize once, capture per gift, refund, void)`. A side arrow from the agent: `search_gifts` → `Channel3`. One line at the bottom: "The model proposes. Code checks every envelope. PayPal is the outer bound." Step 1 shows browser and server, step 2 adds the agent and Channel3, step 3 the policy engine, PayPal and the three layers.
- **End card (2:45–2:50):** the bow mark and "Ribbon"; "Every gift on your list, tied to one PayPal approval."; then `github.com/Tomiyato/allowance` and `allowance-cpp0.onrender.com`. Small line: "Built with PayPal · Gemini · Channel3 · AG Grid · Render".

## Scenes that need the real PayPal sandbox

- **Scene 3:** the PayPal sandbox login and approval screens showing $200.00, then the **PayPal authorization** ID in the app.
- **Scenes 4 and 5:** real **PayPal capture** IDs in the gift plan, including Mom's after approval.
- **Scene 6:** the sentence *Behind that, PayPal holds the outer bound: the agent can only draw against the single $200.00 authorization you approved.* appears in the simulation banner only with `PAYMENT_MODE=authorization`.
- **Scene 7:** a real **PayPal refund** ID.
- **Scene 9:** a `paypal.void` row in the ledger after revoke (cut to it only if the video needs it; the voiceover does not depend on it).
- **Every scene:** the footer must read **Payments: PayPal sandbox (authorization)** and must not show the **MOCK PAYMENTS** badge.

## Recording notes

1. **Wake the Render instance first.** The free tier sleeps after 15 minutes idle and takes about a minute to wake. Open https://allowance-cpp0.onrender.com/healthz and wait for a response, then record within 15 minutes. A spin-down also resets every session.
2. **Check the footer before recording:** **Payments: PayPal sandbox (authorization) · Products: Channel3 · AI: Gemini (…)**, and no **MOCK PAYMENTS** badge. If products read **Demo catalog**, Channel3 fell back to the seeded catalog; the flow still works, but the "real products" line in scene 4 would not be true for that take.
3. **Use a fresh browser session:** a new private window, signed out of PayPal, no extensions in view.
4. **Window size 1280×800**, browser zoom 100%. Record the viewport only.
5. **Pace the AI calls.** Leave about 30 seconds between chat prompts. If the chat shows the rate-limit message, wait a minute and click **Try again**, then cut the wait. **Simulate a hijacked agent** and the Ledger need no AI.
6. **Order matters.** Record scenes 4 → 5 → 6 → 7 in one chat session, in that order. The hijack (scene 6) runs after shopping, so its reasons also include the total left.
7. **Retakes for model variance.**
   - Scene 5: Mom's gift must be over $45 to wait. If the agent picked one at $45 or less, start a fresh session and retake scenes 2–5. If it keeps picking under $45, keep the take and change the scene 5 line to "Anything over forty-five dollars waits for my yes" over the **Waiting for your OK** card of a later take.
   - Scene 7: Sam must have a **Bought** gift. If his row is blocked or empty, retake from scene 2.
   - Scene 4: the flag card depends on the model. If it does not appear, the scene still works; scene 6 carries the injection story.
8. **Cursor:** move slowly, pause on each card for a beat, and enable click highlighting.
9. **Voiceover:** generate it per scene from the table above (with the tags), then fit the picture to the audio.

## What to type or click

| Where | Type or click exactly |
|---|---|
| Gift list textarea (prefilled; type it if not) | `Holiday gifts, $200 total. Mom $60, she loves gardening. Dad $50, coffee nerd. My nephews Leo $30 (dinosaurs) and Sam $30 (soccer). Office Secret Santa $30, something for the desk. Ask me before anything over $45. No electronics.` |
| Gift list review | **Approve $200.00 with PayPal** |
| Active gift list | **Shop the list with the agent** |
| Suggestion chip | **Shop my whole gift list** |
| Gift plan, Mom's row | **Approve $…** |
| Safety demo box | **Simulate a hijacked agent** |
| Suggestion chip | **Return Sam's gift** |
| Ledger filter | `deny` |
| Gift list page | **Revoke gift list**, then **Yes, revoke now** |
