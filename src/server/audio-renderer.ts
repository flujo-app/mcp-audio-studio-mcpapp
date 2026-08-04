import { automateTrackAtStep, createAutomationReader, type AutomationReader } from "../shared/automation.js";
import type { AudioClip, Effect, Equalizer, StudioProject, Track } from "../shared/types.js";

export interface RenderedAudio {
  buffer: Buffer;
  durationSeconds: number;
  sampleRate: number;
}

const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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

function addVoice(target: Float32Array, start: number, holdLength: number, sampleRate: number, track: Track, note: number, velocity: number): void {
  const drum = track.instrument.kind === "drum";
  const frequency = midiToFrequency(note + track.instrument.octave * 12);
  const attack = clamp(Number(track.instrument.parameters.attack ?? 0.01), 0.002, 4);
  const decay = clamp(Number(track.instrument.parameters.decay ?? 0.2), 0.002, 4);
  const sustain = clamp(Number(track.instrument.parameters.sustain ?? 0.6), 0, 1);
  const release = clamp(Number(track.instrument.parameters.release ?? 0.15), 0.01, 8);
  const cutoff = clamp(Number(track.instrument.parameters.cutoff ?? 20_000), 40, sampleRate * 0.45);
  const totalLength = holdLength + Math.floor(release * sampleRate);
  const attackFrames = Math.max(1, Math.min(Math.floor(attack * sampleRate), Math.floor(holdLength * 0.5)));
  const decayFrames = Math.max(1, Math.min(Math.floor(decay * sampleRate), Math.max(1, holdLength - attackFrames)));
  const releaseFrames = Math.max(1, Math.floor(release * sampleRate));
  const filterAlpha = 1 - Math.exp(-TAU * cutoff / sampleRate);
  let filtered = 0;

  for (let index = 0; index < totalLength && start + index < target.length; index += 1) {
    const time = index / sampleRate;
    let envelope: number;
    if (index >= holdLength) envelope = sustain * Math.max(0, 1 - (index - holdLength) / releaseFrames);
    else if (index < attackFrames) envelope = index / attackFrames;
    else if (index < attackFrames + decayFrames) envelope = 1 - (1 - sustain) * ((index - attackFrames) / decayFrames);
    else envelope = sustain;

    let sample: number;
    if (drum && note <= 36) {
      const pitch = 48 + 120 * Math.exp(-time * 26);
      sample = Math.sin(TAU * pitch * time) * Math.exp(-time * 12);
    } else if (drum && note <= 40) {
      sample = (seededNoise(index + start) * 0.82 + Math.sin(TAU * 175 * time) * 0.18) * Math.exp(-time * 18);
    } else if (drum) {
      const noise = seededNoise((index + start) * 7);
      const previous = seededNoise((index + start - 1) * 7);
      sample = (noise - previous) * 0.65 * Math.exp(-time * 32);
    } else {
      sample = waveformAt(track.instrument.waveform, TAU * frequency * time);
    }
    filtered += filterAlpha * (sample - filtered);
    target[start + index] += filtered * envelope * velocity * 0.42;
  }
}

