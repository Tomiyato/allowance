// Voiceover: one WAV per scene with Gemini TTS, cached per (text, voice, style, model).
//
// One voice for the whole video: every scene uses the same model. The model chain comes from
// scenes.json tts.models (gemini-3.8-flash-tts → gemini-3.1-flash-tts-preview →
// gemini-2.5-flash-preview-tts). The first model that has, or can still produce, every scene wins;
// a model whose daily quota runs out is dropped for the whole set. Only when every model is out of
// quota does it mix (the model with most takes, gaps from the others), with a loud warning.
// Re-running later (after the quota resets) completes the preferred model and switches to it.
// Spent daily quotas are remembered in video-out/cache/tts/quota.json so re-runs do not waste calls.
// Force one model with TTS_MODEL=…, one voice with TTS_VOICE=….
//
// Request: the Interactions API (POST /v1beta/interactions) with the style in a speech_metadata
// annotation, so it is not read aloud (via generateContent the 3.8 model reads a "Say in a …
// tone:" prefix aloud). Models that refuse speech metadata fall back to generateContent with
// responseModalities ["AUDIO"] and plain text. Response audio is a WAV (24 kHz mono s16le) or raw
// L16 PCM, which is wrapped into a WAV here.
//
// Responses are requested gzip-compressed: on some networks uncompressed transfers from
// googleapis.com crawl at ~1 KB/s while compressed ones are fast.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DIRS, ROOT, RUN_STATE, TTS_MANIFEST, bumpUsage, duration, ensureDirs, ffmpeg, loadScenes, log, readJson, sha, sleep, writeJson } from "./lib.mjs";

const API = "https://generativelanguage.googleapis.com/v1beta";
const TEMPO = Number(process.env.VO_TEMPO ?? 1.0);

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const env = existsSync(join(ROOT, ".env")) ? readFileSync(join(ROOT, ".env"), "utf8") : "";
  const m = env.match(/^GEMINI_API_KEY=(.*)$/m);
  if (!m || !m[1].trim()) throw new Error("GEMINI_API_KEY is not set (env or .env).");
  return m[1].trim();
}

class HttpError extends Error {
  constructor(status, msg) {
    super(`HTTP ${status}: ${msg}`);
    this.status = status;
    this.daily = status === 429 && /per.?day/i.test(msg);
    const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(msg);
    this.retryAfter = m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3])) : null;
  }
}

async function post(url, body, key) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-encoding": "gzip", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new HttpError(r.status, (j?.error?.message ?? text).slice(0, 1500));
  return j;
}

/** Returns { mime, data: Buffer } from either API's response. */
function extractAudio(j) {
  for (const step of j?.steps ?? []) {
    for (const c of step.content ?? []) if (c.type === "audio" && c.data) return { mime: c.mime_type ?? "", data: Buffer.from(c.data, "base64") };
  }
  for (const part of j?.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) return { mime: part.inlineData.mimeType ?? "", data: Buffer.from(part.inlineData.data, "base64") };
  }
  throw new Error("no audio in the response");
}

function pcmToWav(pcm, rate = 24000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function toWav({ mime, data }) {
  if (data.subarray(0, 4).toString("latin1") === "RIFF") return data;
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
  return pcmToWav(data, rate);
}

const noMetadata = new Set(); // models that refused speech metadata on the interactions API

async function synth(model, text, voice, style, key) {
  if (!noMetadata.has(model)) {
    try {
      const j = await post(
        `${API}/interactions`,
        {
          model,
          input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice }] },
        },
        key,
      );
      return { wav: toWav(extractAudio(j)), styled: true };
    } catch (e) {
      if (!(e instanceof HttpError) || ![400, 404].includes(e.status)) throw e;
      noMetadata.add(model);
      log(`  ${model}: interactions API refused (${e.message.slice(0, 90)}); using generateContent with plain text`);
    }
  }
  const j = await post(
    `${API}/models/${model}:generateContent`,
    {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    },
    key,
  );
  return { wav: toWav(extractAudio(j)), styled: false };
}

/** Trims leading/trailing silence, applies VO_TEMPO, resamples to 48 kHz mono. */
function postprocess(raw, out) {
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06";
  const filters = [trim, "areverse", trim, "areverse"];
  if (TEMPO !== 1) filters.push(`atempo=${TEMPO}`);
  filters.push("aresample=48000");
  ffmpeg(["-i", raw, "-af", filters.join(","), "-ac", "1", "-c:a", "pcm_s16le", out]);
}

/** Cached raw takes, from the sidecar JSONs: key(text, voice, style, model) → raw wav path. */
function scanCache() {
  const idx = new Map();
  for (const f of readdirSync(DIRS.tts)) {
    if (!f.endsWith(".json") || f === "manifest.json" || f === "quota.json") continue;
    const m = readJson(join(DIRS.tts, f));
    const raw = join(DIRS.tts, f.replace(/\.json$/, ".raw.wav"));
    if (m?.model && existsSync(raw)) idx.set(cacheKey(m.text, m.voice, m.style, m.model), { raw, meta: m });
  }
  return idx;
}
const cacheKey = (text, voice, style, model) => sha(JSON.stringify([text, voice, style, model]));

/**
 * Generates (or reuses) the narration for every scene with one model, and writes the manifest.
 * withVariants: also the s06 "noFlag" take (default: only when the last recording saw no flag).
 */
