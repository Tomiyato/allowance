// POST /api/mandates/parse: natural language -> Mandate draft (structured output, zod-validated).
import { generateText, Output } from "ai";
import { z } from "zod";
import { CATEGORY_VOCAB, type Mandate } from "../../shared/types.ts";
import { buildMandate, endOfMonthUtc, MandateInputSchema } from "../service.ts";
import { isRateLimit, model } from "./model.ts";

const DraftSchema = z.object({
  title: z.string().describe("Short human title, e.g. \"Mom's birthday + home basics\""),
  budget_total: z.number().describe("Total budget in USD"),
  per_purchase_approval_over: z.number().nullable().describe("Purchases with a total above this USD amount need the user's approval; null if not stated"),
  allowed_categories: z.array(z.enum(CATEGORY_VOCAB)).describe("Categories the stated purposes cover"),
  blocked_categories: z.array(z.enum(CATEGORY_VOCAB)).describe("Categories the user explicitly excluded"),
  max_quantity_per_item: z.number().int().nullable().describe("Max units of one product per purchase; null if not stated"),
  expires_at: z.string().nullable().describe("ISO 8601 UTC end of validity; null if not stated"),
});

type Draft = z.infer<typeof DraftSchema>;

function prompt(text: string, now: Date) {
  return `Turn the user's spending instruction into a mandate for a shopping agent.
Today is ${now.toISOString().slice(0, 10)}. "This month" ends ${endOfMonthUtc(now)}; "this week" ends next Sunday 23:59:59Z.
Category vocabulary: ${CATEGORY_VOCAB.join(", ")}.
Rules:
- allowed_categories: every vocabulary category the stated purposes reasonably cover. A gift purpose covers "gifts" plus the categories gifts usually come from (garden, kitchen, books, beauty, jewelry, clothing, home) unless excluded. "Home basics" covers home and kitchen.
- blocked_categories: only what the user explicitly excludes ("no electronics" -> electronics). Never list a category in both.
- Amounts are USD numbers without symbols.
- Respond with a single JSON object matching the schema.

User instruction:
"""${text}"""`;
}

/** Deterministic fallback when the model is unavailable (rate limit, outage). */
export function heuristicDraft(text: string, now = new Date()): Draft {
  const amounts = [...text.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const over = text.match(/(?:over|above|more than)\s*\$\s?(\d+(?:\.\d+)?)/i);
  const budget = amounts[0] ?? 100;
  const lower = text.toLowerCase();
  const blocked = CATEGORY_VOCAB.filter((c) => new RegExp(`\\bno\\s+${c}|\\bnot?\\s+(?:any\\s+)?${c}`).test(lower));
  const allowed = new Set<string>();
  if (/gift|birthday|present/.test(lower)) ["gifts", "garden", "kitchen", "books", "beauty", "jewelry", "clothing", "home"].forEach((c) => allowed.add(c));
  if (/home|household|basics|restock/.test(lower)) ["home", "kitchen"].forEach((c) => allowed.add(c));
  for (const c of CATEGORY_VOCAB) if (lower.includes(c)) allowed.add(c);
  return {
    title: text.slice(0, 60),
    budget_total: budget,
    per_purchase_approval_over: over ? Number(over[1]) : null,
    allowed_categories: [...allowed].filter((c) => !blocked.includes(c as any)) as Draft["allowed_categories"],
    blocked_categories: blocked,
    max_quantity_per_item: null,
    expires_at: null,
  };
}

export async function parseMandate(text: string, now = new Date()): Promise<{ mandate: Mandate; source: "ai" | "heuristic"; warning?: string }> {
  let draft: Draft;
  let source: "ai" | "heuristic" = "ai";
  let warning: string | undefined;
  try {
    const { output } = await generateText({
      model: model(),
      output: Output.object({ schema: DraftSchema }),
      prompt: prompt(text, now),
      maxRetries: 2,
    });
    draft = output;
  } catch (e) {
    console.warn("[parse] model failed, using heuristic parser:", (e as Error).message);
    draft = heuristicDraft(text, now);
    source = "heuristic";
    warning = isRateLimit(e)
      ? "AI is rate-limited; this draft was filled by a simple rule-based parser. Please review it."
      : "AI parsing failed; this draft was filled by a simple rule-based parser. Please review it.";
  }

  const budget = draft.budget_total > 0 ? draft.budget_total : 100;
  const expires = draft.expires_at && Date.parse(draft.expires_at) > now.getTime() ? draft.expires_at : endOfMonthUtc(now);
  const input = MandateInputSchema.parse({
    title: draft.title || "My shopping mandate",
    budget_total: budget,
    // Default: ask before anything over half the budget.
    per_purchase_approval_over: draft.per_purchase_approval_over ?? Math.round(budget / 2),
    allowed_categories: draft.allowed_categories,
    blocked_categories: draft.blocked_categories,
    max_quantity_per_item: draft.max_quantity_per_item && draft.max_quantity_per_item > 0 ? draft.max_quantity_per_item : 2,
    expires_at: expires,
  });
  return { mandate: buildMandate(input, "draft"), source, warning };
}