function decodeWavDataUrl(clip: AudioClip): { left: Float32Array; right: Float32Array; sampleRate: number } | null {
  if (!clip.dataUrl?.startsWith("data:audio/")) return null;
  try {
    const comma = clip.dataUrl.indexOf(",");
    if (comma < 0) return null;
    const raw = Buffer.from(clip.dataUrl.slice(comma + 1), "base64");
    if (raw.length < 44 || raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12;
    let format = 1;
    let channels = 1;
    let sampleRate = 44_100;
    let bits = 16;
    let dataOffset = -1;
    let dataSize = 0;
    while (offset + 8 <= raw.length) {
      const id = raw.toString("ascii", offset, offset + 4);
      const size = raw.readUInt32LE(offset + 4);
      if (id === "fmt " && offset + 24 <= raw.length) {
        format = raw.readUInt16LE(offset + 8);
        channels = raw.readUInt16LE(offset + 10);
        sampleRate = raw.readUInt32LE(offset + 12);
        bits = raw.readUInt16LE(offset + 22);
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataSize = Math.min(size, raw.length - dataOffset);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataOffset < 0 || ![1, 3].includes(format) || channels < 1 || ![8, 16, 24, 32].includes(bits)) return null;
    if (format === 3 && bits !== 32) return null;
    const bytesPerSample = bits / 8;
    const frames = Math.floor(dataSize / (bytesPerSample * channels));
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const read = (channel: number): number => {
        const position = dataOffset + (frame * channels + Math.min(channel, channels - 1)) * bytesPerSample;
        if (format === 3) return raw.readFloatLE(position);
        if (bits === 8) return (raw.readUInt8(position) - 128) / 128;
        if (bits === 24) return raw.readIntLE(position, 3) / 8_388_608;
        if (bits === 32) return raw.readInt32LE(position) / 2_147_483_648;
        return raw.readInt16LE(position) / 32_768;
      };
      left[frame] = read(0);
      right[frame] = read(1);
    }
    return { left, right, sampleRate };
  } catch {
    return null;
  }
}

type ParameterAtFrame = (frame: number) => number;

function effectParameter(
  reader: AutomationReader,
  track: Track,
  effect: Effect,
  key: string,
  fallback: number,
  absoluteStepAtFrame: (frame: number) => number,
): ParameterAtFrame {
  const target = `track:${track.id}.effect:${effect.id}.${key}`;
  return reader.has(target)
    ? (frame) => reader.value(target, absoluteStepAtFrame(frame), fallback)
    : () => fallback;
}

function applyTrackEffects(
  signal: Float32Array,
  track: Track,
  sampleRate: number,
  reader: AutomationReader,
  absoluteStepAtFrame: (frame: number) => number,
): void {
  for (const effect of track.effects.filter((entry) => entry.enabled)) {
    const wet = new Float32Array(signal.length);
    const mixAt = effectParameter(reader, track, effect, "mix", effect.mix, absoluteStepAtFrame);
    if (effect.type === "filter") {
      const cutoffAt = effectParameter(reader, track, effect, "cutoff", effect.parameters.cutoff ?? 8000, absoluteStepAtFrame);
      const resonanceAt = effectParameter(reader, track, effect, "resonance", effect.parameters.resonance ?? 0.7, absoluteStepAtFrame);
      let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
      for (let index = 0; index < signal.length; index += 1) {
        const cutoff = clamp(cutoffAt(index), 40, sampleRate * 0.45);
        const q = clamp(resonanceAt(index), 0.1, 24);
        const omega = TAU * cutoff / sampleRate;
        const alpha = Math.sin(omega) / (2 * q);
        const cosine = Math.cos(omega);
        const a0 = 1 + alpha;
        const b0 = ((1 - cosine) / 2) / a0;
        const b1 = (1 - cosine) / a0;
        const b2 = b0;
        const a1 = (-2 * cosine) / a0;
        const a2 = (1 - alpha) / a0;
        const value = b0 * signal[index] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        wet[index] = value;
        x2 = x1; x1 = signal[index]; y2 = y1; y1 = value;
      }
    } else if (effect.type === "distortion") {
      const driveAt = effectParameter(reader, track, effect, "drive", effect.parameters.drive ?? 1.8, absoluteStepAtFrame);
      for (let index = 0; index < signal.length; index += 1) wet[index] = Math.tanh(signal[index] * clamp(driveAt(index), 0.1, 20));
    } else if (effect.type === "compressor" || effect.type === "limiter") {
      const limiter = effect.type === "limiter";
      const thresholdAt = effectParameter(reader, track, effect, limiter ? "ceiling" : "threshold", limiter ? effect.parameters.ceiling ?? -0.8 : effect.parameters.threshold ?? -18, absoluteStepAtFrame);
      const ratioAt = effectParameter(reader, track, effect, "ratio", limiter ? 20 : effect.parameters.ratio ?? 4, absoluteStepAtFrame);
      const attackAt = effectParameter(reader, track, effect, "attack", limiter ? 0.001 : effect.parameters.attack ?? 0.01, absoluteStepAtFrame);
      const releaseAt = effectParameter(reader, track, effect, "release", effect.parameters.release ?? (limiter ? 0.08 : 0.25), absoluteStepAtFrame);
      let gain = 1;
      for (let index = 0; index < signal.length; index += 1) {
        const threshold = clamp(thresholdAt(index), limiter ? -24 : -60, 0);
        const ratio = limiter ? 20 : clamp(ratioAt(index), 1, 20);
        const attack = limiter ? 0.001 : clamp(attackAt(index), 0.0001, 1);
        const release = clamp(releaseAt(index), 0.01, 1);
        const level = 20 * Math.log10(Math.max(1e-6, Math.abs(signal[index])));
        const compressed = level > threshold ? threshold + (level - threshold) / ratio : level;
        const desiredGain = 10 ** ((compressed - level) / 20);
        const coefficient = Math.exp(-1 / ((desiredGain < gain ? attack : release) * sampleRate));
        gain = desiredGain + coefficient * (gain - desiredGain);
        wet[index] = signal[index] * gain;
      }
    } else if (effect.type === "delay") {
      const timeAt = effectParameter(reader, track, effect, "time", effect.parameters.time ?? 0.25, absoluteStepAtFrame);
      const feedbackAt = effectParameter(reader, track, effect, "feedback", effect.parameters.feedback ?? 0.28, absoluteStepAtFrame);
      for (let index = 0; index < signal.length; index += 1) {
        const delay = Math.max(1, Math.floor(clamp(timeAt(index), 0.01, 1.8) * sampleRate));
        if (index >= delay) wet[index] = signal[index - delay] + wet[index - delay] * clamp(feedbackAt(index), 0, 0.92);
      }
    } else if (effect.type === "chorus") {
      const rateAt = effectParameter(reader, track, effect, "rate", effect.parameters.rate ?? 0.8, absoluteStepAtFrame);
      const depthAt = effectParameter(reader, track, effect, "depth", effect.parameters.depth ?? 0.25, absoluteStepAtFrame);
      let phase = 0;
      for (let index = 0; index < signal.length; index += 1) {
        phase += TAU * clamp(rateAt(index), 0.05, 10) / sampleRate;
        const delay = (0.018 + Math.sin(phase) * clamp(depthAt(index), 0, 1) * 0.012) * sampleRate;
        const source = index - delay;
        const before = Math.floor(source);
        if (before >= 0) {
          const fraction = source - before;
          wet[index] = signal[before] * (1 - fraction) + (signal[before + 1] ?? signal[before]) * fraction;
        }
      }
    } else if (effect.type === "reverb") {
      const sizeAt = effectParameter(reader, track, effect, "size", effect.parameters.size ?? 0.55, absoluteStepAtFrame);
      const dampingAt = effectParameter(reader, track, effect, "damping", effect.parameters.damping ?? 0.4, absoluteStepAtFrame);
      const preDelayAt = effectParameter(reader, track, effect, "preDelay", effect.parameters.preDelay ?? 0.02, absoluteStepAtFrame);
      let damped = 0;
      for (let index = 0; index < signal.length; index += 1) {
        const size = clamp(sizeAt(index), 0.05, 1);
        const damping = clamp(dampingAt(index), 0, 1);
        const delays = [0.0297, 0.0371, 0.0411, 0.0437].map((seconds) => Math.max(1, Math.floor(seconds * (0.65 + size * 0.9) * sampleRate)));
        let reflections = 0;
        for (const delay of delays) if (index >= delay) reflections += wet[index - delay] / delays.length;
        damped = reflections * (1 - damping * 0.82) + damped * damping * 0.82;
        const preDelay = Math.floor(clamp(preDelayAt(index), 0, 0.25) * sampleRate);
        wet[index] = (index >= preDelay ? signal[index - preDelay] * 0.22 : 0) + damped * (0.48 + size * 0.38);
      }
    } else {
      wet.set(signal);
    }

    for (let index = 0; index < signal.length; index += 1) {
      const mix = clamp(mixAt(index), 0, 1);
      signal[index] = signal[index] * Math.cos(mix * Math.PI / 2) + wet[index] * Math.sin(mix * Math.PI / 2);
    }
  }
}

type BiquadKind = "lowshelf" | "peaking" | "highshelf";

function applyBiquad(signal: Float32Array, kind: BiquadKind, frequency: number, gainDb: number, sampleRate: number): void {
  if (Math.abs(gainDb) < 0.001) return;
  const omega = TAU * clamp(frequency, 20, sampleRate * 0.45) / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const a = 10 ** (gainDb / 40);
  let b0: number; let b1: number; let b2: number; let a0: number; let a1: number; let a2: number;
  if (kind === "peaking") {
    const alpha = sine / (2 * 0.7);
    b0 = 1 + alpha * a; b1 = -2 * cosine; b2 = 1 - alpha * a;
    a0 = 1 + alpha / a; a1 = -2 * cosine; a2 = 1 - alpha / a;
  } else {
    const alpha = sine / 2 * Math.sqrt(2);
    const beta = 2 * Math.sqrt(a) * alpha;
    if (kind === "lowshelf") {
      b0 = a * ((a + 1) - (a - 1) * cosine + beta);
      b1 = 2 * a * ((a - 1) - (a + 1) * cosine);
      b2 = a * ((a + 1) - (a - 1) * cosine - beta);
      a0 = (a + 1) + (a - 1) * cosine + beta;
      a1 = -2 * ((a - 1) + (a + 1) * cosine);
      a2 = (a + 1) + (a - 1) * cosine - beta;
    } else {
      b0 = a * ((a + 1) + (a - 1) * cosine + beta);
      b1 = -2 * a * ((a - 1) + (a + 1) * cosine);
      b2 = a * ((a + 1) + (a - 1) * cosine - beta);
      a0 = (a + 1) - (a - 1) * cosine + beta;
      a1 = 2 * ((a - 1) - (a + 1) * cosine);
      a2 = (a + 1) - (a - 1) * cosine - beta;
    }
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let index = 0; index < signal.length; index += 1) {
    const output = b0 * signal[index] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = signal[index]; y2 = y1; y1 = output;
    signal[index] = output;
  }
}

function applyEqualizer(signal: Float32Array, equalizer: Equalizer, sampleRate: number): void {
  applyBiquad(signal, "lowshelf", 100, equalizer.low, sampleRate);
  applyBiquad(signal, "peaking", 500, equalizer.lowMid, sampleRate);
  applyBiquad(signal, "peaking", 2500, equalizer.highMid, sampleRate);
  applyBiquad(signal, "highshelf", 9000, equalizer.high, sampleRate);
}

function applyBuiltinPlugins(
  left: Float32Array,
  right: Float32Array,
  track: Track,
  reader: AutomationReader,
  absoluteStepAtFrame: (frame: number) => number,
): void {
  for (const plugin of track.plugins.filter((entry) => entry.enabled && entry.format === "builtin")) {
    const gainTarget = `track:${track.id}.plugin:${plugin.id}.gain`;
    const widthTarget = `track:${track.id}.plugin:${plugin.id}.width`;
    for (let index = 0; index < left.length; index += 1) {
      const step = absoluteStepAtFrame(index);
      const gain = clamp(reader.value(gainTarget, step, plugin.parameters.gain ?? 1), 0, 4);
      const width = clamp(reader.value(widthTarget, step, plugin.parameters.width ?? 1), 0, 2);
      const middle = (left[index] + right[index]) * 0.5 * gain;
      const side = (left[index] - right[index]) * 0.5 * gain * width;
      left[index] = middle + side;
      right[index] = middle - side;
    }
  }
}

function applySendReverb(signal: Float32Array, sampleRate: number): void {
  const source = signal.slice();
  signal.fill(0);
  const delays = [0.031, 0.037, 0.041, 0.047].map((seconds) => Math.floor(seconds * sampleRate));
  let damped = 0;
  for (let index = 0; index < signal.length; index += 1) {
    let reflections = 0;
    for (const delay of delays) if (index >= delay) reflections += signal[index - delay] / delays.length;
    damped = reflections * 0.68 + damped * 0.32;
    signal[index] = (index >= Math.floor(0.02 * sampleRate) ? source[index - Math.floor(0.02 * sampleRate)] * 0.2 : 0) + damped * 0.72;
  }
}

function applySendDelay(signal: Float32Array, sampleRate: number): void {
  const source = signal.slice();
  signal.fill(0);
  const delay = Math.floor(0.25 * sampleRate);
  for (let index = delay; index < signal.length; index += 1) signal[index] = source[index - delay] + signal[index - delay] * 0.32;
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
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(Math.round(clamp(left[index], -1, 1) * 32767), 44 + index * 4);
    buffer.writeInt16LE(Math.round(clamp(right[index], -1, 1) * 32767), 46 + index * 4);
  }
  return buffer;
}

