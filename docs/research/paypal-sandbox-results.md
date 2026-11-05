# PayPal sandbox — verified results (2026-11-03 to 11-05)

Sandbox setup: app linked to a **US** sandbox business account (merchant `sb-uexpn53656635@business.example.com`); buyer is a **US** sandbox personal account. The default KZ sandbox accounts were not used.

## Direct REST spike (curl), 2026-11-03

| Step | Call | Result |
|---|---|---|
| Create mandate order | `POST /v2/checkout/orders` intent `AUTHORIZE`, $150, `payment_source.paypal.experience_context` | 200, status `PAYER_ACTION_REQUIRED`, link rel `payer-action` |
| Buyer approval | sandbox checkout page | approved |
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | 201, order `COMPLETED`, authorization `CREATED` $150, expires in 29 days |
| Partial capture $40, `final_capture:false` | `POST /v2/payments/authorizations/{id}/capture` | 201 `COMPLETED` |
| Partial capture $30 | same | 201 `COMPLETED` |
| Capture $100 (total $170 > $150) | same | **201 `COMPLETED`** — PayPal accepted an over-capture on the capture that exhausted the authorization (standard over-capture tolerance) |
| Capture $5 more | same | 422 `AUTHORIZATION_ALREADY_CAPTURED` |
| Refund $40 | `POST /v2/payments/captures/{id}/refund` | 201 `COMPLETED` |
| Void after full capture | `POST /v2/payments/authorizations/{id}/void` | 422 `PREVIOUSLY_CAPTURED` |

**Conclusion for copy:** multiple partial captures against one authorization work. PayPal is the *outer bound*: once the authorization is used up, PayPal refuses any further capture; but PayPal tolerates an over-capture on the final capture, so the *exact* budget is enforced by the policy engine (and the rail), not by PayPal alone. Do not claim "PayPal will never release a cent more than you approved".

## Full app flow, PAYMENT_MODE=authorization, 2026-11-04

Local app (port 3170), Groq fallback answered (Gemini free quota exhausted).

| Step | Result | PayPal ID |
|---|---|---|
| Mandate drafted by AI, "Approve with PayPal" → sandbox login → approve → `/paypal/return` | mandate `active`, ledger `mandate.activated` | order `6MJ26114YR707232X`, authorization `7HM5124259979163R` |
| Agent: "Great, buy the Garden Party Botanical Gift Box Set." | purchase `charged` $40, remaining $110, no human approval | capture `6AP84428RM807671G` |
| Agent: "Return the last purchase" | purchase `refunded`, remaining $150 | refund `4LJ355186B2871324` |
| Revoke mandate (after a partial capture) | mandate `revoked`; PayPal GET authorization → `VOIDED` | — |

Verified: authorize, autonomous partial capture, agent refund, void after partial capture. Not separately re-verified in the app: per_purchase rail, webhooks, Agent Toolkit (not wired).

## Void matrix, direct REST, 2026-11-05

Why: conflicting evidence. On 11-04 the app voided after capture $40 → refund $40 (GET showed `VOIDED`). Today an app run with several partial captures, a refund of one, then a void got 422 `PREVIOUSLY_CAPTURED`. The 11-03 spike got the same 422 after a *full* capture.

Method: each case is its own Orders v2 `AUTHORIZE` order ($50–120), approved headless as the US sandbox buyer (`scripts/video/paypal.mjs`, as in `scripts/smoke.ts`), then `POST /v2/checkout/orders/{id}/authorize`. Every capture uses `final_capture:false` unless the step says otherwise. After every step: `GET /v2/payments/authorizations/{id}` → `status`. Script: a scratch Node script (`fetch` + puppeteer-core); keys from `.env` via `process.loadEnvFile`.

