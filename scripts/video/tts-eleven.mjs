// Voiceover with ElevenLabs (the default provider, scenes.json tts.provider = "elevenlabs").
//
// One model and one voice for every scene (scenes.json tts.elevenlabs: model eleven_v4, voice
// "Jaya" inSavBKUniNDYIfIcSyG, language_code "en", a fixed seed so retakes are stable,
// output mp3_44100_192). Voiceovers carry inline audio tags ("[warm]", "[short pause]"); they go to
// the model as written and are stripped everywhere else (subtitles, cues, checks: lib.voiceText).
// eleven_v4 ignores `speed`; fit length with the script's pauses or VO_TEMPO (atempo ≤ 1.05).
//
// Request: POST /v1/text-to-speech/{voice_id}/with-timestamps, so each take comes with a character
// alignment. It trims the take to the first and last spoken character and gives each sentence's
// start time (manifest `sentences`), which the recorder syncs its actions to.
// Cache: one raw take per (tagged text, voice, model, settings) in video-out/cache/tts/el-*.
// Overrides: ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, ELEVENLABS_SEED, VO_TEMPO.
// Key: ELEVENLABS_API_KEY from the environment or .env (read by Node; never printed).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIRS, ROOT, RUN_STATE, TTS_MANIFEST, bumpUsage, duration, ensureDirs, ffmpeg, hasVoice, loadScenes, log, readJson, sentenceCues, sha, sleep, stripTags, ttsText, writeJson } from "./lib.mjs";

const API = "https://api.elevenlabs.io/v1";
const TEMPO = Number(process.env.VO_TEMPO ?? 1.0);

function apiKey() {
  if (!process.env.ELEVENLABS_API_KEY && existsSync(join(ROOT, ".env"))) {
    try {
      process.loadEnvFile(join(ROOT, ".env"));
    } catch {
      /* unreadable .env */
    }
  }
  const k = process.env.ELEVENLABS_API_KEY?.trim();
  if (!k) throw new Error("ELEVENLABS_API_KEY is not set (env or .env).");
  return k;
}

export function elevenSettings(cfg = loadScenes()) {
  const e = cfg.tts.elevenlabs ?? {};
  return {
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? e.voiceId,
    voiceName: process.env.ELEVENLABS_VOICE_ID ? process.env.ELEVENLABS_VOICE_ID : e.voiceName,
    model: process.env.ELEVENLABS_MODEL_ID ?? e.model ?? "eleven_v4",
    seed: Number(process.env.ELEVENLABS_SEED ?? e.seed ?? 4242),
    languageCode: e.languageCode ?? "en",
    outputFormat: e.outputFormat ?? "mp3_44100_192",
    voiceSettings: e.voiceSettings ?? null,
  };
}

