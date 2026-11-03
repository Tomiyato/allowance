// Channel3 real product search (POST https://api.trychannel3.com/v1/search, header x-api-key).
// Verified with a live call on 2026-11-03: offers[].price.price is in DOLLARS (e.g. 100.76),
// offers[].price.currency is "USD"; category is { slug, title, path: [{slug,title}] }.
import type { Product } from "../../shared/types.ts";
import { config } from "../config.ts";
import { mapCategory } from "./categorize.ts";
import type { SearchParams } from "./index.ts";

interface C3Offer {
  url?: string;
  domain?: string;
  price?: { price?: number; compare_at_price?: number | null; currency?: string };
  availability?: string;
}
interface C3Product {
  id: string;
  title?: string;
  description?: string;
  brands?: Array<{ id: string; name: string }>;
  images?: Array<{ url?: string; cleaned_url?: string | null; is_main_image?: boolean }>;
  category?: { slug?: string; title?: string; path?: Array<{ slug: string; title: string }> } | null;
  offers?: C3Offer[];
}

export function mapChannel3Product(p: C3Product): Product | null {
  const offer =
    p.offers?.find((o) => o.price?.currency === "USD" && o.availability === "InStock" && (o.price?.price ?? 0) > 0) ??
    p.offers?.find((o) => o.price?.currency === "USD" && (o.price?.price ?? 0) > 0);
  if (!offer || !p.title) return null;
  const slugs = p.category?.path?.map((x) => x.slug) ?? (p.category?.slug ? [p.category.slug] : []);
  const { category, confidence } = mapCategory(slugs, p.title);
  const img = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
  return {
    id: `c3_${p.id}`,
    title: p.title,
    description: (p.description ?? "").slice(0, 600),
    price: Math.round(offer.price!.price! * 100) / 100,
    currency: "USD",
    category,
    category_confidence: confidence,
    merchant: offer.domain ?? p.brands?.[0]?.name ?? "unknown merchant",
    image_url: img?.url ?? null,
    url: offer.url ?? null,
    source: "channel3",
  };
}

export async function searchChannel3(p: SearchParams): Promise<Product[]> {
  if (!config.channel3ApiKey) throw new Error("CHANNEL3_API_KEY is not set");
  const body: Record<string, unknown> = { query: p.query, limit: Math.min(p.limit ?? 6, 10) };
  if (p.max_price !== undefined) body.filters = { price: { max_price: p.max_price } };
  const res = await fetch("https://api.trychannel3.com/v1/search", {
    method: "POST",
    headers: { "x-api-key": config.channel3ApiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Channel3 search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { products?: C3Product[] };
  return (json.products ?? [])
    .map(mapChannel3Product)
    .filter((x): x is Product => x !== null)
    .filter((x) => p.max_price === undefined || x.price <= p.max_price);
}
