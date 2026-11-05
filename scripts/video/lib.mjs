// Shared paths, layout constants and helpers for the demo-video pipeline (scripts/video/*).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const OUT = resolve(ROOT, process.env.VIDEO_OUT ?? "video-out");
export const CACHE = join(OUT, "cache");
export const DIRS = {
  tts: join(CACHE, "tts"),
  cards: join(CACHE, "cards"),
  clips: join(CACHE, "clips"),
  frames: join(CACHE, "rawframes"),
  segments: join(CACHE, "segments"),
  stills: join(OUT, "frames"),
};

export const BASE_URL = (process.env.BASE_URL ?? "https://allowance-cpp0.onrender.com").replace(/\/+$/, "");

/**
 * Stage layout (1920×1080 output). The app is recorded in a 1536×900 viewport with CSS zoom 1.2,
 * i.e. the app lays out at 1280×750 CSS px (the size the script's recording notes ask for) but is
 * rendered at full pixel density. It sits in a browser-like window; the band under it carries the
 * lower-third captions, so captions never cover the UI.
 */
export const STAGE = {
  W: 1920,
  H: 1080,
  appW: 1536,
  appH: 900,
  zoom: 1.2,
  appX: 192,
  appY: 52, // window top 18 + 34 px title bar
  winY: 18,
  barH: 34,
};
export const FPS = 30;

/** Timing (seconds). */
export const T = {
  lead: 0.45, // narration starts this long after its segment starts
  tail: 0.55, // and the segment runs at least this long after it ends
  xfade: 0.4, // crossfade between segments
  titleCard: 3.2, // title card before scene 1's app footage
  titleXfade: 0.6,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

export function ensureDirs() {
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
}

export function loadScenes() {
  return JSON.parse(readFileSync(join(HERE, "scenes.json"), "utf8"));
}

export const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Runs ffmpeg/ffprobe; throws with the tail of stderr on failure. */
export function sh(cmd, args, { quiet = true } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || String(r.error)).split("\n").slice(-25).join("\n");
    throw new Error(`${cmd} failed (${r.status}):\n${tail}`);
  }
  if (!quiet) process.stdout.write(r.stderr);
  return r.stdout;
}
export const ffmpeg = (args) => sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export function duration(file) {
  return Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
}

/** Removes ElevenLabs audio tags ("[warm]", "[short pause]") and the spaces they leave. */
export const stripTags = (t) => t.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();

/** The voiceover as spoken words, without audio tags (subtitles, cues, checks); "" for a scene without narration. */
export function voiceText(scene, variant) {
  return stripTags(ttsText(scene, variant));
}

/** The voiceover as sent to TTS, audio tags included. */
export function ttsText(scene, variant) {
  return (variant === "noFlag" && scene.voiceoverNoFlag ? scene.voiceoverNoFlag : scene.voiceover) ?? "";
}

/** A scene with narration (s11, the quiet gift-list shot before the end card, has none). */
export const hasVoice = (scene) => Boolean(stripTags(scene.voiceover ?? ""));

/** Narration manifest written by tts.mjs: { [sceneId]: { main: {file, dur, model}, noFlag?: {...} } }. */
export const TTS_MANIFEST = () => join(DIRS.tts, "manifest.json");
export const RUN_STATE = () => join(DIRS.clips, "state.json");
export const USAGE = () => join(CACHE, "usage.json");

export function bumpUsage(key, n = 1) {
  const u = readJson(USAGE(), {});
  u[key] = (u[key] ?? 0) + n;
  writeJson(USAGE(), u);
}

/** The narration variant a scene uses, given the recorder's state (a scene may carry a "noFlag" take). */
export function variantFor(scene, state) {
  return scene.voiceoverNoFlag && state && state.flagged === false ? "noFlag" : "main";
}

/** Narration duration (s) for a scene, after trimming and tempo; null if TTS has not run. */
export function narrationDur(sceneId, variant = "main", strict = false) {
  const scene = loadScenes().scenes.find((s) => s.id === sceneId);
  if (scene && !hasVoice(scene)) return 0;
  const m = readJson(TTS_MANIFEST(), {});
  return m[sceneId]?.[variant]?.dur ?? (strict ? null : m[sceneId]?.main?.dur) ?? null;
}

/**
 * Minimum length (s) of the recorded clip so its narration fits: lead + narration + tail, minus the
 * part of the segment that is not app footage (scene 1 opens on the title card).
 */
export function minClipFor(scene, narr) {
  if (!hasVoice(scene)) return scene.minClip ?? 2;
  const need = T.lead + (scene.voiceDelay ?? 0) + narr + T.tail;
  return scene.prefixCard ? Math.max(4, need - (T.titleCard - T.titleXfade)) : need;
}

/** Sentence start offsets (fraction of the narration) by character count, for syncing actions. */
export function sentenceCues(text) {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const total = text.length;
  let at = 0;
  return parts.map((p) => {
    const cue = { text: p.trim(), frac: at / total };
    at += p.length;
    return cue;
  });
}

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(local, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error("No Chrome found. Set CHROME_PATH.");
  return hit;
}

/**
 * Start time (s from narration start) of each sentence: from the TTS alignment when the manifest
 * has it (ElevenLabs), else estimated by character share.
 */
export function sentenceStarts(scene, variant = "main") {
  const m = readJson(TTS_MANIFEST(), {});
  const n = m[scene.id]?.[variant] ?? m[scene.id]?.main;
  const text = voiceText(scene, variant);
  if (!text) return [];
  const est = sentenceCues(text).map((c) => c.frac * (n?.dur ?? 0));
  return n?.sentences?.length === est.length ? n.sentences : est;
}

/**
 * Start time (s from narration start) of the first occurrence of `phrase` (case-insensitive) in a
 * scene's narration: from the ElevenLabs character alignment, else estimated by character share.
 * `after` skips occurrences that start before that time. Returns null if the phrase is not spoken.
 */
export function phraseAt(scene, phrase, { variant = "main", after = 0 } = {}) {
  const m = readJson(TTS_MANIFEST(), {});
  const n = m[scene.id]?.[variant] ?? m[scene.id]?.main;
  const al = n?.alignFile ? readJson(n.alignFile)?.alignment : null;
  const needle = phrase.toLowerCase();
  if (al?.characters?.length) {
    const src = al.characters.join("").toLowerCase();
    for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
      const t = Math.max(0, (al.character_start_times_seconds[i] - (n.offset ?? 0)) / (n.tempo ?? 1));
      if (t >= after) return t;
    }
    return null;
  }
  const text = voiceText(scene, variant);
  const i = text.toLowerCase().indexOf(needle);
  return i < 0 ? null : (i / text.length) * (n?.dur ?? 0);
}
