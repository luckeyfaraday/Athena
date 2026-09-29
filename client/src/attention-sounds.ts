import type { AttentionSoundStyle, WorkspaceAttentionKind } from "./workspace-attention";

// Attention sounds are synthesized with Web Audio, so there are no audio assets and no dependency on the OS alert
// sound. "Needs input" rises like a question; "finished" falls and resolves.

type AudibleStyle = Exclude<AttentionSoundStyle, "none">;
type Note = { frequency: number; at: number; duration: number; gain: number };
type Partial = { ratio: number; gain: number; decay: number };
type Voice = { wave: OscillatorType; partials: Partial[]; attack: number; level: number; lowpassHz?: number };

const VOICES: Record<AudibleStyle, Voice> = {
  // Glassy bell: slightly inharmonic overtones that die away faster than the fundamental.
  chime: {
    wave: "sine",
    attack: 0.004,
    level: 0.5,
    partials: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 2.01, gain: 0.28, decay: 0.55 },
      { ratio: 2.76, gain: 0.14, decay: 0.4 },
      { ratio: 5.4, gain: 0.05, decay: 0.2 },
    ],
  },
  // Mellow mallet: low, round and short.
  soft: {
    wave: "sine",
    attack: 0.012,
    level: 0.62,
    partials: [
      { ratio: 1, gain: 1, decay: 1 },
      { ratio: 4, gain: 0.07, decay: 0.25 },
    ],
  },
  // Retro blips, filtered so they stay polite.
  digital: {
    wave: "square",
    attack: 0.002,
    level: 0.14,
    lowpassHz: 3_600,
    partials: [{ ratio: 1, gain: 1, decay: 1 }],
  },
};

const MELODIES: Record<AudibleStyle, Record<WorkspaceAttentionKind, Note[]>> = {
  chime: {
    action: [
      { frequency: 783.99, at: 0, duration: 0.55, gain: 0.8 }, // G5
      { frequency: 1174.66, at: 0.14, duration: 0.95, gain: 0.9 }, // D6
    ],
    update: [
      { frequency: 659.25, at: 0, duration: 0.6, gain: 0.8 }, // E5
      { frequency: 523.25, at: 0.16, duration: 1.1, gain: 0.85 }, // C5
    ],
  },
  soft: {
    action: [
      { frequency: 440, at: 0, duration: 0.32, gain: 0.8 }, // A4
      { frequency: 554.37, at: 0.11, duration: 0.32, gain: 0.8 }, // C#5
      { frequency: 659.25, at: 0.22, duration: 0.6, gain: 0.9 }, // E5
    ],
    update: [
      { frequency: 587.33, at: 0, duration: 0.4, gain: 0.8 }, // D5
      { frequency: 440, at: 0.15, duration: 0.8, gain: 0.85 }, // A4
    ],
  },
  digital: {
    action: [
      { frequency: 1318.51, at: 0, duration: 0.07, gain: 0.9 }, // E6
      { frequency: 1318.51, at: 0.11, duration: 0.07, gain: 0.9 },
      { frequency: 1760, at: 0.22, duration: 0.12, gain: 1 }, // A6
    ],
    update: [
      { frequency: 987.77, at: 0, duration: 0.08, gain: 0.9 }, // B5
      { frequency: 1318.51, at: 0.1, duration: 0.16, gain: 1 }, // E6
    ],
  },
};

// Several agents finishing together play once, not as a pile-up.
const MIN_GAP_MS = 900;

let audioContext: AudioContext | null = null;
let lastPlayedAt = Number.NEGATIVE_INFINITY;

function sharedAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  try {
    audioContext = new window.AudioContext();
  } catch {
    return null;
  }
  return audioContext;
}

/** Plays the attention sound for `kind`. `force` skips the anti-pile-up gap (Settings previews). */
export function playAttentionSound(
  kind: WorkspaceAttentionKind,
  style: AttentionSoundStyle,
  volume: number,
  options: { force?: boolean } = {},
): void {
  if (style === "none" || !(volume > 0)) return;
  const nowMs = Date.now();
  if (!options.force && nowMs - lastPlayedAt < MIN_GAP_MS) return;
  const audio = sharedAudioContext();
  if (!audio) return;
  lastPlayedAt = nowMs;
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);

  const voice = VOICES[style];
  const clampedVolume = Math.min(1, Math.max(0, volume));
  const master = audio.createGain();
  // Perceived loudness is roughly logarithmic; squaring makes the slider feel even.
  master.gain.value = clampedVolume * clampedVolume * voice.level;
  let output: AudioNode = master;
  if (voice.lowpassHz) {
    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = voice.lowpassHz;
    master.connect(filter);
    output = filter;
  }
  output.connect(audio.destination);

  const start = audio.currentTime + 0.02;
  let end = start;
  for (const note of MELODIES[style][kind]) {
    for (const partial of voice.partials) {
      const noteStart = start + note.at;
      const noteEnd = noteStart + Math.max(voice.attack * 2, note.duration * partial.decay);
      const oscillator = audio.createOscillator();
      oscillator.type = voice.wave;
      oscillator.frequency.value = note.frequency * partial.ratio;
      const envelope = audio.createGain();
      envelope.gain.setValueAtTime(0.0001, noteStart);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, note.gain * partial.gain), noteStart + voice.attack);
      envelope.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.02);
      oscillator.onended = () => envelope.disconnect();
      end = Math.max(end, noteEnd);
    }
  }
  window.setTimeout(() => output.disconnect(), Math.ceil((end - audio.currentTime) * 1000) + 250);
}
