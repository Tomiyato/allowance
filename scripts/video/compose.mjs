// Composes video-out/allowance-demo.mp4 (+ .srt and review stills) from the cached parts:
// TTS WAVs, recorded clips, card/caption PNGs. Needs no browser, no network, no AI.
//
// Per scene a 1920×1080 segment: app clip inside the stage frame, lower-third caption, "sped up"
// badge during sped-up waits (or a card). Segments are joined with short crossfades; each
// narration starts T.lead after its segment starts, and a segment is never shorter than
// lead + narration + tail, so narrations cannot be cut or overlap. Loudness: two-pass loudnorm
// to -16 LUFS. Output: H.264 yuv420p 30 fps + AAC 48 kHz.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardPng } from "./cards.mjs";
import {
  DIRS, FPS, OUT, RUN_STATE, STAGE, T, TTS_MANIFEST, duration, ensureDirs, ffmpeg, loadScenes, log, readJson, sentenceCues, sentenceStarts, sha,
  variantFor, voiceText, writeJson,
} from "./lib.mjs";

const SEG_VERSION = "seg-v6";
const END_HOLD = 2.4; // end card stays after the tagline
const FADE_OUT = 1.0;

const fmt = (s) => s.toFixed(3);
const pngKey = (name) => {
  const f = cardPng(name);
  if (!existsSync(f)) throw new Error(`Missing card ${f}; run the cards step.`);
  const st = statSync(f);
  return `${name}:${st.size}:${st.mtimeMs}`;
};

/** Plans every segment: length, narration file/duration, offsets. */
export function plan() {
  const cfg = loadScenes();
  const tts = readJson(TTS_MANIFEST(), {});
  const state = readJson(RUN_STATE(), {});
  const segs = [];
  let t = 0;
  for (const [i, s] of cfg.scenes.entries()) {
    const variant = variantFor(s, state);
    const n = tts[s.id]?.[variant] ?? tts[s.id]?.main;
    if (!n || !existsSync(n.file)) throw new Error(`No narration for ${s.id}; run TTS first.`);
    let clip = null;
    let base = 0;
    if (s.type === "app") {
      const file = join(DIRS.clips, `${s.id}.mp4`);
      const info = readJson(join(DIRS.clips, `${s.id}.json`));
      if (!existsSync(file) || !info) throw new Error(`No recorded clip for ${s.id}; run the recording step.`);
      clip = { file, ...info, dur: duration(file) };
      base = clip.dur + (s.prefixCard ? T.titleCard - T.titleXfade : 0);
    }
    const lead = T.lead + (s.voiceDelay ?? 0);
    const need = lead + n.dur + T.tail + (s.id === "s12" ? END_HOLD : 0);
    const len = Math.max(base, need);
    const start = i === 0 ? 0 : t - T.xfade;
    segs.push({ scene: s, variant, narr: n, clip, len, start, lead, padded: Math.max(0, len - base) * (s.type === "app" ? 1 : 0) });
    t = start + len;
  }
  return { cfg, segs, total: t, state };
}

