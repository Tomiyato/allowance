// Demo video pipeline: cards → TTS → screen recording → compose.
//
//   BASE_URL=https://allowance-cpp0.onrender.com npm run video
//                                          everything, against the hosted demo (real PayPal sandbox
//                                          rail, PAYMENT_MODE=authorization; the recorder wakes nothing,
//                                          so open /healthz first)
//   npm run video -- --tts-only            voiceover only (cached per scene text/voice/model)
//   npm run video -- --cards-only          title/architecture/end cards, captions, frames
//   npm run video -- --record-only         record every app scene, no compose
//   npm run video -- --record=s04,s05      re-record these scenes (the session replays from the
//                                          start, unrecorded scenes run fast), then compose
//   npm run video -- --compose-only        rebuild the mp4/srt/stills from cached parts
//   npm run video -- --verify-audio        transcribe the narration once (Gemini, else Groq Whisper) and diff it
//                                          against the script (catches cut or garbled takes)
//
// Voice: ElevenLabs eleven_v4, voice "Jaya" (scenes.json tts.elevenlabs; ELEVENLABS_API_KEY in .env).
// TTS_PROVIDER=gemini switches back to Gemini TTS (scenes.json tts.gemini).
// Script: docs/VIDEO_SCRIPT.md (Ribbon), mirrored in scenes.json. Scene 3 logs in to the PayPal sandbox as PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD (.env, read by
// Node). Each take runs in a fresh browser session; a failed chat turn restarts the take (MAX_TAKES).
// Environment: BASE_URL (default https://allowance-cpp0.onrender.com, the hosted demo), CHROME_PATH, HEADFUL=1, VO_TEMPO (≤ 1.05),
// AI_COOLDOWN (s between AI calls, default 45), MAX_TAKES (default 3), KEEP_FRAMES=1,
// ELEVENLABS_VOICE_ID / ELEVENLABS_MODEL_ID / ELEVENLABS_SEED.
// Outputs: video-out/ribbon-demo.mp4, video-out/ribbon-demo.srt, video-out/frames/*.png,
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
      await runTts(); // picks up a "noFlag" variant if a scene has one and the recording needed it
      await compose();
    }
  }
} catch (e) {
  console.error(`\nvideo: ${e.message}`);
  process.exitCode = 1;
}
