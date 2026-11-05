# Impact numbers for Ribbon (2026-11-05)

Scout report. Each URL was opened unless it is marked otherwise.

| Fact | Number | Source | Status |
|---|---|---|---|
| Holiday spending per person, 2025 season | $890.49 total, of which **$627.93 on gifts** for family and friends | NRF/Prosper, Oct 16, 2025: https://nrf.com/media-center/press-releases/consumers-to-spend-second-highest-amount-on-record-according-to-nrf-holiday-survey | verified |
| Holiday debt | **37%** of U.S. consumers took on holiday debt; average **$1,223** | LendingTree study, as reported by Wharton Baker Retailing Center, Jan 8, 2026: https://bakerretail.wharton.upenn.edu/?p=9765 (the LendingTree primary page returned 403) | verified via secondary |
| AI in holiday shopping | Generative-AI traffic to U.S. retail sites **+693.4%** YoY, Nov 1–Dec 31, 2025 | Adobe Analytics, Jan 7, 2026: https://news.adobe.com/news/2026/01/adobe-holiday-shopping-season | verified |
| 2026 season | Nov–Dec spending forecast $1.013T, +4.2% | NRF, Oct 20, 2026: https://nrf.com/media-center/press-releases/affordability-shapes-winter-holiday-shopping-according-to-nrf-holiday-survey | verified (no per-person figure) |

Do not use:
- Number of recipients or gifts per shopper (not found in a primary source).
- NerdWallet 15% / 56% (snippet only).
- Adobe conversion and revenue-per-visit numbers (conflicting, unverified).
- Gallup $1,007.

## Batch 2 (2026-11-05, second scout)

Verified: the URL was opened and the figure read on it.

| Fact | Number | Source |
|---|---|---|
| PayPal's own survey: AI in shopping | **40%** of Americans used AI to help with a purchase in the past year (counts include people who considered it); Gen Z 61%. 77% of AI shoppers plan to use AI for holiday shopping. Top uses: deals 34%, comparing 30%, gift ideas 26% | PayPal / Talker Research, n=1,000 US, Oct 22, 2025: https://newsroom.paypal-corp.com/2025-10-22-From-AI-to-BNPL,-PayPal-Survey-Reveals-How-Merchants-Can-Win-the-Holidays |
| People want a check before an agent pays | **71%** want to review purchases before checkout; **76%** name fraud and unauthorized charges as their top concern; 28% would let AI buy automatically | Nuvei, n=1,000 US, 2025: https://www.nuvei.com/agentic-commerce/research |
| Comfort with agents buying | 48% comfortable, **52% not**; reason #2 for using an agent is "helping me budget and avoid overspending" (30%); #1 is best price (33%) | Checkout.com, n=4,000, Dec 8, 2025: https://www.checkout.com/blog/what-consumers-expect-agentic-commerce |
| Agents' future share of spending | Consumers expect **15%** of purchases to be made by AI agents within 5 years (9% a year earlier); 69% would let an agent spend up to $100 on essentials; 42% worry about wrong purchases; 33% want to approve every transaction | Global Payments / Worldpay, n=8,027, Sept 23, 2026 (via the finviz mirror; Business Wire returned 403): https://finviz.com/news/394701/consumers-expect-ai-to-make-15-of-their-purchases-within-five-years-global-payments-research-finds |
| Holiday returns | **~17%** of holiday sales returned (consistent with prior years, not a record); $849.9B total returns in 2025; 9% of returns fraudulent | NRF + Happy Returns, Oct 15, 2025: https://nrf.com/media-center/press-releases/consumers-expected-to-return-nearly-850-billion-in-merchandise-in-2025 |
| Fraud context | $15.9B reported fraud losses in 2025, ~3M reports | FTC, March 2026: https://www.ftc.gov/news-events/news/press-releases/2026/03/ftc-testifies-joint-economic-committee-agencys-efforts-combat-fraud |
| Prompt injection research | AP2-based shopping agent reliably subverted by simple prompts (qualitative) | arXiv 2601.22569, Jan 30, 2026 |
| Prompt injection research | 3,168 attacked runs on web shopping agents; "no attack objective is reliably resisted" | arXiv 2606.13385, June 11, 2026 |

Secondary only; do not cite as verified:
- FTC online-shopping losses of $446.4M (via Experian).
- FBI IC3 non-delivery losses of $503.4M.
- Riskified: 55% not comfortable.
- Spreedly: 40% fear overspending.
- Appriss: $100B returns fraud.
- Visa: 47%.

Corrections, do not repeat: Unit 42 has no measured test numbers. The 17% holiday return rate is not a "record". The Checkout.com top reason is best price, not overspending.

## PayPal 2026 Holiday Shopping Survey (verified, opened in the in-app browser)

PayPal / Morning Consult, n=2,005 US adults, Sept 2–4, 2026, ±2 pts. Published Sept 30, 2026: https://newsroom.paypal-corp.com/2026-09-30-PayPal-Survey-Reveals-Holiday-Spending-Isnt-Slowing-Down,-But-Shoppers-Are-Changing-How-They-Spend
- **58%** feel greater financial concern heading into the holidays, yet 64% expect to spend the same or more.
- **"Setting and sticking to a budget (36%)"** is the top way consumers plan to manage holiday spending.
- **63%** would spend hours searching online for the perfect gift; 70% would visit multiple stores.
- 57% say BNPL would help manage the cost of gifts for several people.
- Top gift categories: clothing 52%, toys and games 38%, beauty 32%.

## Pitch shortlist (strongest for PayPal judges)

0. **PayPal's own 2026 survey: "setting and sticking to a budget" is shoppers' #1 holiday plan (36%), and 63% would spend hours hunting for the perfect gift.** Ribbon does both: it hunts, and it sticks to the budget per person in code.

1. "Americans spend about $628 each on holiday gifts, and 37% end up in holiday debt." (NRF 2025; LendingTree)
2. "PayPal's own survey: 40% of Americans already use AI to help them buy." (PayPal, Oct 2025)
3. "71% want to review a purchase before an agent pays; 76% fear unauthorized charges." (Nuvei 2025). This answers why Ribbon has envelopes plus ask-me-first.
4. "About 17% of holiday purchases come back." (NRF 2025). This supports the agent-initiated refund.
5. "Researchers: no prompt-injection objective is reliably resisted by web shopping agents." (arXiv 2606.13385). This is why limits live in code.
