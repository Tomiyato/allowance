# Competition and prior art (2026-11-05)

Sources: the Devpost project search, run in the in-app browser through `devpost.com/software/search.json`; the Writ project page, read in full; the official rules at paypalaihackathon.devpost.com/rules; and two scout reports covering the open web, GitHub, AP2, PayPal, Visa, Mastercard, Stripe and Coinbase. The hackathon gallery was not published yet, so this list is only what Devpost search returns. It is not the full field.

## Same hackathon, same idea (all submitted to PayPal AI Hackathon)

Name collision. Four other entries are called Allowance, and three of them use nearly our tagline:
- **Allowance** by JEAN REGIS (devpost.com/software/allowance-2bev3y): "Give your AI agent an allowance, not your wallet." Gemini turns plain English into a mandate with budget, categories, suppliers, quantity caps and an auto-approve threshold. A PayPal Braintree authorization hold covers the budget. Gemini proposes the cart and a firewall checks it. Built with AG Grid, Render and Next.js. This is almost the same product as ours.
- **Allowance** by Bon Brian (allowance-wi2ldj): a family caregiver's shopping agent. Uses Channel3, Orders v2, Vault and Render.
- **Allowance**: "Set rules once; Allowance pays small stuff via PayPal, holds the money…"
- **Allowance**: "gives AI shopping agents a PayPal-backed budget…"
- **Agent Allowance**: a supplier payment desk on PayPal Payouts.

Mandate plus policy engine plus injection defence, with the same thesis:
- **Writ** (team of 3): a signed mandate with weekly budget, caps, co-sign threshold, velocity limits and allowed suppliers and categories. A CEL policy engine; a Postgres CHECK constraint that makes overspend impossible; single-use Ed25519 capabilities; a hash-chained audit log. Vault and Orders v2, Payouts, webhooks, A2A supplier agents, Channel3, AG Studio and Render. In its demo a compromised agent's $4,800 payment is denied. Their "What's next" lists plain-language mandates, which we already have.
- **Leash**: plain-English rules, Vault for in-policy buys, phone approval, injection in a product listing.
- **Mandat**: a passkey-signed mandate; code refuses; a sealed receipt for disputes.
- **Mandate**: limits, approvals, hash-chained audit, MCP.
- **Gofer**: a server-enforced mandate.
- **CartHold**: a payment-hold firewall; Gemini shops, PayPal holds.
- **SentinelPay**: per-transaction and daily caps, category allowlists, Vault, Gemini.
- **AgentPurse**: per-agent wallets, plain-word rules, Payouts.
- **DYNASTY GUARD**: a four-layer firewall including an injection scanner; AG Grid, Channel3, Gemini 3 Flash.
- **PayPal Agent Shield**: Ed25519 mandates, AP2.
- **AP2 Autonomous Commerce**: SD-JWT budgets under AP2 v0.2.
- **Tiktatoe**, **Agent Checkout Steward** and **Balance AI**.
- **Stash** (kids shop and parents control the cash) and **CartPilot** (shopping agent inside a limit).

Adjacent ideas that are also taken:
- **Procureo**: waits for the right price and buys.
- **Potluck**: friends pool money all-or-nothing.
- **Hold**: a rental deposit as a PayPal hold.
- **Remindify**, **dareskro**, **PayPlan** and **Handshake**: authorization holds released on proof.
- **Matchback**: price-match refunds.
- **Panier Famille**: diaspora family basket.
- **JUNCO**: disputes.

Outside Devpost: the open-source Agentic Guardrail repo (Agnuxo1, same hackathon). SpendShield, Spendpol, Sentinel, agent-wallet and Forge Agent Gate all use allow / needs_approval / deny engines. Tollbooth uses an Orders v2 AUTHORIZE hold for metered API sessions.

## Industry (scout report)

- Scoped, expiring, revocable, amount-capped agent credentials are standard thinking: Google AP2 (FIDO since 2026-04, v0.2, SD-JWT open and closed Checkout and Payment mandates), Stripe Shared Payment Tokens (usage_limits.max_amount, expires_at, revoke), OpenAI/Stripe ACP (a single-use allowance object), Visa Intelligent Commerce, Mastercard Agent Pay and Coinbase spend permissions.
- PayPal's public material (agentic commerce services 2025-10-28, Agent Toolkit, MCP server) describes no buyer-side spending limits for agents. The Agent Toolkit has no authorize, capture or void tools.
- Prompt-injection evidence: arXiv 2601.22569 ("Whispers of Wealth", AP2 shopping agent; injected product ranked first 10/10) and Unit 42 "Retail fraud in the age of agentic AI" (a hidden gift-card line item; the latter read from search excerpts only).

## Conclusion

The core concept is one of the most common entries in this hackathon. Our name and tagline are taken. The Innovation criterion ("does the project differ from existing concepts?") will score low unless we change the angle. AP2 alignment is also already done by several entries, so it is no differentiator by itself.