export function buildAppSegment(seg, out) {
  const { scene: s, clip, len } = seg;
  const pre = s.prefixCard ? T.titleCard - T.titleXfade : 0;
  const compLen = len - pre;
  const inputs = ["-i", clip.file, "-loop", "1", "-framerate", String(FPS), "-t", fmt(compLen), "-i", cardPng("frame")];
  const f = [];
  f.push(`color=c=0xf4f6f7:s=${STAGE.W}x${STAGE.H}:r=${FPS}:d=${fmt(compLen)}[base]`);
  f.push(`[0:v]scale=out_range=tv,format=yuv420p,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${fmt(Math.max(0, compLen - clip.dur) + 0.5)}[clip]`);
  f.push(`[base][clip]overlay=${STAGE.appX}:${STAGE.appY}:eof_action=repeat[v1]`);
  f.push(`[v1][1:v]overlay=0:0[v2]`);
  let last = "v2";
  let idx = 2;
  if (clip.marks?.paypal?.length) {
    // PayPal's pages are on screen: the window's URL bar shows PayPal's host meanwhile.
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fmt(compLen), "-i", cardPng("frame-paypal"));
    const en = clip.marks.paypal.map(([a, b]) => `between(t,${fmt(a)},${fmt(b)})`).join("+");
    f.push(`[${last}][${idx}:v]overlay=0:0:enable='${en}'[vp]`);
    last = "vp";
    idx++;
  }
  if (s.caption) {
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fmt(compLen), "-i", cardPng(`caption-${s.id}`));
    const inAt = 0.5;
    const outAt = Math.max(inAt + 1, compLen - T.xfade - 0.55);
    f.push(`[${idx}:v]format=rgba,fade=t=in:st=${inAt}:d=0.45:alpha=1,fade=t=out:st=${fmt(outAt)}:d=0.45:alpha=1[cap]`);
    f.push(`[${last}][cap]overlay=0:0[v3]`);
    last = "v3";
    idx++;
  }
  if (clip.fast?.length) {
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fmt(compLen), "-i", cardPng("badge"));
    const en = clip.fast.map(([a, b]) => `between(t,${fmt(a)},${fmt(b)})`).join("+");
    f.push(`[${last}][${idx}:v]overlay=0:0:enable='${en}'[v4]`);
    last = "v4";
    idx++;
  }
  if (pre > 0) {
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fmt(T.titleCard), "-i", cardPng(s.prefixCard));
    f.push(`[${idx}:v]format=yuv420p,setsar=1[title]`);
    f.push(`[${last}]format=yuv420p,setsar=1[comp]`);
    f.push(`[title][comp]xfade=transition=fade:duration=${T.titleXfade}:offset=${fmt(pre)}[v5]`);
    last = "v5";
  }
  f.push(`[${last}]format=yuv420p,setsar=1,trim=duration=${fmt(len)}[out]`);
  encodeSegment(inputs, f, out, len);
}

export function buildCardSegment(seg, out) {
  const { scene: s, len, narr } = seg;
  const inputs = [];
  const f = [];
  if (s.card === "arch") {
    // Reveal in three steps on the narration's sentence cues (Gemini… / The model can only call tools…).
    const cues = sentenceStarts(s, seg.variant);
    const at = (k) => T.lead + cues[Math.min(k, cues.length - 1)] - 0.25;
    const t1 = at(1);
    const t2 = Math.max(t1 + 1.5, at(2));
    const XF = 0.5;
    const lens = [t1 + XF, t2 - t1 + XF, len - t2];
    ["arch-1", "arch-2", "arch-3"].forEach((n, i) => inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fmt(lens[i]), "-i", cardPng(n)));
    f.push(`[0:v]format=yuv420p,setsar=1[a0]`, `[1:v]format=yuv420p,setsar=1[a1]`, `[2:v]format=yuv420p,setsar=1[a2]`);
    f.push(`[a0][a1]xfade=transition=fade:duration=${XF}:offset=${fmt(t1)}[x1]`);
    f.push(`[x1][a2]xfade=transition=fade:duration=${XF}:offset=${fmt(t2)}[x2]`);
    f.push(`[x2]trim=duration=${fmt(len)}[out]`);
  } else {
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", fmt(len), "-i", cardPng(s.card));
    f.push(`[0:v]format=yuv420p,setsar=1,trim=duration=${fmt(len)}[out]`);
  }
  encodeSegment(inputs, f, out, len);
}

function encodeSegment(inputs, filters, out, len) {
  ffmpeg([
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[out]", "-r", String(FPS), "-t", fmt(len),
    "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-pix_fmt", "yuv420p", "-color_range", "tv", "-an", out,
  ]);
}

