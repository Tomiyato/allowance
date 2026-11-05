// POST /api/mandates/parse: natural language -> gift list (Mandate) draft (structured output, zod-validated).
import { generateText, Output } from "ai";
import { z } from "zod";
import { CATEGORY_VOCAB, type Mandate } from "../../shared/types.ts";
import { round2 } from "../policy.ts";
import { buildMandate, endOfMonthUtc, MAX_RECIPIENTS, MandateInputSchema, maxExpiry, PAYPAL_HOLD_DAYS } from "../service.ts";
import { isRateLimit, model } from "./model.ts";

/** Ask-me threshold when the text gives none (GIFTLIST_SPEC decision 2). */
export const DEFAULT_ASK_OVER = 45;

/** The categories a holiday gift list covers unless the user excludes some (GIFTLIST_SPEC §2). */
export const GIFT_CATEGORIES = ["gifts", "home", "garden", "kitchen", "toys", "sports", "books", "office", "clothing", "beauty"] as const;

const RecipientDraftSchema = z.object({
  name: z.string().describe('How the user refers to the person or group, e.g. "Mom", "Leo", "Office Secret Santa"'),
  envelope: z.number().describe("USD amount for this person"),
  interests: z.string().describe('What they like or what to get, in a few words, e.g. "loves gardening"; "" if not stated'),
});

const DraftSchema = z.object({
  title: z.string().describe('Short human title, e.g. "Holiday gifts"'),
  budget_total: z.number().describe("Total budget in USD as stated by the user"),
  recipients: z.array(RecipientDraftSchema).describe("One entry per person (or group) who gets a gift, each with their own amount"),
  per_purchase_approval_over: z.number().nullable().describe("Purchases with a total above this USD amount need the user's approval; null if not stated"),
  allowed_categories: z.array(z.enum(CATEGORY_VOCAB)).describe("Categories the gifts may come from"),
  blocked_categories: z.array(z.enum(CATEGORY_VOCAB)).describe("Categories the user explicitly excluded"),
  max_quantity_per_item: z.number().int().nullable().describe("Max units of one product per purchase; null if not stated"),
  expires_at: z.string().nullable().describe("ISO 8601 UTC end of validity; null if not stated"),
});

type Draft = z.infer<typeof DraftSchema>;

function prompt(text: string, now: Date) {
  return `Turn the user's holiday gift list into a structured gift list for a gift-shopping agent.
Today is ${now.toISOString().slice(0, 10)}. "This month" ends ${endOfMonthUtc(now)}; "this week" ends next Sunday 23:59:59Z.
Category vocabulary: ${CATEGORY_VOCAB.join(", ")}.
Rules:
- recipients: one entry per person or group the user buys for, in the order written. Keep the user's name for them ("Mom", "Dad", "Leo", "Office Secret Santa"); drop words like "my" and relationship words that are not the name ("my nephews Leo and Sam" gives "Leo" and "Sam"). envelope = that person's own amount. interests = the words about them, short ("loves gardening", "coffee nerd", "dinosaurs", "something for the desk"). If some people have no amount, share what is left of the stated total equally among them. If the text names nobody, recipients is [].
- budget_total: the total the user states; if none, the sum of the envelopes.
- allowed_categories: for a gift list, ${GIFT_CATEGORIES.join(", ")}, minus anything the user excludes. Add another vocabulary category only when a person's interests clearly need it.
- blocked_categories: only what the user explicitly excludes ("no electronics" -> electronics). Never list a category in both.
- per_purchase_approval_over: the "ask me before anything over $X" amount; null if not stated.
- Amounts are USD numbers without symbols.
- Respond with a single JSON object matching the schema.

User gift list:
"""${text}"""`;
}

