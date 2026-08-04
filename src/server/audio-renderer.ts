import type { AudioClip, StudioProject, Track } from "../shared/types.js";

export interface RenderedAudio {
  buffer: Buffer;
  durationSeconds: number;
  sampleRate: number;
}

const TAU = Math.PI * 2;

function midiToFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

function waveformAt(kind: string, phase: number): number {
  const wrapped = phase / TAU - Math.floor(phase / TAU);
  if (kind === "square") return wrapped < 0.5 ? 1 : -1;
  if (kind === "sawtooth") return 2 * wrapped - 1;
  if (kind === "triangle") return 1 - 4 * Math.abs(wrapped - 0.5);
  return Math.sin(phase);
}

function seededNoise(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function addVoice(target: Float32Array, start: number, length: number, sampleRate: number, track: Track, note: number, velocity: number): void {
  const drum = track.instrument.kind === "drum";
  const frequency = midiToFrequency(note + track.instrument.octave * 12);
  const attack = Number(track.instrument.parameters.attack ?? 0.01);
  const release = Math.min(Number(track.instrument.parameters.release ?? 0.12), length / sampleRate / 2);
  for (let i = 0; i < length && start + i < target.length; i += 1) {
    const t = i / sampleRate;
    const remaining = (length - i) / sampleRate;
    const envelope = Math.min(1, t / Math.max(0.002, attack)) * Math.min(1, remaining / Math.max(0.01, release));
    let sample: number;
    if (drum && note <= 36) {
      const pitch = 48 + 120 * Math.exp(-t * 26);
      sample = Math.sin(TAU * pitch * t) * Math.exp(-t * 12);
    } else if (drum && note <= 40) {
      sample = (seededNoise(i + start) * 0.82 + Math.sin(TAU * 175 * t) * 0.18) * Math.exp(-t * 18);
    } else if (drum) {
      const noise = seededNoise((i + start) * 7);
      const previous = seededNoise((i + start - 1) * 7);
      sample = (noise - previous) * 0.65 * Math.exp(-t * 32);
    } else {
      sample = waveformAt(track.instrument.waveform, TAU * frequency * t) * envelope;
    }
    target[start + i] += sample * velocity * 0.42;
  }
}

function decodeWavDataUrl(clip: AudioClip): { left: Float32Array; right: Float32Array; sampleRate: number } | null {
  if (!clip.dataUrl?.startsWith("data:audio/")) return null;
  try {
    const raw = Buffer.from(clip.dataUrl.slice(clip.dataUrl.indexOf(",") + 1), "base64");
    if (raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12;
    let format = 1;
    let channels = 1;
    let sampleRate = 44100;
    let bits = 16;
    let dataOffset = -1;
    let dataSize = 0;
    while (offset + 8 <= raw.length) {
      const id = raw.toString("ascii", offset, offset + 4);
      const size = raw.readUInt32LE(offset + 4);
      if (id === "fmt ") {
        format = raw.readUInt16LE(offset + 8);
        channels = raw.readUInt16LE(offset + 10);
        sampleRate = raw.readUInt32LE(offset + 12);
        bits = raw.readUInt16LE(offset + 22);
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset < 0 || ![1, 3].includes(format)) return null;
    const bytesPerSample = bits / 8;
    const frames = Math.floor(dataSize / Math.max(1, bytesPerSample * channels));
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const read = (channel: number): number => {
        const position = dataOffset + (frame * channels + Math.min(channel, channels - 1)) * bytesPerSample;
        if (format === 3 && bits === 32) return raw.readFloatLE(position);
        if (bits === 8) return (raw.readUInt8(position) - 128) / 128;
        if (bits === 24) return raw.readIntLE(position, 3) / 8388608;
        if (bits === 32) return raw.readInt32LE(position) / 2147483648;
        return raw.readInt16LE(position) / 32768;
      };
      left[frame] = read(0);
      right[frame] = read(1);
    }
    return { left, right, sampleRate };
  } catch {
    return null;
  }
}

function applyTrackEffects(signal: Float32Array, track: Track, sampleRate: number): void {
  const filter = track.effects.find((effect) => effect.enabled && effect.type === "filter");
  if (filter) {
    const cutoff = Math.max(40, Math.min(sampleRate * 0.45, filter.parameters.cutoff ?? 8000));
    const alpha = 1 - Math.exp((-TAU * cutoff) / sampleRate);
    let previous = 0;
    for (let i = 0; i < signal.length; i += 1) {
      previous += alpha * (signal[i] - previous);
      signal[i] = signal[i] * (1 - filter.mix) + previous * filter.mix;
    }
  }
  for (const effect of track.effects.filter((entry) => entry.enabled && entry.type === "distortion")) {
    const drive = effect.parameters.drive ?? 1.8;
    for (let i = 0; i < signal.length; i += 1) {
      const wet = Math.tanh(signal[i] * drive);
      signal[i] = signal[i] * (1 - effect.mix) + wet * effect.mix;
    }
  }
  for (const effect of track.effects.filter((entry) => entry.enabled && ["delay", "reverb", "chorus"].includes(entry.type))) {
    const seconds = effect.type === "chorus" ? 0.018 : (effect.parameters.time ?? (effect.type === "reverb" ? 0.08 : 0.25));
    const delay = Math.max(1, Math.floor(seconds * sampleRate));
    const feedback = effect.parameters.feedback ?? (effect.type === "reverb" ? 0.42 : 0.28);
    for (let i = delay; i < signal.length; i += 1) {
      signal[i] += signal[i - delay] * feedback * effect.mix;
    }
  }
}

function writeWav(left: Float32Array, right: Float32Array, sampleRate: number): Buffer {
  const frames = Math.min(left.length, right.length);
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return buffer;
}

function automationAt(project: StudioProject, target: string, step: number, fallback: number): number {
  const lane = project.automation.find((entry) => entry.enabled && entry.target === target);
  if (!lane || lane.points.length === 0) return fallback;
  const points = [...lane.points].sort((a, b) => a.step - b.step);
  const nextIndex = points.findIndex((point) => point.step >= step);
  if (nextIndex < 0) return points.at(-1)!.value;
  if (nextIndex === 0) return points[0].value;
  const previous = points[nextIndex - 1];
  const next = points[nextIndex];
  if (previous.curve === "hold") return previous.value;
  const ratio = (step - previous.step) / Math.max(1, next.step - previous.step);
  return previous.value + (next.value - previous.value) * ratio;
}

export function renderProject(project: StudioProject, options: { sampleRate?: number; bars?: number } = {}): RenderedAudio {
  const sampleRate = Math.max(8000, Math.min(96000, options.sampleRate ?? 44100));
  const loopSteps = Math.max(1, project.transport.loopEnd - project.transport.loopStart);
  const requestedSteps = options.bars
    ? options.bars * project.transport.numerator * project.transport.stepsPerBeat
    : loopSteps;
  const secondsPerStep = 60 / project.transport.tempo / project.transport.stepsPerBeat;
  const durationSeconds = requestedSteps * secondsPerStep + 1.5;
  const frameCount = Math.ceil(durationSeconds * sampleRate);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  const anySolo = project.tracks.some((track) => track.mixer.solo);

  for (const track of project.tracks) {
    if (track.mixer.mute || (anySolo && !track.mixer.solo)) continue;
    const mono = new Float32Array(frameCount);
    for (let step = 0; step < requestedSteps; step += 1) {
      const patternIndex = (step + project.transport.loopStart) % track.steps.length;
      const item = track.steps[patternIndex];
      if (!item?.enabled || track.type === "audio") continue;
      const swingOffset = step % 2 === 1 ? project.transport.swing * secondsPerStep : 0;
      const start = Math.floor((step * secondsPerStep + swingOffset) * sampleRate);
      const length = Math.floor(secondsPerStep * item.gate * sampleRate);
      addVoice(mono, start, length, sampleRate, track, item.note, item.velocity);
    }
    for (const clip of track.clips) {
      const decoded = decodeWavDataUrl(clip);
      if (!decoded) continue;
      const start = Math.floor(clip.startStep * secondsPerStep * sampleRate);
      const maxFrames = Math.min(frameCount - start, Math.floor(clip.lengthSteps * secondsPerStep * sampleRate));
      for (let i = 0; i < maxFrames; i += 1) {
        const sourceIndex = Math.floor(i * decoded.sampleRate / sampleRate);
        if (sourceIndex >= decoded.left.length) break;
        mono[start + i] += ((decoded.left[sourceIndex] + decoded.right[sourceIndex]) / 2) * clip.gain;
      }
    }
    applyTrackEffects(mono, track, sampleRate);
    for (let i = 0; i < frameCount; i += 1) {
      const step = i / sampleRate / secondsPerStep;
      const volume = automationAt(project, `track:${track.id}.volume`, step, track.mixer.volume);
      const pan = automationAt(project, `track:${track.id}.pan`, step, track.mixer.pan);
      const leftGain = Math.cos((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4);
      const rightGain = Math.sin((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4);
      left[i] += mono[i] * volume * leftGain;
      right[i] += mono[i] * volume * rightGain;
    }
  }

  for (let i = 0; i < frameCount; i += 1) {
    const masterVolume = automationAt(project, "master.volume", i / sampleRate / secondsPerStep, project.master.volume);
    left[i] = Math.tanh(left[i] * masterVolume * 1.2) / Math.tanh(1.2);
    right[i] = Math.tanh(right[i] * masterVolume * 1.2) / Math.tanh(1.2);
  }
  return { buffer: writeWav(left, right, sampleRate), durationSeconds, sampleRate };
}
