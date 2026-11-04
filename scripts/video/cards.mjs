// Renders the title/architecture/end cards, the stage frame, lower-third captions and the
// "sped up" badge from HTML (scripts/video/cards/*.html) to 1920×1080 PNGs. Cached by content hash.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { BASE_URL, DIRS, HERE, ensureDirs, findChrome, loadScenes, log, readJson, sha, writeJson } from "./lib.mjs";

const CARD_DIR = join(HERE, "cards");
const INDEX = () => join(DIRS.cards, "index.json");

/** The list of PNGs to render: { name, file, query, transparent }. */
function jobs() {
  const cfg = loadScenes();
  const host = new URL(BASE_URL).host;
  const list = [
    { name: "title", file: "title.html" },
    { name: "end", file: "end.html" },
    { name: "arch-1", file: "arch.html", query: "step=1" },
    { name: "arch-2", file: "arch.html", query: "step=2" },
    { name: "arch-3", file: "arch.html", query: "step=3" },
    { name: "frame", file: "overlay.html", query: `kind=frame&host=${encodeURIComponent(host)}`, transparent: true },
    { name: "badge", file: "overlay.html", query: "kind=badge", transparent: true },
  ];
  for (const s of cfg.scenes) {
    if (s.caption) list.push({ name: `caption-${s.id}`, file: "overlay.html", query: `kind=caption&text=${encodeURIComponent(s.caption)}`, transparent: true });
  }
  return list;
}

export const cardPng = (name) => join(DIRS.cards, `${name}.png`);

export async function renderCards({ force = false } = {}) {
  ensureDirs();
  const theme = readFileSync(join(CARD_DIR, "theme.css"), "utf8");
  const index = readJson(INDEX(), {});
  const todo = jobs().filter((j) => {
    j.hash = sha(theme + readFileSync(join(CARD_DIR, j.file), "utf8") + (j.query ?? ""));
    return force || index[j.name] !== j.hash || !existsSync(cardPng(j.name));
  });
  if (!todo.length) {
    log("Cards: all cached");
    return;
  }
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    for (const j of todo) {
      const url = pathToFileURL(join(CARD_DIR, j.file)).href + (j.query ? `?${j.query}` : "");
      await page.goto(url, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: cardPng(j.name), type: "png", omitBackground: !!j.transparent });
      index[j.name] = j.hash;
      log(`Card ${j.name}.png`);
    }
  } finally {
    await browser.close();
  }
  writeJson(INDEX(), index);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await renderCards({ force: process.argv.includes("--force") });
}