/** Deterministic fallback when the model is unavailable (rate limit, outage). It does not split recipients. */
export function heuristicDraft(text: string, _now = new Date()): Draft {
  const amounts = [...text.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const over = text.match(/(?:over|above|more than)\s*\$\s?(\d+(?:\.\d+)?)/i);
  const budget = amounts[0] ?? 100;
  const lower = text.toLowerCase();
  const blocked = CATEGORY_VOCAB.filter((c) => new RegExp(`\\bno\\s+${c}|\\bnot?\\s+(?:any\\s+)?${c}`).test(lower));
  const allowed = new Set<string>();
  if (/gift|birthday|present|holiday|christmas|santa/.test(lower)) GIFT_CATEGORIES.forEach((c) => allowed.add(c));
  if (/home|household|basics|restock/.test(lower)) ["home", "kitchen"].forEach((c) => allowed.add(c));
  for (const c of CATEGORY_VOCAB) if (lower.includes(c)) allowed.add(c);
  return {
    title: text.slice(0, 60),
    budget_total: budget,
    recipients: [],
    per_purchase_approval_over: over ? Number(over[1]) : null,
    allowed_categories: [...allowed].filter((c) => !blocked.includes(c as any)) as Draft["allowed_categories"],
    blocked_categories: blocked,
    max_quantity_per_item: null,
    expires_at: null,
  };
}

/** Make model output valid for MandateInputSchema: positive envelopes, unique names, length caps. */
export function cleanRecipients(raw: Draft["recipients"]): { name: string; envelope: number; interests: string }[] {
  const seen = new Set<string>();
  const out: { name: string; envelope: number; interests: string }[] = [];
  for (const r of raw ?? []) {
    let name = String(r?.name ?? "").trim().slice(0, 40);
    const envelope = round2(Number(r?.envelope));
    if (!name || !Number.isFinite(envelope) || envelope <= 0) continue;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${name.slice(0, 36)} (${n})`;
    seen.add(name.toLowerCase());
    out.push({ name, envelope, interests: String(r?.interests ?? "").trim().slice(0, 120) });
    if (out.length === MAX_RECIPIENTS) break;
  }
  return out;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function parseMandate(text: string, now = new Date()): Promise<{ mandate: Mandate; source: "ai" | "heuristic"; warning?: string }> {
  let draft: Draft;
  let source: "ai" | "heuristic" = "ai";
  const warnings: string[] = [];
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
    warnings.push(
      isRateLimit(e)
        ? "AI is rate-limited; this draft was filled by a simple rule-based parser. Please review it."
        : "AI parsing failed; this draft was filled by a simple rule-based parser. Please review it.",
    );
  }

  const recipients = cleanRecipients(draft.recipients);
  const sum = round2(recipients.reduce((t, r) => t + r.envelope, 0));
  const stated = draft.budget_total > 0 ? round2(draft.budget_total) : null;
  // Decision 1: with a gift list the total is the sum of the envelopes.
  const budget = recipients.length ? sum : (stated ?? 100);
  if (recipients.length && stated !== null && Math.abs(stated - sum) > 0.01) {
    warnings.push(`The envelopes add up to ${usd(sum)}, not the ${usd(stated)} total in your text; the total follows the envelopes.`);
  }

  // Decision 4: default and cap = the PayPal authorization validity.
  const cap = maxExpiry(now);
  const asked = draft.expires_at ? Date.parse(draft.expires_at) : NaN;
  let expires = cap.toISOString();
  if (Number.isFinite(asked) && asked > now.getTime()) {
    if (asked > cap.getTime()) warnings.push(`PayPal holds the budget for up to ${PAYPAL_HOLD_DAYS} days, so the list ends on ${cap.toISOString().slice(0, 10)}.`);
    else expires = new Date(asked).toISOString();
  }

  const input = MandateInputSchema.parse({
    title: draft.title?.trim().slice(0, 120) || "My gift list",
    budget_total: Math.min(budget, 100_000),
    per_purchase_approval_over:
      draft.per_purchase_approval_over !== null && draft.per_purchase_approval_over >= 0 ? Math.min(draft.per_purchase_approval_over, 100_000) : DEFAULT_ASK_OVER,
    allowed_categories: draft.allowed_categories,
    blocked_categories: draft.blocked_categories,
    max_quantity_per_item: draft.max_quantity_per_item && draft.max_quantity_per_item > 0 ? Math.min(Math.round(draft.max_quantity_per_item), 100) : 2,
    expires_at: expires,
    recipients,
  });
  return { mandate: buildMandate(input, "draft", now), source, warning: warnings.length ? warnings.join(" ") : undefined };
}