export async function runTts({ withVariants } = {}) {
  ensureDirs();
  const cfg = loadScenes();
  const { style } = cfg.tts;
  const voice = process.env.TTS_VOICE ?? cfg.tts.voice;
  const chain = process.env.TTS_MODEL ? [process.env.TTS_MODEL] : cfg.tts.models;
  const state = readJson(RUN_STATE(), null);
  const variants = withVariants ?? state?.flagged === false;
  const items = [];
  for (const s of cfg.scenes) {
    items.push({ s, variant: "main", text: s.voiceover });
    if (s.voiceoverNoFlag && variants) items.push({ s, variant: "noFlag", text: s.voiceoverNoFlag });
  }
  const cache = scanCache();
  const missing = (model) => items.filter((it) => !cache.has(cacheKey(it.text, voice, style, model)));

  const QUOTA = join(DIRS.tts, "quota.json");
  const quota = readJson(QUOTA, {});
  let key;
  let requests = 0;
  let chosen = null;
  for (const model of chain) {
    const todo = missing(model);
    if (!todo.length) {
      chosen = model;
      break;
    }
    const until = quota[model] ?? 0;
    if (until > Date.now()) {
      log(`TTS: ${model} needs ${todo.length} take(s) but its daily quota is spent until ${new Date(until).toLocaleString()}; skipping`);
      continue;
    }
    log(`TTS: ${model} needs ${todo.length} of ${items.length} take(s)`);
    key ??= apiKey();
    let failed = null;
    for (const it of todo) {
      let lastErr = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          log(`TTS ${it.s.id}/${it.variant}: ${model} (attempt ${attempt})`);
          requests++;
          bumpUsage("tts_requests");
          const { wav, styled } = await synth(model, it.text, voice, style, key);
          bumpUsage(`tts_ok:${model}`);
          const base = join(DIRS.tts, `${it.s.id}-${it.variant}-${cacheKey(it.text, voice, style, model)}`);
          writeFileSync(`${base}.raw.wav`, wav);
          const meta = { model, voice, style, styled, text: it.text };
          writeJson(`${base}.json`, meta);
          cache.set(cacheKey(it.text, voice, style, model), { raw: `${base}.raw.wav`, meta });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const detail = e.status === 429 ? ` [${(e.message.match(/metric: [\w./-]+|limit: \d+|quotaId[^,]*|retry in [\w.]+/g) ?? []).join(", ")}]` : "";
          log(`  ${it.s.id}/${it.variant}: ${e.message.slice(0, 120)}${detail}`);
          if (e instanceof HttpError && (e.daily || (e.status >= 400 && e.status < 500 && e.status !== 429))) break;
          const wait = e instanceof HttpError && e.retryAfter != null ? e.retryAfter + 2 : (e instanceof HttpError && e.status === 429 ? 30 : 10) * attempt;
          if (wait > 180) break;
          if (attempt < 4) await sleep(wait * 1000);
        }
      }
      if (lastErr) {
        failed = lastErr;
        break;
      }
    }
    if (!failed) {
      chosen = model;
      break;
    }
    if (failed instanceof HttpError && failed.daily && failed.retryAfter) {
      quota[model] = Date.now() + failed.retryAfter * 1000;
      writeJson(QUOTA, quota);
    }
    log(`TTS: dropping ${model} for this run (${failed.message.slice(0, 120)})`);
  }
  // Last resort (every model's quota ran out): the model with the most takes, gaps filled from the
  // others in chain order. Logged loudly; a later run with quota switches back to one model.
  const pick = new Map();
  if (chosen) {
    for (const it of items) pick.set(it, chosen);
  } else {
    const cover = (m) => items.length - missing(m).length;
    const primary = [...chain].sort((a, b) => cover(b) - cover(a))[0];
    for (const it of items) {
      const m = [primary, ...chain].find((x) => cache.has(cacheKey(it.text, voice, style, x)));
      if (!m) throw new Error(`TTS: no model has a take for ${it.s.id}/${it.variant} and none has quota left. Try again later.`);
      pick.set(it, m);
    }
    const odd = items.filter((it) => pick.get(it) !== primary).map((it) => `${it.s.id}/${it.variant} → ${pick.get(it)}`);
    log(`TTS WARNING: no single model could voice every scene today; using ${primary} with ${odd.join(", ") || "no gaps"}`);
  }

  const manifest = {};
  let total = 0;
  for (const it of items) {
    const { raw, meta } = cache.get(cacheKey(it.text, voice, style, pick.get(it)));
    const out = raw.replace(/\.raw\.wav$/, `-t${TEMPO}.wav`);
    if (!existsSync(out)) postprocess(raw, out);
    manifest[it.s.id] ??= {};
    manifest[it.s.id][it.variant] = { file: out, dur: duration(out), rawDur: duration(raw), model: meta.model, voice: meta.voice, styled: !!meta.styled, words: it.text.split(/\s+/).length };
    if (it.variant === "main") total += manifest[it.s.id].main.dur;
  }
  writeJson(TTS_MANIFEST(), manifest);
  for (const it of items) {
    const m = manifest[it.s.id][it.variant];
    log(`  ${it.s.id}/${it.variant}: ${m.dur.toFixed(2)} s (${m.words} words, ${Math.round((m.words / m.dur) * 60)} wpm)`);
  }
  log(`TTS: ${chosen ?? "mixed models"}, voice ${voice}${manifest.s01.main.styled ? ", style annotation" : ", plain text (model takes no style)"}; ${requests} request(s) this run; narration ${total.toFixed(1)} s`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runTts({ withVariants: process.argv.includes("--variants") ? true : undefined });
}
