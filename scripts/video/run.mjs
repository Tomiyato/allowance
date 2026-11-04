// Demo video pipeline: cards → TTS → screen recording → compose.
//
//   npm run video                          everything (the app must be running at BASE_URL)
//   npm run video -- --tts-only            voiceover only (cached per text/voice/model)
//   npm run video -- --cards-only          title/architecture/end cards, captions, frame
//   npm run video -- --record-only         record every app scene, no compose
//   npm run video -- --record=s04,s05      re-record these scenes (the session replays from the
//                                          start, unrecorded scenes run fast), then compose
//   npm run video -- --compose-only        rebuild the mp4/srt/stills from cached parts
//   npm run video -- --verify-audio        transcribe the narration once (Gemini) and diff it
//                                          against the script (catches cut or garbled takes)
//
// Environment: BASE_URL (default http://localhost:3160), CHROME_PATH, TTS_MODEL, TTS_VOICE, HEADFUL=1,
// PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD (scene 3 on the real PayPal sandbox rail),
// VO_TEMPO (e.g. 1.05), AI_COOLDOWN (s between AI calls, default 25), KEEP_FRAMES=1.
// Outputs: video-out/allowance-demo.mp4, video-out/allowance-demo.srt, video-out/frames/*.png,
// video-out/timing.json; intermediate parts in video-out/cache/.
import { renderCards } from "./cards.mjs";
import { compose } from "./compose.mjs";
import { BASE_URL, log } from "./lib.mjs";
import { record } from "./record.mjs";
import { runTts } from "./tts.mjs";
import { verifyAudio } from "./verify-audio.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const recordArg = args.find((a) => a.startsWith("--record="));
const only = recordArg ? recordArg.slice("--record=".length).split(",").map((s) => s.trim()).filter(Boolean) : null;

try {
  if (has("--compose-only")) {
    await compose();
  } else if (has("--verify-audio")) {
    await verifyAudio();
  } else if (has("--tts-only")) {
    await runTts({ withVariants: has("--variants") ? true : undefined });
  } else if (has("--cards-only")) {
    await renderCards({ force: has("--force") });
  } else {
    log(`Pipeline against ${BASE_URL}`);
    await renderCards();
    await runTts();
    await record({ only });
    if (!has("--record-only")) {
      await runTts(); // picks up the s06 variant if the recording needed it
      await compose();
    }
  }
} catch (e) {
  console.error(`\nvideo: ${e.message}`);
  process.exitCode = 1;
}