export function renderProject(project: StudioProject, options: { sampleRate?: number; bars?: number } = {}): RenderedAudio {
  const sampleRate = clamp(options.sampleRate ?? 44_100, 8000, 96_000);
  const loopStart = project.transport.loopStart;
  const loopSteps = Math.max(1, project.transport.loopEnd - loopStart);
  const requestedSteps = options.bars
    ? options.bars * project.transport.numerator * project.transport.stepsPerBeat
    : loopSteps;
  const windowEnd = loopStart + requestedSteps;
  const secondsPerStep = 60 / project.transport.tempo / project.transport.stepsPerBeat;
  const durationSeconds = requestedSteps * secondsPerStep + 1.5;
  const frameCount = Math.ceil(durationSeconds * sampleRate);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  const sendALeft = new Float32Array(frameCount);
  const sendARight = new Float32Array(frameCount);
  const sendBLeft = new Float32Array(frameCount);
  const sendBRight = new Float32Array(frameCount);
  const reader = createAutomationReader(project);
  const absoluteStepAtFrame = (frame: number): number => loopStart + frame / sampleRate / secondsPerStep;
  const anySolo = project.tracks.some((track) => track.mixer.solo);

  for (const track of project.tracks) {
    if (track.mixer.mute || (anySolo && !track.mixer.solo)) continue;
    const trackLeft = new Float32Array(frameCount);
    const trackRight = new Float32Array(frameCount);
    for (let relativeStep = 0; relativeStep < requestedSteps; relativeStep += 1) {
      const absoluteStep = relativeStep + loopStart;
      const automatedTrack = automateTrackAtStep(track, absoluteStep, reader);
      const pattern = automatedTrack.patterns?.find((entry) => absoluteStep >= entry.startStep && absoluteStep < entry.startStep + entry.lengthSteps);
      if (automatedTrack.type === "instrument" && !pattern) continue;
      const patternIndex = pattern
        ? (absoluteStep - pattern.startStep) % Math.max(1, automatedTrack.steps.length)
        : absoluteStep % Math.max(1, automatedTrack.steps.length);
      const item = automatedTrack.steps[patternIndex];
      if (!item?.enabled || automatedTrack.type === "audio") continue;
      const swingOffset = relativeStep % 2 === 1 ? project.transport.swing * secondsPerStep : 0;
      const start = Math.floor((relativeStep * secondsPerStep + swingOffset) * sampleRate);
      const holdLength = Math.floor(secondsPerStep * item.gate * sampleRate);
      addVoice(trackLeft, start, holdLength, sampleRate, automatedTrack, item.note, item.velocity);
      addVoice(trackRight, start, holdLength, sampleRate, automatedTrack, item.note, item.velocity);
    }

    for (const clip of track.clips) {
      const decoded = decodeWavDataUrl(clip);
      if (!decoded) continue;
      const overlapStart = Math.max(loopStart, clip.startStep);
      const overlapEnd = Math.min(windowEnd, clip.startStep + clip.lengthSteps);
      if (overlapEnd <= overlapStart) continue;
      const destinationStart = Math.floor((overlapStart - loopStart) * secondsPerStep * sampleRate);
      const sourceOffsetSeconds = (overlapStart - clip.startStep) * secondsPerStep;
      const destinationFrames = Math.min(
        frameCount - destinationStart,
        Math.floor((overlapEnd - overlapStart) * secondsPerStep * sampleRate),
      );
      for (let frame = 0; frame < destinationFrames; frame += 1) {
        const sourceIndex = Math.floor((sourceOffsetSeconds + frame / sampleRate) * decoded.sampleRate);
        if (sourceIndex >= decoded.left.length) break;
        trackLeft[destinationStart + frame] += decoded.left[sourceIndex] * clip.gain;
        trackRight[destinationStart + frame] += decoded.right[sourceIndex] * clip.gain;
      }
    }

    applyEqualizer(trackLeft, track.eq, sampleRate);
    applyEqualizer(trackRight, track.eq, sampleRate);
    applyTrackEffects(trackLeft, track, sampleRate, reader, absoluteStepAtFrame);
    applyTrackEffects(trackRight, track, sampleRate, reader, absoluteStepAtFrame);
    applyBuiltinPlugins(trackLeft, trackRight, track, reader, absoluteStepAtFrame);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const step = absoluteStepAtFrame(frame);
      const volume = reader.value(`track:${track.id}.volume`, step, track.mixer.volume);
      const pan = clamp(reader.value(`track:${track.id}.pan`, step, track.mixer.pan), -1, 1);
      const sendA = clamp(reader.value(`track:${track.id}.sendA`, step, track.mixer.sendA), 0, 1);
      const sendB = clamp(reader.value(`track:${track.id}.sendB`, step, track.mixer.sendB), 0, 1);
      const leftGain = track.type === "audio" ? (pan <= 0 ? 1 : Math.cos(pan * Math.PI / 2)) : Math.cos((pan + 1) * Math.PI / 4);
      const rightGain = track.type === "audio" ? (pan >= 0 ? 1 : Math.cos(-pan * Math.PI / 2)) : Math.sin((pan + 1) * Math.PI / 4);
      const outputLeft = trackLeft[frame] * volume * leftGain;
      const outputRight = trackRight[frame] * volume * rightGain;
      left[frame] += outputLeft;
      right[frame] += outputRight;
      sendALeft[frame] += outputLeft * sendA;
      sendARight[frame] += outputRight * sendA;
      sendBLeft[frame] += outputLeft * sendB;
      sendBRight[frame] += outputRight * sendB;
    }
  }

  const hasSendA = sendALeft.some((sample) => sample !== 0) || sendARight.some((sample) => sample !== 0);
  const hasSendB = sendBLeft.some((sample) => sample !== 0) || sendBRight.some((sample) => sample !== 0);
  if (hasSendA) {
    applySendReverb(sendALeft, sampleRate);
    applySendReverb(sendARight, sampleRate);
  }
  if (hasSendB) {
    applySendDelay(sendBLeft, sampleRate);
    applySendDelay(sendBRight, sampleRate);
  }
  for (let frame = 0; frame < frameCount; frame += 1) {
    left[frame] += sendALeft[frame] * 0.38 + sendBLeft[frame] * 0.42;
    right[frame] += sendARight[frame] * 0.38 + sendBRight[frame] * 0.42;
    if (project.master.mute) {
      left[frame] = 0;
      right[frame] = 0;
      continue;
    }
    const step = absoluteStepAtFrame(frame);
    const masterVolume = reader.value("master.volume", step, project.master.volume);
    const masterPan = clamp(reader.value("master.pan", step, project.master.pan), -1, 1);
    const leftGain = masterPan <= 0 ? 1 : Math.cos(masterPan * Math.PI / 2);
    const rightGain = masterPan >= 0 ? 1 : Math.cos(-masterPan * Math.PI / 2);
    left[frame] = Math.tanh(left[frame] * masterVolume * leftGain * 1.2) / Math.tanh(1.2);
    right[frame] = Math.tanh(right[frame] * masterVolume * rightGain * 1.2) / Math.tanh(1.2);
  }
  return { buffer: writeWav(left, right, sampleRate), durationSeconds, sampleRate };
}