/** SRT cues: sentences split at commas/colons into ≤ 84-char chunks, timed by character share. */
function srtCues(text, start, dur) {
  const chunks = [];
  for (const sent of sentenceCues(text).map((c) => c.text)) {
    if (sent.length <= 84) {
      chunks.push(sent);
      continue;
    }
    let cur = "";
    for (const part of sent.split(/(?<=[,:])\s+/)) {
      if (cur && (cur + " " + part).length > 84) {
        chunks.push(cur);
        cur = part;
      } else cur = cur ? `${cur} ${part}` : part;
    }
    if (cur) chunks.push(cur);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  let t = start;
  return chunks.map((c) => {
    const d = (c.length / total) * dur;
    const cue = { a: t, b: t + d, text: wrap(c) };
    t += d;
    return cue;
  });
}
function wrap(s, w = 42) {
  if (s.length <= w) return s;
  const mid = s.length / 2;
  let best = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? s : `${s.slice(0, best)}\n${s.slice(best + 1)}`;
}
const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export async function compose() {
  ensureDirs();
  const { cfg, segs, total } = plan();
  log(`Compose: ${segs.length} segments, ${total.toFixed(2)} s`);

  // 1. Segments (cached by their inputs).
  for (const seg of segs) {
    const s = seg.scene;
    const out = join(DIRS.segments, `${s.id}.mp4`);
    const keyParts = [SEG_VERSION, fmt(seg.len), seg.variant, JSON.stringify(T)];
    if (seg.clip) keyParts.push(`${statSync(seg.clip.file).size}:${statSync(seg.clip.file).mtimeMs}`, JSON.stringify(seg.clip.fast ?? []), JSON.stringify(seg.clip.marks ?? {}), pngKey("frame"), pngKey("badge"));
    if (seg.clip?.marks?.paypal?.length) keyParts.push(pngKey("frame-paypal"));
    if (s.caption) keyParts.push(pngKey(`caption-${s.id}`));
    if (s.prefixCard) keyParts.push(pngKey(s.prefixCard));
    if (s.card === "arch") keyParts.push(pngKey("arch-1"), pngKey("arch-2"), pngKey("arch-3"), fmt(seg.narr.dur));
    else if (s.card) keyParts.push(pngKey(s.card));
    const key = sha(keyParts.join("|"));
    const keyFile = join(DIRS.segments, `${s.id}.key`);
    if (existsSync(out) && readJson(keyFile)?.key === key) continue;
    log(`  segment ${s.id} (${seg.len.toFixed(2)} s)`);
    if (s.type === "app") buildAppSegment(seg, out);
    else buildCardSegment(seg, out);
    writeJson(keyFile, { key });
  }

  // 2. Narration track: each WAV at its segment start + lead, two-pass loudnorm to -16 LUFS.
  const mixIn = [];
  const mixF = [];
  segs.forEach((seg, i) => {
    mixIn.push("-i", seg.narr.file);
    const ms = Math.round((seg.start + seg.lead) * 1000);
    mixF.push(`[${i}:a]aresample=48000,afade=t=in:d=0.02,afade=t=out:st=${fmt(Math.max(0, seg.narr.dur - 0.04))}:d=0.04,adelay=${ms}:all=1[n${i}]`);
  });
  mixF.push(`${segs.map((_, i) => `[n${i}]`).join("")}amix=inputs=${segs.length}:normalize=0:dropout_transition=0,apad=whole_dur=${fmt(total)},atrim=duration=${fmt(total)}[mix]`);
  const rawMix = join(DIRS.segments, "narration-mix.wav");
  ffmpeg([...mixIn, "-filter_complex", mixF.join(";") + ";[mix]pan=stereo|c0=c0|c1=c0[st]", "-map", "[st]", "-c:a", "pcm_s16le", rawMix]);
  const m = JSON.parse(/\{[\s\S]*?\}/.exec(measureStderr(rawMix))?.[0] ?? "null");
  if (!m) throw new Error("loudnorm measurement failed");
  const narration = join(DIRS.segments, "narration.wav");
  ffmpeg([
    "-i", rawMix,
    "-af", `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000,alimiter=limit=0.63:attack=2:release=60:level=false`,
    "-c:a", "pcm_s16le", narration,
  ]);

  // 3. Video: crossfade chain, fade in/out, mux.
  const vin = [];
  const vf = [];
  segs.forEach((seg) => vin.push("-i", join(DIRS.segments, `${seg.scene.id}.mp4`)));
  let last = "[0:v]";
  let acc = segs[0].len;
  for (let i = 1; i < segs.length; i++) {
    const off = acc - T.xfade;
    vf.push(`${last}[${i}:v]xfade=transition=fade:duration=${T.xfade}:offset=${fmt(off)}[x${i}]`);
    last = `[x${i}]`;
    acc = off + segs[i].len;
  }
  vf.push(`${last}fade=t=in:st=0:d=0.35,fade=t=out:st=${fmt(total - FADE_OUT)}:d=${FADE_OUT},format=yuv420p[v]`);
  const mp4 = join(OUT, "allowance-demo.mp4");
  vin.push("-i", narration);
  log("  final encode");
  ffmpeg([
    ...vin,
    "-filter_complex", vf.join(";"),
    "-map", "[v]", "-map", `${segs.length}:a`,
    "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-color_range", "tv", "-colorspace", "bt470bg", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-af", `afade=t=out:st=${fmt(total - FADE_OUT)}:d=${FADE_OUT}`,
    "-t", fmt(total), "-movflags", "+faststart", mp4,
  ]);

  // 4. Subtitles.
  const cues = segs.flatMap((seg) => srtCues(voiceText(seg.scene, seg.variant), seg.start + seg.lead, seg.narr.dur));
  writeFileSync(join(OUT, "allowance-demo.srt"), cues.map((c, i) => `${i + 1}\n${srtTime(c.a)} --> ${srtTime(c.b)}\n${c.text}\n`).join("\n"));

  // 5. Review stills, one per scene, near the end of each segment (the result on screen); "s03@paypal"
  // is the last moment of PayPal's own approval page in scene 3.
  rmSync(DIRS.stills, { recursive: true, force: true });
  mkdirSync(DIRS.stills, { recursive: true });
  for (const [k, entry] of cfg.stills.entries()) {
    const [id, where] = entry.split("@");
    const seg = segs.find((x) => x.scene.id === id);
    if (!seg) continue;
    let at = seg.start + seg.len - T.xfade - 0.7;
    if (where === "paypal") {
      const mark = seg.clip?.marks?.paypal?.at(-1);
      if (!mark) continue;
      at = seg.start + (seg.scene.prefixCard ? T.titleCard - T.titleXfade : 0) + mark[1] - 0.6;
    }
    const name = `${String(k + 1).padStart(2, "0")}-${id}${where ? `-${where}` : ""}.png`;
    ffmpeg(["-ss", fmt(at), "-i", mp4, "-frames:v", "1", join(DIRS.stills, name)]);
  }

  // 6. Timing report: narration windows never overlap and are never cut.
  const rows = segs.map((seg, i) => {
    const a = seg.start + seg.lead;
    const b = a + seg.narr.dur;
    const next = segs[i + 1] ? segs[i + 1].start + segs[i + 1].lead : total;
    return {
      id: seg.scene.id,
      model: seg.narr.model,
      narr: Number(seg.narr.dur.toFixed(2)),
      seg: Number(seg.len.toFixed(2)),
      clip: seg.clip ? Number(seg.clip.dur.toFixed(2)) : null,
      padded: Number(seg.padded.toFixed(2)),
      start: Number(seg.start.toFixed(2)),
      voice: `${a.toFixed(2)}-${b.toFixed(2)}`,
      gapToNext: Number((next - b).toFixed(2)),
    };
  });
  const bad = rows.filter((r) => r.gapToNext < 0.2);
  const final = duration(mp4);
  writeJson(join(OUT, "timing.json"), { total: final, rows });
  console.table(rows);
  log(`Wrote ${mp4} (${final.toFixed(2)} s = ${Math.floor(final / 60)}:${String(Math.round(final % 60)).padStart(2, "0")})`);
  if (bad.length) throw new Error(`Narration overlap or cut in ${bad.map((r) => r.id).join(", ")}`);
  if (final < 150 || final > 178) log(`WARNING: duration ${final.toFixed(1)} s is outside 2:30–2:58.`);
  return { mp4, total: final, rows };
}

function measureStderr(file) {
  // loudnorm prints its JSON on stderr; sh() returns stdout, so run ffmpeg directly here.
  return spawnStderr("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
}
function spawnStderr(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr.slice(-800)}`);
  return r.stderr;
}
