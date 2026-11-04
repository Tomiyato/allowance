# PayPal sandbox — verified results (2026-11-03/04)

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
