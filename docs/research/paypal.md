# PayPal AI Hackathon: facts for an AI shopping agent with mandates

Researched: 2026-11-03. Method: WebFetch and WebSearch on developer.paypal.com, github.com, registry.npmjs.org, pypi.org, plus curl for registry checks.
Tags: **VERIFIED** = read on a primary source page; **SECONDARY** = third-party or search-snippet only; **UNVERIFIED** = could not confirm.
Where a fetch returned a summary rather than raw page text, the field names still need a check against the live reference before coding.

---

## 0. Bottom line

- **Vault-based autonomous charge in sandbox: plausible on paper, not proven.** The documented path is `POST /v3/vault/setup-tokens` (usage_type MERCHANT, customer_type CONSUMER) -> payer approves via `approve` link -> `POST /v3/vault/payment-tokens` -> later `POST /v2/checkout/orders` with `payment_source.paypal.vault_id`. The docs say payers need not be present for the later charge. Two gates are unresolved: (a) PayPal says the account must be "approved and configured for billing agreements" (contact account manager), and (b) whether a vault_id order completes without buyer approval. These must be tested in a spike before committing.
- **Most native PayPal agent tool:** the official **PayPal MCP server** (sandbox endpoint `https://mcp.sandbox.paypal.com`) or the **Agent Toolkit** (`@paypal/agent-toolkit` / `paypal-agent-toolkit`, both 1.11.0). Neither's documented tool list includes vault or payment-token tools, so the stored-wallet charge needs direct REST calls.
- **Agentic commerce services (Store Sync, Agent Ready) are not usable with a plain sandbox account.** They require a request form to PayPal's AI team.
- **AP2 (Agent Payments Protocol):** PayPal announced support on 2025-09-16. Its Intent Mandate (user pre-approves budget, categories, timing for human-not-present purchases) matches the user's mandate idea. PayPal's own post describes most of the implementation as potential, with no released API, SDK or sandbox for mandates.
- **Hackathon deadline conflict:** PayPal's blog says submissions close **Nov 12, 2026**; the user's brief says Nov 13. Today is Nov 3, so about 9 days remain. Check the Devpost page before planning.

---

## 1. Hackathon pages (what they recommend, link, and hint)

### 1.1 Access
- The user's URL `https://paypal-ai-hackathon.devpost.com/` returned **HTTP 404** to curl (also `/rules`), and **HTTP 403** to WebFetch. Source: Bash `curl -L` on the URL, 2026-11-03.
- `https://paypalaihackathon.devpost.com/` returned **403** to WebFetch. Devpost pages (/, /resources, /rules, /updates) could not be read directly. **UNVERIFIED:** resources list, rules, judging criteria, eligibility, team size, country limits.
- **Update 2026-11-05:** the official rules were read in the in-app browser at https://paypalaihackathon.devpost.com/rules (VERIFIED):
  - Submission period ends **Thu Nov 12, 2026, 12:00 pm PT** (= Nov 13, 01:00 GMT+5). Judging Dec 1–15; winners around Dec 21.
  - Stage 1 is pass/fail: fits the theme and applies the required APIs. Stage 2 has five equally weighted criteria. **Technological Implementation**: thorough use of the PayPal platform and AI, working and non-trivial. **Design**: a complete, coherent product, not a PoC. **Potential Impact**: a credible, specific case for a real audience. **Innovation/Idea**: "does the project differ from existing concepts?". **Presentation**: the video shows it working end to end, plus problem, audience and why it matters. Ties are broken in that order.
  - Video: under 3 minutes, public on YouTube, shows the project working. No third-party trademarks or copyrighted music without permission.
  - Repo: public, with an OSS license detectable in the GitHub About section. A hosted URL or setup instructions are required. Test credentials go in the testing instructions. Materials are in English.
  - Not open to residents of Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea or other OFAC-sanctioned places.
  - A project can win at most one Grand Prize (or Honorable Mention) plus one Sponsor Prize. Sponsor prizes: AG Grid ($5k/$2k/3×$1k), APIMatic, Bryntum, Channel3 ($1.5k), Render (credits).
  - Judges may score from the text, images and video alone, without running the app.
  - The project gallery was not published as of 2026-11-05.
