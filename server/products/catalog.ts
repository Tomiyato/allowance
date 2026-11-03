// Seeded offline catalog (server/data/catalog.json). Always available; also the fallback for Channel3.
import { readFileSync } from "node:fs";
import type { Product } from "../../shared/types.ts";
import type { SearchParams } from "./index.ts";

interface CatalogEntry extends Product {
  tags: string[];
  injection?: boolean;
}

const entries: CatalogEntry[] = JSON.parse(
  readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8"),
);

const STOP = new Set(["a", "an", "the", "for", "my", "her", "his", "and", "or", "of", "to", "with", "some", "good", "best", "around", "about", "under", "buy", "find", "me", "i", "she", "he", "loves", "like", "likes", "gift", "gifts", "present"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ing|s)$/, ""));
}

const toProduct = ({ tags: _t, injection: _i, ...p }: CatalogEntry): Product => p;

export function injectionProduct(): Product {
  return toProduct(entries.find((e) => e.injection)!);
}

/** True when the injection item plausibly matches a query (its category or a garden/gift theme). */
export function injectionMatches(query: string, category?: string): boolean {
  const inj = entries.find((e) => e.injection)!;
  if (category && (category === inj.category || category === "gifts")) return true;
  return /garden|herb|seed|plant|gift|mom|mother/i.test(query);
}

export function lookupCatalog(id: string): Product | undefined {
  const e = entries.find((x) => x.id === id);
  return e ? toProduct(e) : undefined;
}

export function searchCatalog(p: SearchParams, includeInjection: boolean): Product[] {
  const q = tokens(p.query);
  const giftIntent = /gift|present|birthday/i.test(p.query);
  const scored = entries
    .filter((e) => includeInjection || !e.injection)
    .filter((e) => p.max_price === undefined || e.price <= p.max_price)
    .map((e) => {
      const hay = tokens(`${e.title} ${e.tags.join(" ")} ${e.category}`);
      let score = 0;
      for (const t of q) if (hay.some((h) => h === t || (t.length > 3 && h.startsWith(t)) || (h.length > 3 && t.startsWith(h)))) score += 2;
      if (p.category && e.category === p.category) score += 3;
      if (giftIntent && e.tags.includes("gift")) score += 1;
      return { e, score };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.e.price - b.e.price);
  return scored.slice(0, p.limit ?? 6).map((x) => toProduct(x.e));
}
