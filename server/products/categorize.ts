// Map a Channel3 product category (Google-taxonomy-like slug path) into CATEGORY_VOCAB.
// Cheap deterministic heuristic, no LLM call. Anything not matched by a specific rule gets
// category_confidence "low", which the policy engine turns into needs_approval.
import { CATEGORY_VOCAB } from "../../shared/types.ts";

type Cat = (typeof CATEGORY_VOCAB)[number];

// Ordered: first match wins. Each rule tests the joined slug path ("home-garden>lawn-garden>...").
const PATH_RULES: Array<[RegExp, Cat]> = [
  [/(^|>)(electronics|cameras-optics|video-game|computers|household-appliances|vacuums|small-appliances>.*vacuum)/, "electronics"],
  [/(^|>)(jewelry|watches)/, "jewelry"],
  [/^toys-games/, "toys"], // before garden: "toys-games>...>pretend-lawn-garden" is a toy
  [/(^|>)(lawn-garden|gardening|plants|outdoor-living)/, "garden"],
  [/(^|>)(kitchen-dining|kitchen|cookware|tableware|food-storage)/, "kitchen"],
  [/(^|>)(food-beverages|food-items|beverages|grocery)/, "groceries"],
  [/(^|>)(animals-pet-supplies|pet-supplies)/, "pets"],
  [/(^|>)(office-supplies|office|stationery)/, "office"],
  [/(^|>)(media>books|books)/, "books"],
  [/(^|>)(toys-games|toys|games|puzzles)/, "toys"],
  [/(^|>)(sporting-goods|exercise-fitness|athletics|outdoor-recreation)/, "sports"],
  [/(^|>)(health-beauty>personal-care|cosmetics|skin-care|hair-care|fragrance|bath-body|beauty)/, "beauty"],
  [/(^|>)(apparel-accessories|clothing|shoes|handbags)/, "clothing"],
  [/(^|>)(gift-giving|gift-baskets|gift-wrapping|party-celebration)/, "gifts"],
  [/(^|>)(home-garden|household-supplies|decor|linens-bedding|bathroom-accessories|furniture|lighting)/, "home"],
];

// Title keywords for a low-confidence guess when there is no usable category path.
const TITLE_RULES: Array<[RegExp, Cat]> = [
  [/\b(robot|vacuum|bluetooth|wi-?fi|speaker|headphone|charger|camera|tablet|laptop|smart)\b/i, "electronics"],
  [/\b(garden|plant|seed|planter|trowel|pruner|watering)\b/i, "garden"],
  [/\b(knife|skillet|pan|pot|mug|kitchen|cookware)\b/i, "kitchen"],
  [/\b(gift|basket|hamper)\b/i, "gifts"],
  [/\b(towel|sheet|blanket|candle|detergent|cleaner)\b/i, "home"],
];

export function mapCategory(pathSlugs: string[], title: string): { category: Cat; confidence: "high" | "low" } {
  const path = pathSlugs.join(">").toLowerCase();
  // Electronics hiding in a non-electronics path (e.g. a "smart" planter) is a reason for doubt.
  const electronicTitle = TITLE_RULES[0][0].test(title);
  if (path) {
    for (const [re, cat] of PATH_RULES) {
      if (re.test(path)) {
        const confidence = cat !== "electronics" && electronicTitle ? "low" : "high";
        return { category: cat, confidence };
      }
    }
  }
  for (const [re, cat] of TITLE_RULES) if (re.test(title)) return { category: cat, confidence: "low" };
  return { category: "other", confidence: "low" };
}