async function synth(text, st, key) {
  const url = `${API}/text-to-speech/${encodeURIComponent(st.voiceId)}/with-timestamps?output_format=${st.outputFormat}`;
  const body = { text, model_id: st.model, language_code: st.languageCode, seed: st.seed };
  if (st.voiceSettings) body.voice_settings = st.voiceSettings;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": key, accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const raw = await r.text();
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}: ${raw.slice(0, 400)}`);
    e.status = r.status;
    throw e;
  }
  const j = JSON.parse(raw);
  return { audio: Buffer.from(j.audio_base64, "base64"), alignment: j.alignment ?? null };
}

/** Spoken span [first, last] in seconds from the alignment, skipping tag characters and spaces. */
function spokenSpan(text, al) {
  if (!al?.characters?.length) return null;
  const inTag = new Array(al.characters.length).fill(false);
  let depth = 0;
  al.characters.forEach((c, i) => {
    if (c === "[") depth++;
    inTag[i] = depth > 0;
    if (c === "]") depth = Math.max(0, depth - 1);
  });
  let a = -1;
  let b = -1;
  al.characters.forEach((c, i) => {
    if (inTag[i] || !/[\p{L}\p{N}]/u.test(c)) return;
    if (a < 0) a = i;
    b = i;
  });
  if (a < 0) return null;
  return { start: al.character_start_times_seconds[a], end: al.character_end_times_seconds[b], inTag };
}

/** Start time (s, relative to the trimmed take) of each plain-text sentence. */
function sentenceTimes(tagged, al, offset) {
  if (!al?.characters?.length) return null;
  const src = al.characters.join("");
  const plain = stripTags(tagged);
  const out = [];
  let from = 0;
  for (const c of sentenceCues(plain)) {
    const probe = c.text.slice(0, Math.min(18, c.text.length));
    const i = src.indexOf(probe, from);
    if (i < 0) return null;
    out.push(Math.max(0, al.character_start_times_seconds[i] - offset));
    from = i + probe.length;
  }
  return out;
}

const cacheKey = (text, st) => sha(JSON.stringify(["el", text, st.voiceId, st.model, st.seed, st.languageCode, st.outputFormat, st.voiceSettings]));

export async function runEleven({ withVariants } = {}) {
  ensureDirs();
  const cfg = loadScenes();
  const st = elevenSettings(cfg);
  if (!st.voiceId) throw new Error("No ElevenLabs voice: set scenes.json tts.elevenlabs.voiceId or ELEVENLABS_VOICE_ID.");
  const state = readJson(RUN_STATE(), null);
  const variants = withVariants ?? state?.flagged === false;
  const items = [];
  for (const s of cfg.scenes) {
    if (!hasVoice(s)) continue; // a quiet shot (s11)
    items.push({ s, variant: "main", text: ttsText(s, "main") });
    if (s.voiceoverNoFlag && variants) items.push({ s, variant: "noFlag", text: ttsText(s, "noFlag") });
  }
  let key = null;
  let requests = 0;
  let chars = 0;
  const manifest = {};
  let total = 0;
  for (const it of items) {
    const k = cacheKey(it.text, st);
    const base = join(DIRS.tts, `el-${it.s.id}-${it.variant}-${k}`);
    if (!existsSync(`${base}.raw.wav`) || !existsSync(`${base}.json`)) {
      key ??= apiKey();
      let res = null;
      for (let attempt = 1; attempt <= 3 && !res; attempt++) {
        try {
          log(`TTS ${it.s.id}/${it.variant}: ElevenLabs ${st.model} (${it.text.length} chars, attempt ${attempt})`);
          requests++;
          chars += it.text.length;
          bumpUsage("elevenlabs_requests");
          bumpUsage("elevenlabs_chars", it.text.length);
          res = await synth(it.text, st, key);
        } catch (e) {
          log(`  ${it.s.id}/${it.variant}: ${e.message.slice(0, 200)}`);
          if (e.status && e.status < 500 && e.status !== 429) throw e;
          if (attempt < 3) await sleep(8000 * attempt);
          else throw e;
        }
      }
      writeFileSync(`${base}.mp3`, res.audio);
      ffmpeg(["-i", `${base}.mp3`, "-ac", "1", "-c:a", "pcm_s16le", `${base}.raw.wav`]);
      writeJson(`${base}.json`, { provider: "elevenlabs", model: st.model, voice: st.voiceId, voiceName: st.voiceName, seed: st.seed, text: it.text, alignment: res.alignment });
    }
    const meta = readJson(`${base}.json`);
    const raw = `${base}.raw.wav`;
    const rawDur = duration(raw);
    const span = spokenSpan(it.text, meta.alignment);
    // Trim to the spoken span (small margins), else fall back to a silence trim.
    const a = span ? Math.max(0, span.start - 0.06) : 0;
    const b = span ? Math.min(rawDur, span.end + 0.18) : rawDur;
    const out = `${base}-t${TEMPO}.wav`;
    if (!existsSync(out)) {
      const f = span ? [`atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)}`, "asetpts=PTS-STARTPTS"] : ["silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06", "areverse", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06", "areverse"];
      if (TEMPO !== 1) f.push(`atempo=${TEMPO}`);
      f.push("aresample=48000");
      ffmpeg(["-i", raw, "-af", f.join(","), "-ac", "1", "-c:a", "pcm_s16le", out]);
    }
    const sentences = sentenceTimes(it.text, meta.alignment, a)?.map((t) => Number((t / TEMPO).toFixed(3))) ?? null;
    const words = stripTags(it.text).split(/\s+/).length;
    manifest[it.s.id] ??= {};
    manifest[it.s.id][it.variant] = {
      file: out, dur: duration(out), rawDur, model: `elevenlabs:${meta.model}`, voice: meta.voiceName ?? meta.voice, voiceId: meta.voice, styled: true, words, sentences,
      // For phrase-level sync (lib.phraseAt): the alignment lives in the take's JSON; times there are
      // relative to the untrimmed take, so the trim offset and tempo come along.
      alignFile: `${base}.json`, offset: Number(a.toFixed(3)), tempo: TEMPO,
    };
    if (it.variant === "main") total += manifest[it.s.id].main.dur;
  }
  writeJson(TTS_MANIFEST(), manifest);
  for (const it of items) {
    const m = manifest[it.s.id][it.variant];
    log(`  ${it.s.id}/${it.variant}: ${m.dur.toFixed(2)} s (${m.words} words, ${Math.round((m.words / m.dur) * 60)} wpm)${m.sentences ? "" : " [no alignment]"}`);
  }
  log(`TTS: ElevenLabs ${st.model}, voice ${st.voiceName ?? st.voiceId}, seed ${st.seed}; ${requests} request(s), ${chars} chars this run; narration ${total.toFixed(1)} s`);
  return manifest;
}
