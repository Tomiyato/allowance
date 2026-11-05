// Screen recorder for one page: CDP Page.startScreencast frames (JPEG) with wall-clock timestamps,
// plus "fast" (sped-up) and "cut" spans, encoded to a constant-30-fps H.264 clip.
//
// Chrome only sends a frame when the picture changes, so each frame is held until the next one;
// the timeline is remapped so waits for the AI run 2-15× faster (badge shown) and cooldowns on a
// static screen are cut. clips/<id>.json records the clip length and the badge intervals.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIRS, FPS, STAGE, ffmpeg, log, sleep, writeJson } from "./lib.mjs";

const now = () => Date.now() / 1000;

export class Recorder {
  constructor(page) {
    this.page = page;
    this.cdp = null;
    this.on = false;
  }

  async start(id) {
    this.id = id;
    this.dir = join(DIRS.frames, id);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.spans = []; // { a, b, kind: "fast" | "cut" }
    this.pending = [];
    this.marks = []; // { kind, a, b }: labelled intervals, e.g. "paypal" while PayPal's pages are on screen
    this.t0 = now();
    this.on = true;
    await this.#startCast();
    log(`● rec ${id}`);
  }

  async #startCast() {
    this.cdp = await this.page.createCDPSession();
    this.cdp.on("Page.screencastFrame", (f) => {
      const n = this.frames.length;
      const file = join(this.dir, `${String(n).padStart(5, "0")}.jpg`);
      this.frames.push({ ts: f.metadata.timestamp ?? now(), file });
      this.pending.push(writeFile(file, Buffer.from(f.data, "base64")));
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: STAGE.appW, maxHeight: STAGE.appH, everyNthFrame: 1 });
  }

  /** Restarts the screencast (after a full page navigation the old stream can go quiet). */
  async restartCast() {
    if (!this.on) return;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.cdp?.detach().catch(() => {});
    await this.#startCast();
  }

  /** Output length of a span of d real seconds (a fast span plays in at most `max` seconds, default 2.2). */
  static spanOut(kind, d, max = 2.2) {
    if (kind === "cut") return 0;
    if (kind === "real") return d;
    if (d <= 1.6) return d; // short waits stay real-time
    return Math.min(d, Math.max(1.2, Math.min(max, d / 4)));
  }

  /** Maps a wall-clock time to output seconds from the clip start. */
  map(t) {
    let out = t - this.t0;
    for (const s of this.spans) {
      if (s.b == null || t <= s.a) continue;
      const d = s.b - s.a;
      const part = Math.min(t, s.b) - s.a;
      const o = Recorder.spanOut(s.kind, d, s.max);
      out -= part - (d > 0 ? (part * o) / d : 0);
    }
    return out;
  }

  /** Output seconds recorded so far. */
  elapsed() {
    return this.on ? this.map(now()) : 0;
  }

  async #span(kind, fn, max) {
    if (!this.on) return fn();
    const s = { a: now(), b: null, kind, max };
    this.spans.push(s);
    try {
      return await fn();
    } finally {
      s.b = now();
      if (kind === "fast" && Recorder.spanOut("fast", s.b - s.a, max) === s.b - s.a) s.kind = "real";
    }
  }
  /** Runs fn; the time it takes plays sped up in the clip (in at most `max` output seconds). */
  fast(fn, { max } = {}) {
    return this.#span("fast", fn, max);
  }
  /** Runs fn; the time it takes is cut from the clip (use only while the screen is static). */
  cut(fn) {
    return this.#span("cut", fn);
  }

  /** Starts / ends a labelled interval (clips/<id>.json marks.<kind>: [[a, b], …] in output seconds). */
  markStart(kind) {
    if (this.on && !this.marks.some((m) => m.kind === kind && m.b == null)) this.marks.push({ kind, a: now(), b: null });
  }
  markEnd(kind) {
    const m = this.on ? this.marks.findLast((x) => x.kind === kind && x.b == null) : null;
    if (m) m.b = now();
  }

  /** Holds until the clip is at least t output seconds long. */
  async until(t) {
    if (!this.on) return;
    while (this.elapsed() < t) await sleep(Math.min(200, Math.max(20, (t - this.elapsed()) * 1000)));
  }

  /** Stops without encoding (a discarded take). */
  async abort() {
    if (!this.on) return;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.cdp?.detach().catch(() => {});
    this.on = false;
    await Promise.all(this.pending).catch(() => {});
    rmSync(this.dir, { recursive: true, force: true });
    log(`✕ rec ${this.id}: discarded`);
  }

  /** Stops, then encodes clips/<id>.mp4 and clips/<id>.json. Returns { dur, fast }. */
  async stop() {
    if (!this.on) return null;
    const end = now();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
    this.on = false;
    await Promise.all(this.pending);
    const total = this.map(end);
    if (!this.frames.length) throw new Error(`rec ${this.id}: no frames captured`);

    // ffconcat list: each frame lasts until the next one (in output time).
    const pts = this.frames.map((f) => Math.max(0, this.map(f.ts)));
    pts[0] = 0;
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < this.frames.length; i++) {
      const next = i + 1 < this.frames.length ? pts[i + 1] : total;
      const d = next - pts[i];
      if (d <= 0.0005 && i + 1 < this.frames.length) continue; // fully inside a cut or superseded
      lines.push(`file '${this.frames[i].file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${Math.max(d, 0.001).toFixed(6)}`);
    }
    // The concat demuxer needs the last file repeated for its duration to count.
    lines.push(lines.at(-2));
    const list = join(this.dir, "list.ffconcat");
    writeFileSync(list, lines.join("\n"));
    const out = join(DIRS.clips, `${this.id}.mp4`);
    ffmpeg([
      "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `fps=${FPS},scale=${STAGE.appW}:${STAGE.appH}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`, "-color_range", "tv",
      "-t", total.toFixed(3),
      "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-r", String(FPS), "-an", out,
    ]);
    const fast = this.spans
      .filter((s) => s.kind === "fast")
      .map((s) => [Number(this.map(s.a).toFixed(3)), Number(this.map(s.b).toFixed(3))])
      .filter(([a, b]) => b - a > 0.3);
    const marks = {};
    for (const m of this.marks) (marks[m.kind] ??= []).push([Number(this.map(m.a).toFixed(3)), Number(this.map(m.b ?? end).toFixed(3))]);
    const info = { id: this.id, dur: Number(total.toFixed(3)), frames: this.frames.length, fast, marks, spans: this.spans.map((s) => ({ kind: s.kind, real: Number((s.b - s.a).toFixed(2)) })) };
    writeJson(join(DIRS.clips, `${this.id}.json`), info);
    log(`■ rec ${this.id}: ${total.toFixed(2)} s, ${this.frames.length} frames${fast.length ? `, sped up ${fast.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(" ")}` : ""}`);
    if (!process.env.KEEP_FRAMES) rmSync(this.dir, { recursive: true, force: true });
    return info;
  }
}
