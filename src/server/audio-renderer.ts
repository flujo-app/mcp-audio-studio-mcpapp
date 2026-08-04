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
  const mixIntoSignal = (wet: Float32Array, mix: number): void => {
    const amount = Math.max(0, Math.min(1, mix));
    const dryGain = Math.cos(amount * Math.PI / 2);
    const wetGain = Math.sin(amount * Math.PI / 2);
    for (let i = 0; i < signal.length; i += 1) signal[i] = signal[i] * dryGain + wet[i] * wetGain;
  };

  for (const effect of track.effects.filter((entry) => entry.enabled)) {
    const wet = new Float32Array(signal.length);
    if (effect.type === "filter") {
      const cutoff = Math.max(40, Math.min(sampleRate * 0.45, effect.parameters.cutoff ?? 8000));
      const q = Math.max(0.1, Math.min(24, effect.parameters.resonance ?? 0.7));
      const omega = TAU * cutoff / sampleRate;
      const alpha = Math.sin(omega) / (2 * q);
      const cosine = Math.cos(omega);
      const a0 = 1 + alpha;
      const b0 = ((1 - cosine) / 2) / a0;
      const b1 = (1 - cosine) / a0;
      const b2 = b0;
      const a1 = (-2 * cosine) / a0;
      const a2 = (1 - alpha) / a0;
      let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
      for (let i = 0; i < signal.length; i += 1) {
        const value = b0 * signal[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        wet[i] = value;
        x2 = x1; x1 = signal[i]; y2 = y1; y1 = value;
      }
    } else if (effect.type === "distortion") {
      const drive = Math.max(0.1, Math.min(20, effect.parameters.drive ?? 1.8));
      for (let i = 0; i < signal.length; i += 1) wet[i] = Math.tanh(signal[i] * drive);
    } else if (effect.type === "compressor" || effect.type === "limiter") {
      const limiter = effect.type === "limiter";
      const threshold = limiter ? Math.max(-24, Math.min(0, effect.parameters.ceiling ?? -0.8)) : Math.max(-60, Math.min(0, effect.parameters.threshold ?? -18));
      const ratio = limiter ? 20 : Math.max(1, Math.min(20, effect.parameters.ratio ?? 4));
      const attack = limiter ? 0.001 : Math.max(0.0001, Math.min(1, effect.parameters.attack ?? 0.01));
      const release = Math.max(0.01, Math.min(1, effect.parameters.release ?? (limiter ? 0.08 : 0.25)));
      const attackCoefficient = Math.exp(-1 / (attack * sampleRate));
      const releaseCoefficient = Math.exp(-1 / (release * sampleRate));
      let gain = 1;
      for (let i = 0; i < signal.length; i += 1) {
        const level = 20 * Math.log10(Math.max(1e-6, Math.abs(signal[i])));
        const compressed = level > threshold ? threshold + (level - threshold) / ratio : level;
        const desiredGain = 10 ** ((compressed - level) / 20);
        const coefficient = desiredGain < gain ? attackCoefficient : releaseCoefficient;
        gain = desiredGain + coefficient * (gain - desiredGain);
        wet[i] = signal[i] * gain;
      }
    } else if (effect.type === "delay") {
      const delay = Math.max(1, Math.floor(Math.max(0.01, Math.min(1.8, effect.parameters.time ?? 0.25)) * sampleRate));
      const feedback = Math.max(0, Math.min(0.92, effect.parameters.feedback ?? 0.28));
      for (let i = delay; i < signal.length; i += 1) wet[i] = signal[i - delay] + wet[i - delay] * feedback;
    } else if (effect.type === "chorus") {
      const rate = Math.max(0.05, Math.min(10, effect.parameters.rate ?? 0.8));
      const depth = Math.max(0, Math.min(1, effect.parameters.depth ?? 0.25)) * 0.012;
      for (let i = 0; i < signal.length; i += 1) {
        const delay = (0.018 + Math.sin(TAU * rate * i / sampleRate) * depth) * sampleRate;
        const source = i - delay;
        const before = Math.floor(source);
        if (before >= 0) {
          const fraction = source - before;
          wet[i] = signal[before] * (1 - fraction) + (signal[before + 1] ?? signal[before]) * fraction;
        }
      }
    } else if (effect.type === "reverb") {
      const size = Math.max(0.05, Math.min(1, effect.parameters.size ?? 0.55));
      const damping = Math.max(0, Math.min(1, effect.parameters.damping ?? 0.4));
      const preDelay = Math.floor(Math.max(0, Math.min(0.25, effect.parameters.preDelay ?? 0.02)) * sampleRate);
      const delays = [0.0297, 0.0371, 0.0411, 0.0437].map((seconds) => Math.max(1, Math.floor(seconds * (0.65 + size * 0.9) * sampleRate)));
      const feedback = 0.48 + size * 0.38;
      let damped = 0;
      for (let i = 0; i < signal.length; i += 1) {
        let reflections = 0;
        for (const delay of delays) if (i >= delay) reflections += wet[i - delay] / delays.length;
        damped = reflections * (1 - damping * 0.82) + damped * damping * 0.82;
        wet[i] = (i >= preDelay ? signal[i - preDelay] * 0.22 : 0) + damped * feedback;
      }
    } else {
      wet.set(signal);
    }
    mixIntoSignal(wet, effect.mix);
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
      const absoluteStep = step + project.transport.loopStart;
      const pattern = track.patterns?.find((entry) => absoluteStep >= entry.startStep && absoluteStep < entry.startStep + entry.lengthSteps);
      if (track.type === "instrument" && !pattern) continue;
      const patternIndex = pattern
        ? (absoluteStep - pattern.startStep) % track.steps.length
        : absoluteStep % track.steps.length;
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