| Case | Order | Authorization | Step | HTTP | Result / issue | Authorization status after |
|---|---|---|---|---|---|---|
| a | `1HS9028480593712Y` | `50M68464HJ511443T` | authorize $60 | 201 | — | `CREATED` |
| a | | | void | 200 | `VOIDED` | `VOIDED` |
| b | `3P2018029S492383B` | `5SX92357F74875824` | authorize $80 | 201 | — | `CREATED` |
| b | | | capture $25 (`91342661BV4319347`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| b | | | void | 200 | `VOIDED` | `VOIDED` |
| c | `8E828139GV832120G` | `5BG86260D6513820B` | authorize $100 | 201 | — | `CREATED` |
| c | | | capture $40 (`1WA22947F9590900T`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| c | | | refund $40 (`6J4016810D480323C`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| c | | | void | 200 | `VOIDED` | `VOIDED` |
| d | `4Y027725AW452645B` | `49C64206TJ452390R` | authorize $120 | 201 | — | `CREATED` |
| d | | | capture $30 (`5AD913232S114331D`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| d | | | capture $20 (`3M4470033X784284N`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| d | | | void | 200 | `VOIDED` | `VOIDED` |
| e | `92N48717X70273945` | `5T599009KG661424B` | authorize $90 | 201 | — | `CREATED` |
| e | | | capture $30 (`6KW32925JV2704948`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| e | | | capture $1, **`final_capture:true`** (`79416870Y3189130N`) | 201 | `COMPLETED` | `CAPTURED` |
| e | | | void | 422 | `PREVIOUSLY_CAPTURED` | `CAPTURED` |
| f | `9F7757888X694711A` | `81Y75529MD848020F` | authorize $110 | 201 | — | `CREATED` |
| f | | | capture $30 (`98E101502L282311K`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| f | | | capture $20 (`06S80895N9006015P`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| f | | | refund $30 (`6GV29172CD243940T`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| f | | | refund $20 (`9H403992ES092373M`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| f | | | void | 200 | `VOIDED` | `VOIDED` |
| g | `36135758B8633322L` | `91796003MD077102D` | authorize $70 | 201 | — | `CREATED` |
| g | | | capture $30 (`32X022228S852804R`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| g | | | refund $10 of it (`5ES85595XM1684018`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| g | | | void | 200 | `VOIDED` | `VOIDED` |
| h | `45R57714MA0804049` | `40243283HS021415W` | authorize $100 | 201 | — | `CREATED` |
| h | | | capture $60 (`5AA45394YB880435K`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| h | | | capture $40 (`3RM94601T4957592U`), total = authorized | 201 | `COMPLETED` | `CAPTURED` |
| h | | | void | 422 | `PREVIOUSLY_CAPTURED` | `CAPTURED` |
| i | `9GL545032X568005G` | `0DT16945BT040312K` | authorize $100 | 201 | — | `CREATED` |
| i | | | capture $60 (`1B171135JW832114G`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| i | | | capture $39.99 (`2NU34431P4639852A`), $0.01 left | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| i | | | void | 200 | `VOIDED` | `VOIDED` |
| j | `2CU079643E598910L` | `059066328A515381T` | authorize $100 | 201 | — | `CREATED` |
| j | | | capture $50 (`96R7954201873123G`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| j | | | capture $30 (`81J96021FU383221Y`) | 201 | `COMPLETED` | `PARTIALLY_CAPTURED` |
| j | | | capture $20 (`4VD99499KV6886500`), total = authorized | 201 | `COMPLETED` | `CAPTURED` |
| j | | | refund the $30 capture (`78903893L0655853W`) | 201 | `COMPLETED` | `CAPTURED` |
| j | | | void | 422 | `PREVIOUSLY_CAPTURED` | `CAPTURED` |
| k | `51D577072K699845F` | `1X658646E8881152X` | authorize $50 (`brand_name` "Ribbon") | 201 | — | `CREATED` |
| k | | | capture $10, `soft_descriptor` "RIBBON GIFTS" (`09Y63564UP418822M`) | 201 | `COMPLETED` (GET capture does not echo the descriptor) | `PARTIALLY_CAPTURED` |
| k | | | refund $10, `note_to_payer` "Returned via Ribbon" (`22009657B0986961S`) | 201 | `COMPLETED`, note echoed | `PARTIALLY_CAPTURED` |
| k | | | void | 200 | `VOIDED` | `VOIDED` |

**The rule.** Void works (200, status `VOIDED`) whenever the captures add up to less than the authorized amount, after any number of partial captures and whatever was refunded (cases b, c, d, f, g, i, k). PayPal returns 422 `PREVIOUSLY_CAPTURED` only when the authorization is `CAPTURED`: the captures reached the authorized amount (h, j, and the 11-03 over-capture), or a capture used `final_capture:true` (e). Refunds never move a `CAPTURED` authorization back (j). This matches the Payments v2 reference: "You cannot void an authorized payment that has been fully captured", and status `CAPTURED` = "one or more captures against it", also when captures total more than the authorization. Today's 422 fits this rule: that run's captures must have reached the full authorized amount. That run's IDs were not available here (no reporting API access in the sandbox app), so this is inferred, not checked on its authorization.

**Releasing the remainder (question e).** After a partial capture, void itself is the supported way, and it works. The alternative, a last capture with `final_capture:true`, also closes the authorization, but it charges the buyer that amount, so Ribbon does not use it. The rail needs no change. On a 422, the rail now reports "nothing to void" only for `PREVIOUSLY_CAPTURED`, `PREVIOUSLY_VOIDED` and `AUTHORIZATION_EXPIRED`. Any other 422 is logged as a PayPal void failure. Revoke still runs in every case.

**Brand strings.** `soft_descriptor` "RIBBON GIFTS" is 12 characters; the Payments v2 schema sets `maxLength: 22`. The sandbox accepted it on a capture (case k).

### What Ribbon can truthfully say revoke does

Revoke takes spending power away in code at once: the gift list is marked revoked, pending approvals are rejected, and the policy engine refuses every later purchase, whatever PayPal answers. Ribbon then voids the PayPal authorization. If anything on it was never captured, which covers any list not spent to the last cent, PayPal voids it and releases the hold on the rest of the budget at once. This is verified in the sandbox after one or several partial captures and after refunds. PayPal refuses the void only when the captures already used up the whole authorization. Then no hold is left to release, and the ledger says "Nothing left on the PayPal authorization to void". Refunds are separate: they return money that was captured and never reopen a used-up authorization. Do not claim that revoke refunds purchases already made.