- PayPal's blog says the "Get started here" link goes to `https://paypalaihackathon.devpost.com/`. Source: https://developer.paypal.com/community/blog/PayPal_AI_Hackathon (VERIFIED, read via WebFetch summary). Use this host unless Devpost says otherwise.

### 1.2 Dates (PayPal blog, published 2026-09-30)
- Submissions open: **Oct 1, 2026**. Close: **Nov 12, 2026** ("6-week build window"). Winners: **Dec 21, 2026**. Source: https://developer.paypal.com/community/blog/PayPal_AI_Hackathon
- The blog also says "now live through Nov 12, 2026". The user's brief says Nov 13. **UNVERIFIED** which is correct; a SECONDARY third-party guide (found via search, not fetched) also says Nov 13. Confirm on Devpost.

### 1.3 Prizes
- Best Overall: 1st $12,000, 2nd $8,000, 3rd $5,000.
- Honorable mentions, $5,000 each: Most Creative, Most Impactful, Best Demo Delivery, **Best Use of PayPal + AI**, **Best Use of Agentic Commerce**. Source: PayPal blog (above).
- Sponsor bonuses: AG Grid (1st $5,000, 2nd $2,000, 3rd 3x $1,000), APIMatic (3x $1,000), Bryntum (3x $1,000), Channel3 ($1,500), Render (1st $1,000 credits, 2nd $750, 3rd $500). Source: PayPal blog.
- Total prize figures conflict: "$60,000+" (PayPal blog), "$67,500+" (Internshala listing, SECONDARY), "$69,750" (promo box on the AG Grid boilerplate README, see 1.5). Use the Devpost page as the authority.
- Note: "Best Use of Agentic Commerce" is an honorable mention ($5,000), not a top-tier prize.

### 1.4 Requirements and judging
- Only fundamental requirement: "your project must meaningfully use both PayPal and AI." Source: PayPal blog.
- "There are no prescribed problem statements and no set of tracks." Source: PayPal blog.
- Judging criteria / scoring rubric: **UNVERIFIED** (not in the blog; Devpost not readable). Judges' roles (developer advocates, engineers, PMs) are from the user's brief, not verified.

### 1.5 Recommended resources and starter kits
- PayPal blog lists partners offering free credits: APIMatic (a "Context Plugin for giving AI agents PayPal context"), Render (Workflows for deploying agents), Kernel (cloud browsers for agents), Channel3 (product data API, 100M+ items), Postman, Astropods, Elastic, AG Grid, Bryntum. Source: PayPal blog.
- PayPal-owned starter: `https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate` (VERIFIED via WebFetch). A Next.js dashboard that reads PayPal sandbox data (products, plans, invoices, transactions, balances) over plain `fetch`, with an OpenAI-backed assistant route. Not an MCP server or an autonomous agent. Needs a sandbox REST app with "Transaction search" enabled. Its README promotes the hackathon with "Win part of $69,750 in total prizes" and links https://paypalaihackathon.devpost.com.
- PayPal AI Toolkit plugin (developer tool, not a runtime agent component): `https://github.com/paypal/AI-Toolkit` (VERIFIED via WebFetch). See section 2.4.
- Hackathon hints about what judges want: **UNVERIFIED** (no source found beyond "meaningfully use both PayPal and AI").

---

## 2. PayPal agentic-commerce developer offerings

