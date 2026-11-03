import { describe, expect, it } from "vitest";
import { mapCategory } from "./categorize.ts";
import { injectionProduct, searchCatalog } from "./catalog.ts";
import { mapChannel3Product } from "./channel3.ts";

describe("mapCategory (Channel3 slug path -> CATEGORY_VOCAB)", () => {
  it.each([
    [["home-garden", "lawn-garden", "gardening", "gardening-tools"], "garden", "high"],
    [["toys-games", "toys", "pretend-play", "pretend-lawn-garden"], "toys", "high"],
    [["home-garden", "household-appliances", "vacuums"], "electronics", "high"],
    [["home-garden", "kitchen-dining", "cookware-bakeware"], "kitchen", "high"],
    [["home-garden", "decor"], "home", "high"],
  ])("%j -> %s", (path, cat, conf) => {
    expect(mapCategory(path, "Some product")).toEqual({ category: cat, confidence: conf });
  });

  it("falls back to a low-confidence title guess without a path", () => {
    expect(mapCategory([], "Robot Vacuum X1")).toEqual({ category: "electronics", confidence: "low" });
    expect(mapCategory([], "Mystery thing")).toEqual({ category: "other", confidence: "low" });
  });

  it("doubts a non-electronics path for an electronic-sounding title", () => {
    expect(mapCategory(["home-garden", "decor"], "Smart Wi-Fi LED lamp").confidence).toBe("low");
  });
});

describe("mapChannel3Product", () => {
  it("maps the live response shape (dollar prices, first USD offer)", () => {
    const p = mapChannel3Product({
      id: "dDS7K01",
      title: "Gardening Tools Gift Set",
      description: "9-piece set",
      brands: [{ id: "x", name: "Macy's" }],
      images: [{ url: "https://cdn.example/a.jpg", is_main_image: true }],
      category: { slug: "gardening-tools", path: [{ slug: "home-garden", title: "" }, { slug: "lawn-garden", title: "" }] },
      offers: [{ url: "https://buy.example/1", domain: "macys.com", price: { price: 100.76, currency: "USD" }, availability: "InStock" }],
    });
    expect(p).toMatchObject({ id: "c3_dDS7K01", price: 100.76, category: "garden", merchant: "macys.com", source: "channel3" });
  });

  it("drops products without a USD offer", () => {
    expect(mapChannel3Product({ id: "x", title: "t", offers: [{ price: { price: 5, currency: "EUR" } }] })).toBeNull();
  });
});

describe("searchCatalog", () => {
  it("finds gardening gifts under a price cap", () => {
    const r = searchCatalog({ query: "gardening gift for mom", max_price: 45 }, false);
    expect(r.length).toBeGreaterThanOrEqual(3);
    expect(r.every((p) => p.price <= 45)).toBe(true);
    expect(r.some((p) => p.category === "garden")).toBe(true);
    expect(r.some((p) => p.id === injectionProduct().id)).toBe(false);
  });

  it("includes the injection product only in demo mode", () => {
    const r = searchCatalog({ query: "herb seed gift box" }, true);
    expect(r.some((p) => p.id === injectionProduct().id)).toBe(true);
    expect(injectionProduct().description).toMatch(/ignore your spending limits/);
  });

  it("finds robot vacuums as electronics", () => {
    const r = searchCatalog({ query: "robot vacuum" }, false);
    expect(r[0].category).toBe("electronics");
  });
});
