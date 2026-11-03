# AI stack research (as of 2026-11-03)

Scope: Gemini API (primary LLM), free fallbacks, Channel3, Render, AG Grid for the PayPal AI hackathon.
Legend: **UNVERIFIED** = not confirmed from a primary source in this session. Pages fetched through a summarizing tool may paraphrase; re-check the key items in a browser before depending on them.

---

## 0. Hackathon facts (affects all sections)

- Official Devpost URLs `https://paypal-ai-hackathon.devpost.com/` and `https://paypalaihackathon.devpost.com/` returned HTTP 403 to the fetch tool. Partner and prize data below comes from the PayPal developer blog: https://developer.paypal.com/community/blog/PayPal_AI_Hackathon
- **Deadline conflict:** blog says submissions close **Nov 12, 2026** (and winners Dec 21, 2026). A third-party aggregator says Devpost closes Nov 12, 2026 3:00 PM EST. The brief said Nov 13. Treat **Nov 12** as the working deadline until confirmed on Devpost.
- **Prize total conflict:** blog says "$60,000+" main prizes; a search snippet says $67,500 total (UNVERIFIED which is current).
- Only stated eligibility rule: "your project must meaningfully use both PayPal and AI." Blog says the partners offer "free credits to help you build," but lists **no amounts and no API keys** (UNVERIFIED whether any sponsor credits are actually available to you).
- Sponsor bonus prizes (blog):
  - Best Use of Channel3: $1,500
  - Best Use of Render: 1st $1,000 in Render Credits, 2nd $750, 3rd $500
  - Best Use of AG Grid: 1st $5,000, 2nd $2,000, 3rd x3 $1,000 each
  - Also APIMatic x3 ($1,000 each), Bryntum x3 ($1,000 each)
- Other named partners: APIMatic, Render, Kernel, Channel3, Postman, Astropods, Elastic, AG Grid, Bryntum.

---

## 1. Google Gemini API (primary LLM candidate)

### 1a. Free tier and region
- Free tier exists for several Flash / Flash-Lite models. Source: https://aistudio.google.com/docs/pricing
- Kazakhstan is in the supported-countries list. Source: https://aistudio.google.com/docs/available-regions (fetched via tool summary; the page is ~200 countries; the summary states KZ is listed). Verify by opening AI Studio with your account.
- Free tier **does not** apply to Pro models (`gemini-3.1-pro-preview`: "Not available on any tab"). Source: https://aistudio.google.com/docs/pricing
- **Privacy:** free-tier models are marked "Used to improve our products." Do not send real customer data through the free tier. Source: https://aistudio.google.com/docs/pricing

### 1b. Recommended model IDs (source: https://aistudio.google.com/docs/models)

| Tier | Model ID | Status | Free tier (source: pricing page) |
|---|---|---|---|
| Flash (recommended) | `gemini-3.8-flash` | "New", recommended for new projects | Yes (Standard, Priority). No search grounding, no Batch/Flex |
| Flash | `gemini-3.6-flash` | Stable | Yes (Standard, Priority) |
| Flash-Lite (cheap/fast) | `gemini-3.5-flash-lite` | Stable | Yes (Standard, Batch, Priority) |
| Flash-Lite | `gemini-3.1-flash-lite` | Stable | Yes (all tabs) |
| Flash-Lite | `gemini-2.5-flash-lite` | Not deprecated, no date given | Yes (Standard, Priority) |
| Pro | `gemini-3.1-pro-preview` | Preview only; no stable Pro listed | **No** |

