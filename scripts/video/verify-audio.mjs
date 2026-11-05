// Listen-check of the final narration: one Gemini request transcribes the mixed narration track
// (video-out/cache/segments/narration.wav) and the words are diffed against scenes.json, so a
// truncated, garbled or extra phrase in a TTS take shows up. Optional: npm run video -- --verify-audio
// Uses VERIFY_MODEL (default gemini-3.8-flash), not the app's model, to leave its quota alone; when
// Gemini fails (overloaded, quota) it falls back to Groq Whisper (VERIFY_GROQ_MODEL, default
// whisper-large-v3). VERIFY_PROVIDER=groq skips Gemini. The transcript is saved to
// video-out/cache/segments/narration-transcript.txt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIRS, ROOT, RUN_STATE, bumpUsage, ffmpeg, loadScenes, log, readJson, variantFor, voiceText } from "./lib.mjs";

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\$?150/g, "a hundred and fifty")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Word-level LCS diff: returns { missing: [...], extra: [...], ratio }. */
function diff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const missing = [];
  const extra = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) missing.push(`${a[i++]}@${i}`);
    else extra.push(`${b[j++]}@${i}`);
  }
  while (i < n) missing.push(`${a[i++]}@${i}`);
  while (j < m) extra.push(`${b[j++]}@${i}`);
  return { missing, extra, ratio: dp[0][0] / Math.max(1, n) };
}

/** Gemini transcription of the narration (one request). */
async function transcribeGemini(ogg) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.VERIFY_MODEL ?? "gemini-3.8-flash";
  bumpUsage("verify_requests");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-encoding": "gzip", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "audio/ogg", data: readFileSync(ogg).toString("base64") } },
            { text: "Transcribe this narration verbatim, every word exactly as spoken, as plain text without timestamps or speaker labels." },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini ${model}: HTTP ${r.status}: ${j?.error?.message?.slice(0, 160)}`);
  return { model, heard: j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(" ") ?? "" };
}

/** Groq Whisper transcription (fallback when Gemini is overloaded or out of quota). */
async function transcribeGroq(ogg) {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const model = process.env.VERIFY_GROQ_MODEL ?? "whisper-large-v3";
  bumpUsage("verify_requests");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(ogg)], { type: "audio/ogg" }), "narration.ogg");
  form.append("model", model);
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("response_format", "json");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Groq ${model}: HTTP ${r.status}: ${JSON.stringify(j?.error ?? j).slice(0, 160)}`);
  return { model: `groq:${model}`, heard: j.text ?? "" };
}

export async function verifyAudio() {
  const cfg = loadScenes();
  const state = readJson(RUN_STATE(), {});
  const src = join(DIRS.segments, "narration.wav");
  if (!existsSync(src)) throw new Error("No narration.wav yet; compose first.");
  const ogg = join(DIRS.segments, "narration-check.ogg");
  ffmpeg(["-i", src, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", ogg]);
  if (existsSync(join(ROOT, ".env"))) {
    try {
      process.loadEnvFile(join(ROOT, ".env"));
    } catch {
      /* unreadable .env */
    }
  }
  const order = process.env.VERIFY_PROVIDER === "groq" ? [transcribeGroq] : [transcribeGemini, transcribeGroq];
  let res = null;
  for (const fn of order) {
    try {
      res = await fn(ogg);
      break;
    } catch (e) {
      log(`  verify: ${e.message}`);
    }
  }
  if (!res) throw new Error("verify: no transcription service answered");
  const { heard, model } = res;
  const expected = cfg.scenes.map((s) => voiceText(s, variantFor(s, state))).join(" ");
  const d = diff(norm(expected), norm(heard));
  log(`Transcript (${model}): ${heard.length} chars; ${(d.ratio * 100).toFixed(1)}% of the script's words heard in order`);
  if (d.missing.length) log(`  not heard: ${d.missing.join(" ")}`);
  if (d.extra.length) log(`  extra: ${d.extra.join(" ")}`);
  writeFileSync(join(DIRS.segments, "narration-transcript.txt"), heard);
  return { heard, ...d };
}
