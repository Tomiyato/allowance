// ProductSource selection, per-query cache, auto-fallback to the catalog, demo injection mixing.
import type { Product } from "../../shared/types.ts";
import { config } from "../config.ts";
import { injectionMatches, injectionProduct, lookupCatalog, searchCatalog } from "./catalog.ts";
import { searchChannel3 } from "./channel3.ts";

export interface SearchParams {
  query: string;
  max_price?: number;
  category?: string;
  limit?: number;
}

export interface SearchResult {
  source: "channel3" | "catalog";
  products: Product[];
  /** Set when Channel3 failed and the catalog answered instead. */
  fallback_reason?: string;
}

export interface ProductSource {
  name: "channel3" | "catalog";
  search(p: SearchParams): Promise<Product[]>;
}

const catalogSource: ProductSource = {
  name: "catalog",
  search: async (p) => searchCatalog(p, config.demoInjection),
};
const channel3Source: ProductSource = { name: "channel3", search: searchChannel3 };

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; result: SearchResult }>();

export async function searchProducts(p: SearchParams): Promise<SearchResult> {
  const key = JSON.stringify([config.productSource, p.query.trim().toLowerCase(), p.max_price ?? null, p.category ?? null]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  let result: SearchResult;
  if (config.productSource === "channel3") {
    try {
      const products = await channel3Source.search(p);
      if (products.length === 0) throw new Error("Channel3 returned no USD products");
      result = { source: "channel3", products: products.slice(0, p.limit ?? 6) };
      if (config.demoInjection && injectionMatches(p.query, p.category)) {
        // Demo beat: one poisoned listing mixed into real results (SPEC §7).
        const inj = injectionProduct();
        if (p.max_price === undefined || inj.price <= p.max_price) result.products.splice(1, 0, inj);
      }
    } catch (e: any) {
      console.warn(`[products] Channel3 failed, falling back to catalog: ${e?.message}`);
      result = { source: "catalog", products: await catalogSource.search(p), fallback_reason: String(e?.message ?? e) };
    }
  } else {
    result = { source: "catalog", products: await catalogSource.search(p) };
  }
  // Do not cache fallbacks: Channel3 may be back on the next call.
  if (!result.fallback_reason) cache.set(key, { at: Date.now(), result });
  return result;
}

export { injectionProduct, lookupCatalog };