Deprecations (source: https://aistudio.google.com/docs/models):
- `gemini-2.5-flash` is deprecated. Requests route to `gemini-3.5-flash-lite` from **Dec 1, 2026**.
- `gemini-2.5-pro` is deprecated. Requests route to `gemini-3.8-flash` from **Dec 1, 2026**.

Do not hard-code `gemini-2.5-*` for the demo.

### 1c. Free-tier rate limits (RPM / RPD)
- **UNVERIFIED from primary.** The rate-limit page (https://aistudio.google.com/docs/rate-limits and https://aistudio.google.com/rate-limit) gives no per-model numbers. The AI Studio rate-limit screen requires a Google sign-in, so the numbers cannot be read here.
- Community figures only (UNVERIFIED): Flash about 15 RPM / 1,500 RPD (May 2026 guide); Flash-Lite 30 RPM / 1,000 RPD (Jan 2026 guide). Source: https://yingtu.ai/en/blog/google-gemini-api-free-tier-limits-2026 (third-party, conflicting data).
- Limits are per **Google Cloud project**, not per key. Daily quota resets at midnight Pacific time. Source: https://aistudio.google.com/docs/rate-limits
- Action: read the exact numbers at https://aistudio.google.com/rate-limit after signing in.

### 1d. Capabilities
- **Function calling:** supported (Gemini 3 series, including `gemini-3.8-flash`). Source: https://aistudio.google.com/docs/function-calling. Whether it is on the free tier: not stated on the page, so **UNVERIFIED** (free tier covers the model; test with one call).
- **Structured JSON output:** supported. Interactions API: `response_format: { type: "text", mime_type: "application/json", schema }`. Source: https://aistudio.google.com/docs/structured-output. generateContent: `generationConfig.responseMimeType: "application/json"` plus `responseJsonSchema`. Source: https://aistudio.google.com/api-reference/generate-content (the page itself is inconsistent about `responseSchema`; check the full reference).
- **Image input:** supported on generateContent via `inlineData` (`image/png`, `image/jpeg`, `image/webp`, `image/heic`). Source: https://aistudio.google.com/api-reference/generate-content. Per-model support for the chosen model: UNVERIFIED.

### 1e. Consumer Gemini / Google AI Pro subscription
- **No API credits.** The subscription gives higher quotas inside AI Studio Playground and Build only. "Direct use of the Gemini API (such as using API keys or external applications) is billed and managed separately." Source: https://aistudio.google.com/docs/google-ai-plans
- Subscribers with a GCP project and Cloud Billing enabled "are eligible to receive monthly Cloud credits from the Google Developer Program for Cloud services, including the Gemini API." The amount is not stated on the page. A third-party blog claims $10/month (UNVERIFIED). Source for eligibility: https://aistudio.google.com/docs/google-ai-plans
- Budget implication: plan to run on the free tier; a Cloud Billing account is needed only if you move to paid usage.

### 1f. SDK and function-calling shape
- Current JS/TS SDK: **`@google/genai`**. Install: `npm install @google/genai`. Source: https://aistudio.google.com/docs/libraries
- Legacy `@google/generativeai` (the page writes `@google/generativeai`; spelling to confirm) was deprecated Nov 30, 2025. Do not use it. Source: https://aistudio.google.com/docs/libraries
- Verified JS example (Interactions API, the form the JS docs use; source: https://aistudio.google.com/docs/function-calling):

```js
import { GoogleGenAI } from '@google/genai';
const client = new GoogleGenAI({}); // reads the API key from the environment (variable name UNVERIFIED; GEMINI_API_KEY is the usual default)

const searchTool = {
  type: 'function',
  name: 'search_products',
  description: 'Search products by text query',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

const interaction = await client.interactions.create({
  model: 'gemini-3.8-flash',
  input: 'Find a merino sweater under $100',
  tools: [searchTool],
});
const fc = interaction.steps.find(s => s.type === 'function_call'); // fc.name, fc.arguments, fc.id

const done = await client.interactions.create({
  model: 'gemini-3.8-flash',
  input: [{ type: 'function_result', name: fc.name, call_id: fc.id,
            result: [{ type: 'text', text: JSON.stringify({ items: [] }) }] }],
  tools: [searchTool],
  previous_interaction_id: interaction.id,
});
console.log(done.output_text);
```

- generateContent REST shape (source: https://aistudio.google.com/api-reference/generate-content; endpoint `POST /v1beta/models/{model}:generateContent`):
  - Declarations: `tools: [{ functionDeclarations: [{ name, description, parameters: { type: "OBJECT", properties, required } }] }]`
  - Response: `candidates[0].content.parts[]` contains `{ functionCall: { name, id, args } }`
  - Reply: `{ functionResponse: { name, id, response: {...} } }`
  - The page is inconsistent about the role for the reply turn (`user` vs `function`). Verify with a test call.
- The docs now lead with the Interactions API for JS. Both forms appear in the docs; pick one and test it once. The exact `config: { tools }` shape in the JS SDK's generateContent wrapper is UNVERIFIED.

---

## 2. Free fallbacks (OpenAI-compatible)

### Groq (best fallback)
- Base URL `https://api.groq.com/openai/v1`; key from `GROQ_API_KEY`. Use the `openai` npm package with `baseURL`. Source: https://console.groq.com/docs/openai
- Tool use: "All models hosted on Groq support tool use." Standard `tools` + `function` shape. Source: https://console.groq.com/docs/tool-use/overview
- Tool-use model IDs listed: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`. The gpt-oss models do not support parallel tool calls. Source: https://console.groq.com/docs/tool-use/overview
- Free-tier limits: **UNVERIFIED.** The rate-limits page has a "Free Plan Limits" tab whose values were not extracted. Limits are per **organization**. Source: https://console.groq.com/docs/rate-limits. Secondary figures (UNVERIFIED): `llama-3.1-8b-instant` 30 RPM / 14,400 RPD; `llama-3.3-70b-versatile` 30 RPM / 1,000 RPD. Sources: https://www.mintlify.com/pfrankov/obsidian-ai-providers/providers/groq and https://blogs.novita.ai/free-llm-api-comparison-2026/
- Credit card for free tier: conflicting sources (UNVERIFIED).

### OpenRouter
- Base URL `https://openrouter.ai/api/v1` (OpenAI-compatible `/chat/completions`). Free models use the `:free` suffix. Source: https://openrouter.ai/docs/faq
- Free-tier caps (non-model-specific): **20 RPM**; **50 requests/day** without credits, **1,000/day** after a $10 top-up. Source: https://openrouter.ai/blog/tutorials/free-llm-apis-compared/ (OpenRouter blog, published 6/15/2026, updated 9/24/2026).
- Named free slugs: `meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen3-coder:free`, `openai/gpt-oss-120b:free`. Tool-calling support for these: **UNVERIFIED.** Filtering the models page for free + tools returned no clear result. Check `https://openrouter.ai/api/v1/models` JSON for `supported_parameters` containing `tools`.
- The `openrouter/free` router picks among free models, and the `models` array gives automatic fallback. Free models rotate often. Source: https://openrouter.ai/blog/tutorials/free-llm-apis-compared/

### Cerebras
- Base URL `https://api.cerebras.ai/v1` (OpenAI-compatible). Source: https://inference-docs.cerebras.ai/introduction
- Free tier: **UNVERIFIED and conflicting.** Secondary sources say there is no standing free tier, only a $5 trial credit that needs a verified payment method and expires after 30 days. Another (CostBench, Sep 2026) claims 1M tokens/day. Free-trial limits quoted by an aggregator: 5 RPM, 30K uncached TPM, 1M TPD for `gpt-oss-120b`. Sources: https://inference-docs.cerebras.ai/support/rate-limits (fetched; table), https://www.developersdigest.tech/models/free-api/cerebras
- Not recommended as a no-cost fallback unless the trial status is confirmed in the Cerebras console.

---

## 3. Channel3 (hackathon sponsor)

- What it is: "an API that lets your app or agent find almost any product online." Search by text, image, or URL; filters for price, brand, category, availability. Source: https://channel3.ai/docs/
- Docs URL: https://channel3.ai/docs/ (the older `docs.trychannel3.com` redirects there). API reference: https://channel3.ai/docs/api returned 404 to the fetch tool, so the reference page is **UNVERIFIED**. Guide: https://channel3.ai/docs/guides/make-a-search.md
- Getting a key: create a free account at https://trychannel3.com/sign-up/developer and copy the key. Source: https://channel3.ai/docs/guides/make-a-search.md
- Auth and base: `https://api.trychannel3.com/v1`, header `x-api-key: <key>`. Optional `x-user-id`. Source: https://channel3.ai/docs/guides/make-a-search.md
- Search: `POST /v1/search`. Body: `query`, `filters` (`price: {min_price, max_price}`, `availability: ["InStock"]`, `brand_ids`, `category`, `gender`, `colors`, `attributes`, `age`, `dimensions`), `limit`, `page_token`, `config: { mode: "keyword" | ..., collection_id }`. Source: https://channel3.ai/docs/guides/make-a-search.md and https://channel3.ai/docs/guides/search
- Response (source: https://channel3.ai/docs/guides/response-overview.md):
  - Top level: `products[]`, `next_page_token` (null when done)
  - Per product: `id`, `title`, `description`, `brands[]`, `images[]` (`url`, `cleaned_url`, `is_main_image`), `offers[]`
  - Per offer: `url` (retailer buy/product link), `domain`, `price` (`price`, `compare_at_price`, `currency`), `availability` (`InStock`/`OutOfStock`)
  - Real retailer data with price, image, and buy link: **yes, per the docs.** Product-level price does not exist; read `offers[0].price.price`.
  - Price unit (cents vs dollars): **UNVERIFIED.** Confirm with one live call.
- Pricing (source: https://channel3.ai/docs/pricing):
  - **1,000 free credits per month**, no card stated (card requirement: UNVERIFIED on the pricing page)
  - `/search` = 1 credit. `/browse`, `/image-search`, `/similar`, `/lookup` = 1 credit each. `/products`, `/brands`, `/categories`, `/collections` = free.
  - Overage: **$0.007 per credit**
  - Paid plans: none listed on the page.
- Pay-per-call option without signup: $0.007 USDC.e per call via MPP (Tempo wallet), POST `https://mpp.trychannel3.com/v1/search`. Source: https://channel3.ai/docs/mpp.md. Not needed for a $0 budget.
- Sponsor credits beyond the 1,000 free: UNVERIFIED.

**Worth integrating?** Yes, probably. Real offers with prices, images, and buy links cover the "AI shopping agent" core, and the free allowance (~1,000 searches/month) is enough for a demo. Check it early, since the prize is $1,500 and the response shape is documented. Keep a mock dataset as backup in case of outages or rate limits.

---

## 4. Render (sponsor)

Source for all free-tier facts: https://render.com/docs/free (page has no last-updated date).

- **Web service (Free):**
  - 750 free instance hours per workspace per calendar month; unused hours do not roll over. When used up, all free services are suspended until next month.
  - Spins down after **15 minutes** without inbound HTTP/WebSocket traffic. Spin-up about 1 minute.
  - One instance only. No persistent disk: local files are lost on redeploy, restart, or spin-down.
  - Render may restart the service or suspend it for unusually high service-initiated traffic.
  - Outbound SMTP ports 25/465/587 are blocked.
  - Build pipeline minutes and bandwidth: included monthly, **amounts not stated** (UNVERIFIED). Without a payment method, new builds are disabled and services are suspended when the allowance is used up.
- **Free Postgres:** 1 GB; **expires 30 days after creation**, then 14-day grace, then deleted. One active free DB per workspace. No backups. A DB created on Nov 3 expires about Dec 3.
- **Free Key Value (Redis-compatible):** one per workspace; **in-memory only** (data lost on any restart); expiry window **not specified** (UNVERIFIED).
- Blueprint (`render.yaml`): source https://render.com/docs/blueprint-spec
  - Top-level keys include `services`, `databases`, `envVarGroups`, `projects`, `previews`. Env vars are set per service.
  - Web service fields: `type: web`, `name`, `runtime: node`, `plan: free`, `buildCommand` (required for non-Docker), `startCommand` (required for most), `region` (default `oregon`), `envVars`.
  - Secret prompt: `sync: false` on an env var prompts for the value only on first Blueprint creation.
  - Composed example (the page's example block was not extracted; the `key`/`value` shape is inferred):

```yaml
services:
  - type: web
    name: shopping-agent
    runtime: node
    plan: free
    region: oregon
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: GEMINI_API_KEY
        sync: false
      - key: PAYPAL_CLIENT_ID
        sync: false
```

- Render sponsor prize: "Best Use of Render" (see section 0).

---

## 5. AG Grid

Source: https://www.ag-grid.com/license-pricing/

- **Community = MIT**, "free and open source under the MIT licence, including for production use." Covers basic columns, text/number/date filters, basic editors, CSV export. Charts Community is also MIT.
- **Enterprise** features need a commercial licence: set/multi/advanced filters, Excel/PDF export, row grouping, pivoting, tree data, formulas, advanced chart types (box plot, candlestick, heatmap, maps).
- Trial: AG Grid, AG Charts, and the Enterprise Bundle have a **30-day free trial**; AG Studio 45 days. The page links a trial-licence request form and does not describe an evaluation key.
- Hackathon-specific or student/open-source Enterprise key: **not mentioned** on the licence page (UNVERIFIED). Ask the sponsor or check the Devpost rules if you want Enterprise features.
- Watermark behavior without a licence: **not stated** on the page (UNVERIFIED).
- Recommendation: Community covers a basic product table. Use `ag-grid-community` / `ag-grid-react` if a grid is needed.

---

## Open items / what I could not verify
1. Gemini free-tier RPM/RPD per model (needs AI Studio sign-in).
2. Whether free tier covers function calling and image input for `gemini-3.8-flash` (test with one call).
3. Kazakhstan availability (listed per AI Studio docs summary; confirm when signing in).
4. Groq free-tier limits and card requirement.
5. OpenRouter free models with tool support.
6. Cerebras free-trial status.
7. Channel3 price unit (cents vs dollars), buy-link field confirmed on a live response, card requirement.
8. Render build-minute and bandwidth allowances; Key Value expiry.
9. Devpost official deadline (Nov 12 vs Nov 13) and prize total; sponsor credit amounts.
10. AG Grid watermark behavior and any temporary Enterprise key.
