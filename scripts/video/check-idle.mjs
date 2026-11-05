// Idle check of the final video: an interval where the picture is frozen (ffmpeg freezedetect) and
// the narration is silent (silencedetect) at the same time, longer than MAX_IDLE seconds, is a gap
// where nothing happens on screen. compose() runs it and prints the result; standalone:
//   node scripts/video/check-idle.mjs [video-out/ribbon-demo.mp4]
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUT, log } from "./lib.mjs";

export const MAX_IDLE = 2.0;

function stderrOf(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.stderr ?? "";
}

/** [[start, end], …] from ffmpeg's "<kind>_start: t" / "<kind>_end: t" lines. */
function intervals(text, kind, total) {
  const out = [];
  let a = null;
  for (const line of text.split("\n")) {
    const s = new RegExp(`${kind}_start: ?([\\d.]+)`).exec(line);
    const e = new RegExp(`${kind}_end: ?([\\d.]+)`).exec(line);
    if (s) a = Number(s[1]);
    if (e && a != null) {
      out.push([a, Number(e[1])]);
      a = null;
    }
  }
  if (a != null) out.push([a, total]);
  return out;
}

export function checkIdle(mp4 = join(OUT, "ribbon-demo.mp4"), { total } = {}) {
  total ??= Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" }).stdout.trim());
  // Small changes (a cursor moving, a meter filling) count as motion: noise -60 dB is strict.
  const frozen = intervals(stderrOf(["-i", mp4, "-map", "0:v", "-vf", "freezedetect=n=-60dB:d=0.5", "-f", "null", "-"]), "lavfi.freezedetect.freeze", total);
  const quiet = intervals(stderrOf(["-i", mp4, "-map", "0:a", "-af", "silencedetect=n=-40dB:d=0.5", "-f", "null", "-"]), "silence", total);
  const idle = [];
  for (const [fa, fb] of frozen) {
    for (const [sa, sb] of quiet) {
      const a = Math.max(fa, sa);
      const b = Math.min(fb, sb);
      if (b - a > MAX_IDLE) idle.push([Number(a.toFixed(2)), Number(b.toFixed(2))]);
    }
  }
  const longestFrozen = Math.max(0, ...frozen.map(([a, b]) => b - a));
  const longestQuiet = Math.max(0, ...quiet.map(([a, b]) => b - a));
  log(`Idle check: ${idle.length ? `${idle.length} idle gap(s) over ${MAX_IDLE} s: ${idle.map(([a, b]) => `${a}-${b}`).join(", ")}` : `no idle gap over ${MAX_IDLE} s`} (longest frozen picture ${longestFrozen.toFixed(1)} s, longest silence ${longestQuiet.toFixed(1)} s)`);
  return { idle, frozen, quiet };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkIdle(process.argv[2]);
}