### 2.1 Agent Toolkit
- npm: `@paypal/agent-toolkit`, **1.11.0** (registry: https://registry.npmjs.org/@paypal/agent-toolkit/latest, VERIFIED via curl). Requires Node.js 18+. Subpath imports include `/ai-sdk` and `/bedrock`, plus `/mcp`.
- PyPI: `paypal-agent-toolkit`, **1.11.0**, requires Python >=3.11 (https://pypi.org/pypi/paypal-agent-toolkit/json, VERIFIED via curl). Python imports: `paypal_agent_toolkit.langchain.toolkit`, `.openai.toolkit`, `.crewai.toolkit`, `paypal_agent_toolkit.shared.configuration` (`Configuration`, `Context`).
- Repo: https://github.com/paypal/agent-toolkit (VERIFIED via WebFetch summary; 183 commits on main).
- Frameworks: OpenAI Agents SDK, LangChain, Vercel AI SDK (`@paypal/agent-toolkit/ai-sdk`), CrewAI, Amazon Bedrock, MCP. Source: https://developer.paypal.com/ai-tools/toolkit.md (VERIFIED via WebFetch). Works with "LLM providers that support function calling".
- **Gemini: not listed** in PayPal's toolkit docs. Google ADK is only reachable indirectly via MCP (`McpToolset`). A community demo exists (mcp.so, SECONDARY). Official ADK example: UNVERIFIED.
- Tools (43 total per the GitHub README summary, VERIFIED via WebFetch summary of https://github.com/paypal/agent-toolkit):
  - Payments (5): `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`.
  - Invoices (20): `create_invoice`, `send_invoice`, `record_payment_for_invoice`, `record_refund_for_invoice`, etc.
  - Disputes (3), Shipment tracking (3), Catalog (3), Subscriptions (7), Reporting (2).
  - **No vault / payment-token / setup-token tools appear in the list.**
- Sandbox: `PAYPAL_ENVIRONMENT=SANDBOX` (default), or `configuration: { context: { sandbox: true } }` in TypeScript, `Context(sandbox=True)` in Python. Sources: GitHub README, developer.paypal.com/ai-tools/toolkit.md.
- Credentials: env names conflict between sources. The toolkit page lists `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`; its Vercel code reads `PAYPAL_CLIENT_SECRET`. Check the code before copying.

### 2.2 PayPal MCP server
- Remote, sandbox: `https://mcp.sandbox.paypal.com` with `/sse` (SSE) or `/http` (Streamable HTTP). Production: `https://mcp.paypal.com/sse` or `/http`. Source: https://developer.paypal.com/ai-tools/mcp-server.md (VERIFIED via WebFetch).
- A third-party registry lists production as `https://mcp.paypal.com/mcp`. **UNVERIFIED** against PayPal docs; treat as incorrect until checked.
- Auth, two options (VERIFIED via same page): (1) browser login via `mcp-remote`; (2) `Authorization: Bearer <...>` built from Developer Dashboard client ID and secret. The exact header encoding is **UNVERIFIED**.
- Local: npm `@paypal/mcp`, version **1.8.1** (registry, VERIFIED via curl). Run: `npx -y @paypal/mcp --tools=all`. Requires Node 18+. Env: `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX|PRODUCTION`.
- Tool catalog: the PayPal page does not name tools. The AI Toolkit README lists MCP tool areas: orders and payments, invoices, subscriptions, disputes, catalog, shipment, reporting (SECONDARY to the MCP page). **No vault tools listed.** Exact count: UNVERIFIED (sources conflict).
- Clients: PayPal examples use Claude Desktop; the page says "any MCP client ... such as Cursor or Cline". Claude Code-specific setup: **UNVERIFIED**.
- Known issue per PayPal page: "Windows users with Cursor might encounter a known issue when connecting to the MCP server remotely." Fix suggested: `rm -rf ~/.mcp-auth`.

### 2.3 Agentic commerce services, Store Sync, Agent Ready
- Source: https://developer.paypal.com/agentic-commerce-services/about.md (VERIFIED via WebFetch).
- Access: "Merchants must submit a request form to reach PayPal's AI team, which then follows up with onboarding." Form link: https://www.paypal.ai/us/home#form. Sandbox availability: **not stated**. Regions: **not stated**.
- Store Sync: makes products discoverable to AI assistants; orders go into existing OMS.
- Agent Ready: accept payments from AI assistants with minimal change to existing setup; "supporting both supervised and automatic shopping scenarios." Overview: `/agent-ready/overview` (not fetched).
- Conclusion: **not usable with a plain sandbox account**. Treat as out of scope for the hackathon.

### 2.4 PayPal AI Toolkit (Claude Code plugin)
- Repo: https://github.com/paypal/AI-Toolkit (VERIFIED via WebFetch). Plugin for Claude Code, OpenAI Codex, Cursor. Includes skills, slash commands, and a sandbox MCP connection.
- Install: `/plugin install paypal@claude-plugins-official` (Claude Code marketplace); or `claude --plugin-dir /path/to/AI-Toolkit`.
- Connects to the sandbox MCP server over SSE at `/sse`. Token: `curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token -u "CLIENT_ID:CLIENT_SECRET" -d "grant_type=client_credentials"`. Tokens expire in up to 8 hours.
- Commands: `/paypal:doctor`, `/paypal:explain-error`, `/paypal:sandbox`, `/paypal:setup`, `/paypal:test-accounts`.
- This is a development-time tool for the coder, not part of the runtime agent.

### 2.5 AP2 (Agent Payments Protocol) and mandates
- PayPal post dated 2025-09-16: https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/ (VERIFIED via WebFetch summary). AP2 is "an open, interoperable extension to Agent2Agent (A2A) protocol and the Model Context Protocol (MCP)." Google proposed it with PayPal and others.
- Mandate types, all "expressed as W3C Verifiable Credentials":
  - **Cart Mandate (Human-Present):** merchant and user both sign the cart.
  - **Intent Mandate (Human-Not-Present):** user pre-approves "limits such as budget, product categories, or timing, which lets an agent buy later." This matches the user's mandate.
  - **Payment Mandate:** minimal credential derived from Cart or Intent Mandate, attached to authorization, signals agent presence to issuers and networks.
- Implementation status per PayPal: mostly "potential, not shipped". "Payment Mandate pilots" listed as an opportunity. No released API, SDK or sandbox named. Developers could "use PayPal SDKs and APIs to capture mandates" is listed as a future opportunity.
- Google AP2 reference: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol (link from PayPal post). Spec repo: `github.com/google-agentic-commerce/AP2` (SECONDARY, from a search snippet; not fetched).
- Practical reading: implement the mandate yourself as a signed JSON (or VC-shaped) object checked by your agent service, and cite AP2's Intent Mandate concept. Do not claim PayPal-enforced mandates in sandbox.

### 2.6 Other items
- Google AP2 governance (donation to FIDO Alliance, April 2026): SECONDARY, single source, **UNVERIFIED**.

---

## 3. Feasibility in sandbox: saved PayPal wallet and later charge

### 3.1 Option A (recommended path to test): Payment Method Tokens v3 (no purchase)
Source: https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal.md (VERIFIED via WebFetch summary, sandbox URLs shown).

1. **Create setup token**
   - `POST https://api-m.sandbox.paypal.com/v3/vault/setup-tokens`
   - Headers: `Authorization: Bearer ACCESS-TOKEN`, `Content-Type: application/json`, `PayPal-Request-Id: <unique>`.
   - Body fields: `payment_source.paypal.usage_pattern: "IMMEDIATE"`, `payment_source.paypal.usage_type: "MERCHANT"`, `payment_source.paypal.customer_type: "CONSUMER"`, `payment_source.paypal.permit_multiple_payment_tokens: false`, `payment_source.paypal.experience_context.return_url`, `...cancel_url`, optional `payment_method_preference`, `shipping_preference`, `brand_name`, `locale`. Optional `customer.id` for returning payer (location in body UNVERIFIED).
   - Response: HTTP 200 or 201, `status: "PAYER_ACTION_REQUIRED"`, `id` (setup token), `customer.id`, `links` with `approve` (GET), `confirm` (POST), `self` (GET).
2. **Payer approval:** send the payer to the `approve` URL (PayPal-hosted). Return to `return_url` or `cancel_url`. Setup tokens expire after 3 days by default.
3. **Create payment token**
   - `POST https://api-m.sandbox.paypal.com/v3/vault/payment-tokens`
   - Body: `{"payment_source": {"token": {"id": "<SETUP_TOKEN_ID>", "type": "SETUP_TOKEN"}}}`
   - Response: payment token `id`, `customer.id`, `payment_source.paypal.payer_id`, `email_address`; links `self`, `delete`.
4. **Charge later**
   - `POST https://api-m.sandbox.paypal.com/v2/checkout/orders`
   - Body: `{"intent": "CAPTURE", "purchase_units": [{"amount": {"currency_code": "USD", "value": "100.00"}}], "payment_source": {"paypal": {"vault_id": "<PAYMENT_TOKEN_ID>"}}}`
   - Source for the body: https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/ (VERIFIED via WebFetch summary; `.md` URL returned 406).
   - The page says "Payers don't need to be present when charged." and for off-session charges, "When the payer isn't present to check out" the order can be created on the payer's behalf.
   - To look up tokens: `GET https://api-m.sandbox.paypal.com/v3/vault/payment-tokens?customer_id=<CUSTOMER_ID>`.
   - Whether the vault_id order returns `COMPLETED` or `PAYER_ACTION_REQUIRED` with no buyer present: **UNVERIFIED**. Test in sandbox.
   - `PayPal-Client-Metadata-Id` appears in a sample header but is not stated as required; the step-4 sample omits it.
   - `stored_credential.payment_initiator: "MERCHANT"` is documented in the Orders schema for `payment_source.paypal.stored_credential` (see 3.4). Whether vault_id charges need it: **UNVERIFIED**.
5. **Sandbox setup (VERIFIED on same page):** Developer Dashboard > Sandbox App Settings > App Feature Options: check **Accept payments**; under Advanced options, confirm **Vault** is selected.
6. **Account gate (VERIFIED, important):** "Your account must be approved and configured for billing agreements. Contact your account manager." Eligibility check: Account Settings > Payment Preferences > "Save PayPal and Venmo payment methods" (Success / Need more information / Denied). Whether a self-serve sandbox account passes automatically: **UNVERIFIED**.
7. Webhooks for vault events: `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`, `VAULT.PAYMENT-TOKEN.DELETION-INITIATED`.

### 3.2 Option B: save during purchase (Orders v2 with vault)
Source: https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/orders-api/paypal/ (VERIFIED via WebFetch summary; page "Last updated: October 14, 2026" per search snippet).
- `POST https://api-m.sandbox.paypal.com/v2/checkout/orders` with `payment_source.paypal.attributes.vault.store_in_vault: "ON_SUCCESS"`, `...vault.usage_type: "MERCHANT"`, and `experience_context` (return_url, cancel_url). Buyer approval happens via the order's `approve` link (PAYER_ACTION_REQUIRED).
- Vault status: `VAULTED` (vault `id` returned) or `APPROVED` (paid but not saved; page says a `confirm-payment-token` link lets you finish within 3 hours, per the older vault page). The vault id may only appear after authorize/capture; then use webhook `VAULT.PAYMENT-TOKEN.CREATED`.
- Conflicting line on the same page: "Don't save PayPal as a payment method during purchase." **UNVERIFIED** which applies.
- Older Vault v2 guide (limited release, pilot for select merchants): https://developer.paypal.com/limited-release/vault-payment-methods/orders-api.md (VERIFIED via WebFetch summary). States "limited-release solution available to select merchants and partners as a pilot"; requires approval for PayPal Billing Agreements; for PayPal wallets the page says "the buyer needs to be present" to authenticate the account when vaulting (this concerns vaulting, not later charges). Vault v3 is available in the United States; v2 tokens work with it.
- Search snippet (SECONDARY): vault_id is returned after authorize/capture only.

### 3.3 Option C: billing agreements
- The Payment Method Tokens page says PayPal wallets need billing agreement approval (see 3.1 item 6). A separate `payment_source.token` of type `BILLING_AGREEMENT` exists in the Orders schema. Dedicated billing-agreement flow: **UNVERIFIED** (not fetched).

### 3.4 Orders v2 schema for `payment_source.paypal`
Source: https://developer.paypal.com/api/orders/v2/definitions/payment_source (VERIFIED via WebFetch summary; caveat: summary was truncated after `eps`, so verify against schema.json).
- Properties: `vault_id`, `email_address`, `name`, `phone`, `birth_date`, `tax_info`, `address`, `attributes` (`customer`: id, email_address, phone, name, merchant_customer_id; `vault`: store_in_vault, description, usage_pattern, shipping, usage_type, customer_type, permit_multiple_payment_tokens), `experience_context`, `billing_agreement_id`, `stored_credential`.
- `payment_source.paypal.stored_credential`: `payment_initiator` (required): `CUSTOMER` | `MERCHANT`; `usage` (optional): `FIRST` | `SUBSEQUENT` | `DERIVED`; `payment_type` absent for PayPal (present for card only); `usage_pattern` and `charge_pattern` (deprecated) also listed.
- Card's `stored_credential` additionally has `payment_type` (`ONE_TIME` | `RECURRING` | `UNSCHEDULED`) and `previous_network_transaction_reference`.
- Schema JSON/YAML: `https://developer.paypal.com/api/orders/v2/schema.json`, `https://developer.paypal.com/api/orders/v2/schema.yaml` (per the Orders v2 index page).

### 3.5 Verdict for the autonomous agent flow
- **Working path to prove in sandbox (about 1 hour spike):** setup-token -> approve -> payment-token -> `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` -> `POST /v2/checkout/orders/{id}/capture`. Record whether the order needs buyer approval. If it does, the "no buyer present" autonomy claim fails for PayPal wallets and you need a card-vault variant or a human-present approval step per purchase.
- Blockers to check first: the billing-agreement / reference-transaction approval; "Accept payments" and "Vault" feature flags on the sandbox app.

---

## 4. Other sandbox APIs (one line each)

- **Orders v2:** `POST /v2/checkout/orders` (create), `GET /v2/checkout/orders/{id}`, `PATCH /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/authorize`, `POST /v2/checkout/orders/{id}/capture`. Source: https://developer.paypal.com/api/orders/v2/ (VERIFIED).
- **Refunds:** `POST /v2/payments/captures/{capture_id}/refund` (empty body = full refund; `amount` object = partial), `GET /v2/payments/refunds/{id}`. Source: https://developer.paypal.com/api/payments/v2/captures-refund.md (search result; VERIFIED via search snippet). Headers: `PayPal-Request-Id`; `PayPal-Auth-Assertion` required in live.
- **Payouts (v1):** `POST /v1/payments/payouts` (`sender_batch_header`, `items`), `GET /v1/payments/payouts/{id}`. Source: https://developer.paypal.com/api/payments.payouts-batch/v1.md (search snippet; VERIFIED via snippet). Reuse of `sender_batch_id` within 30 days is rejected as duplicate.
- **Invoicing v2:** `POST /v2/invoicing/invoices` (draft), `POST /v2/invoicing/invoices/{id}/send`. Source: https://developer.paypal.com/api/invoicing.md (search snippet; VERIFIED via snippet). Send-body flags conflict between docs (`send_to_recipient` vs `send_to_invoicer` only): UNVERIFIED.
- **Webhooks:** subscribe in the Developer Dashboard. Vault events above. Simulator (dashboard): enter listener URL, pick sample event, "Send Test". Source: https://developer.paypal.com/api/rest/webhooks/simulator.md (VERIFIED via WebFetch summary). Simulated events are not tied to an app, do not appear in the event viewer, cannot be resent, and cannot be verified via verify-webhook-signature. API-based trigger `POST /v1/notifications/simulate-event` appears only on docs.paypal.ai (SECONDARY): UNVERIFIED on developer.paypal.com.
- **Shipment tracking v1:** `POST /v1/shipping/trackers` (single tracker), `GET /v1/shipping/trackers/{id}`, `PUT /v1/shipping/trackers/{id}`. The batch route `POST /v1/shipping/trackers-batch` is marked deprecated in the schema. OAuth scope: `https://uri.paypal.com/services/shipping/trackers/readwrite`. Source: https://developer.paypal.com/api/tracking/v1/schema.yaml (search snippet; VERIFIED for path names via snippet; request body fields UNVERIFIED).

---

## 5. Sandbox gotchas and account questions

- **Sandbox base URLs:** `https://api-m.sandbox.paypal.com` (REST), token at `/v1/oauth2/token`. Sandbox web: `https://www.sandbox.paypal.com/`. Sources: toolkit page, AI Toolkit README, payouts page (all VERIFIED).
- **Sandbox accounts (VERIFIED):** from https://developer.paypal.com/sandbox-testing/accounts.md:
  - Personal (buyer) and business (seller) account types. Select account type, then country.
  - PayPal creates a default personal and a default business account; the default business account carries sandbox API credentials; Default accounts cannot be deleted.
  - Cloning copies type, name and balance (not password or Pro status).
  - Each sandbox account can link to only 1 developer account at a time. You cannot duplicate an account that failed during creation.
  - Bulk upload exists (CSV with country code and account type; details not fetched).
- **Sandbox limitations (VERIFIED):** "some PayPal features do not apply to the sandbox, such as closing an account, issuing monthly statements, storing shipping preferences, and PayPal Shops support." Source: https://developer.paypal.com/api/rest/sandbox/ (summary; the page does not list the sandbox base URL, which comes from other pages).
- **Kazakhstan:**
  - Official sandbox country restrictions: **none found** in the accounts page (country selection exists; no list shown).
  - Official PayPal Kazakhstan availability: **UNVERIFIED**. The PayPal KZ country page (`https://www.paypal.com/kz/webapps/mpp/country-worldwide`) returned only its title to WebFetch.
  - SECONDARY, third-party guides (Kazakh finance sites, zenind, doola; some sell company formation): personal accounts for individuals and business accounts for legal entities or sole proprietors can be opened from KZ. Not official; UNVERIFIED.
  - SECONDARY, one Kazakh news item reports the Ministry of Culture blocked the PayPal website over cryptocurrency content (date not shown). Relevance: UNVERIFIED.
  - Vault country list: the Payment Method Tokens / Orders vault pages list Canada, US, China, Hong Kong, Japan, Singapore, Australia and "a long list of European countries" (VERIFIED via WebFetch summaries). Kazakhstan is **not in the summary list**, but the list was not complete in the summary: UNVERIFIED whether KZ is eligible for vault. This is the biggest country risk for a KZ-based developer.
- **Feature enablement:** sandbox app needs "Accept payments" and "Vault" (see 3.1 item 5). Transaction search feature needed for transaction and balance reads (AG Grid boilerplate README, SECONDARY to PayPal).
- **Tokens:** sandbox OAuth tokens last about 3 to 8 hours (toolkit page, AI Toolkit README). Refresh before expiry.
- **Mixed host risk:** docs.paypal.ai redirects to developer.paypal.com/docsai/, which returned 404 to WebFetch. Prefer developer.paypal.com pages.
- **Risk Data Acquisition:** for customer-initiated transactions using PayPal or Venmo tokens, use the FraudNet and Magnes libraries or attempts may be declined (Orders v2 vault page; VERIFIED summary). Merchant-initiated charges: UNVERIFIED whether RDA applies.

---

## 6. Most "native" PayPal agent tool (recommendation for this project)

- **PayPal MCP server (sandbox)** or **Agent Toolkit** are the official agent-tool surfaces. The MCP server is the most vendor-native if the agent is built on an MCP-capable runtime (Claude, Cursor, Cline). Agent Toolkit fits LangChain, OpenAI Agents SDK, Vercel AI SDK, CrewAI, Bedrock.
- Neither exposes vault tools. Use direct REST for the Payment Method Tokens v3 flow and call `POST /v2/checkout/orders` with `vault_id`. Keep the mandate check (budget, categories, expiry) in your own service and map it to AP2's Intent Mandate concept.
- Do not promise Store Sync or Agent Ready in the demo; they need PayPal AI team approval.

---

## 7. UNVERIFIED list (summary)

1. Devpost resources, rules, judging criteria, eligibility, country limits (Devpost returned 403/404).
2. Deadline: Nov 12 (PayPal blog) vs Nov 13 (brief and secondary guides).
3. Prize total: $60k+ vs $67.5k+ vs $69.75k.
4. MCP production URL path: `/http` or `/mcp`.
5. MCP Bearer header encoding and Claude Code connection steps.
6. Whether a vault_id order completes without buyer approval; whether `stored_credential.payment_initiator: "MERCHANT"` is needed.
7. Whether self-serve sandbox accounts pass the billing-agreement / reference-transaction approval.
8. Kazakhstan: PayPal official availability; vault eligibility.
9. Invoicing send flags (`send_to_recipient` vs `send_to_invoicer`).
10. Webhook simulator API endpoint on developer.paypal.com.
11. Shipment tracking request body fields.
12. Gemini / Google ADK official support in PayPal's toolkit: not listed.
13. AP2 governance (FIDO Alliance donation): single secondary source.
14. Version and package names for PyPI `paypal-agent-toolkit` extras: only 1.11.0 checked.

---

## 8. Key URLs

- https://paypalaihackathon.devpost.com/ (403 to WebFetch)
- https://paypal-ai-hackathon.devpost.com/ (404 via curl)
- https://developer.paypal.com/community/blog/PayPal_AI_Hackathon
- https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate
- https://developer.paypal.com/ai-tools/toolkit.md
- https://developer.paypal.com/ai-tools/mcp-server.md
- https://github.com/paypal/agent-toolkit
- https://github.com/paypal/AI-Toolkit
- https://registry.npmjs.org/@paypal/agent-toolkit/latest
- https://registry.npmjs.org/@paypal/mcp/latest
- https://pypi.org/pypi/paypal-agent-toolkit/json
- https://developer.paypal.com/agentic-commerce-services/about.md
- https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/
- https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal.md
- https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/
- https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/orders-api/paypal/
- https://developer.paypal.com/limited-release/vault-payment-methods/orders-api.md
- https://developer.paypal.com/api/orders/v2/definitions/payment_source
- https://developer.paypal.com/api/orders/v2/
- https://developer.paypal.com/api/rest/webhooks/simulator.md
- https://developer.paypal.com/sandbox-testing/accounts.md
- https://developer.paypal.com/api/rest/sandbox/
- https://developer.paypal.com/api/payments/v2/captures-refund.md
- https://developer.paypal.com/api/payments.payouts-batch/v1.md
- https://developer.paypal.com/api/invoicing.md
- https://developer.paypal.com/api/tracking/v1/schema.yaml
- https://www.paypal.com/kz/webapps/mpp/country-worldwide (title only)
