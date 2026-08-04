import type { Effect, StudioProject, Track } from "../shared/types.js";

type ActiveSource = AudioScheduledSourceNode;

function midiFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

function dataUrlBytes(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private analyser?: AnalyserNode;
  private timer?: number;
  private currentStep = 0;
  private sources = new Set<ActiveSource>();
  private clipBuffers = new Map<string, AudioBuffer>();
  private meterData = new Uint8Array(128);

  constructor(private readonly onStep: (step: number) => void) {}

  get playing(): boolean {
    return this.timer !== undefined;
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.master.connect(this.analyser).connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  async start(project: StudioProject, fromStep = project.transport.loopStart): Promise<void> {
    this.stop();
    await this.ensureContext();
    this.currentStep = Math.max(project.transport.loopStart, Math.min(project.transport.loopEnd - 1, fromStep));
    const tick = (): void => {
      this.scheduleStep(project, this.currentStep);
      this.onStep(this.currentStep);
      this.currentStep += 1;
      if (this.currentStep >= project.transport.loopEnd) this.currentStep = project.transport.loopStart;
    };
    tick();
    const stepMs = 60_000 / project.transport.tempo / project.transport.stepsPerBeat;
    this.timer = window.setInterval(tick, stepMs);
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
  }

  meter(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.meterData);
    let sum = 0;
    for (const value of this.meterData) sum += ((value - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.meterData.length) * 2.8);
  }

  private scheduleStep(project: StudioProject, absoluteStep: number): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    master.gain.setTargetAtTime(project.master.mute ? 0 : project.master.volume, context.currentTime, 0.01);
    const anySolo = project.tracks.some((track) => track.mixer.solo);
    for (const track of project.tracks) {
      if (track.mixer.mute || (anySolo && !track.mixer.solo)) continue;
      const patternStep = absoluteStep % Math.max(1, track.steps.length);
      const step = track.steps[patternStep];
      if (track.type === "instrument" && step?.enabled) this.playVoice(track, step.note, step.velocity, step.gate, project);
      for (const clip of track.clips.filter((entry) => entry.startStep === absoluteStep)) void this.playClip(track, clip.id, clip.dataUrl, clip.sourceUrl, clip.gain, project);
    }
    if (project.transport.metronome && absoluteStep % project.transport.stepsPerBeat === 0) {
      const metronome = { ...project.tracks[0], instrument: { ...project.tracks[0].instrument, kind: "synth" as const, waveform: "square" as const }, effects: [] };
      this.playVoice(metronome, absoluteStep % (project.transport.stepsPerBeat * project.transport.numerator) === 0 ? 96 : 84, 0.16, 0.1, project);
    }
  }

  private makeTrackOutput(track: Track, project: StudioProject): AudioNode {
    const context = this.context!;
    let head: AudioNode = context.createGain();
    let tail = head;
    const add = (node: AudioNode): void => { tail.connect(node); tail = node; };

    const eqFrequencies = [100, 500, 2500, 9000];
    const eqValues = [track.eq.low, track.eq.lowMid, track.eq.highMid, track.eq.high];
    eqFrequencies.forEach((frequency, index) => {
      const node = context.createBiquadFilter();
      node.type = index === 0 ? "lowshelf" : index === 3 ? "highshelf" : "peaking";
      node.frequency.value = frequency;
      node.Q.value = 0.7;
      node.gain.value = eqValues[index];
      add(node);
    });
    for (const effect of track.effects.filter((item) => item.enabled)) {
      const node = this.effectNode(effect);
      if (node) add(node);
    }
    const panner = context.createStereoPanner();
    panner.pan.value = track.mixer.pan;
    add(panner);
    const gain = context.createGain();
    gain.gain.value = track.mixer.volume;
    add(gain);
    tail.connect(this.master!);
    return head;
  }

  private effectNode(effect: Effect): AudioNode | null {
    const context = this.context!;
    if (effect.type === "filter") {
      const node = context.createBiquadFilter();
      node.type = "lowpass";
      node.frequency.value = effect.parameters.cutoff ?? 8000;
      node.Q.value = effect.parameters.resonance ?? 0.7;
      return node;
    }
    if (effect.type === "distortion") {
      const node = context.createWaveShaper();
      const drive = effect.parameters.drive ?? 1.8;
      node.curve = Float32Array.from({ length: 1024 }, (_, index) => Math.tanh(((index / 512) - 1) * drive));
      node.oversample = "2x";
      return node;
    }
    if (effect.type === "compressor" || effect.type === "limiter") {
      const node = context.createDynamicsCompressor();
      node.threshold.value = effect.type === "limiter" ? -2 : effect.parameters.threshold ?? -18;
      node.ratio.value = effect.type === "limiter" ? 18 : effect.parameters.ratio ?? 4;
      return node;
    }
    if (effect.type === "delay" || effect.type === "chorus") {
      const node = context.createDelay(2);
      node.delayTime.value = effect.type === "chorus" ? 0.018 : effect.parameters.time ?? 0.25;
      return node;
    }
    if (effect.type === "reverb") {
      const convolver = context.createConvolver();
      const seconds = 1.4 + (effect.parameters.size ?? 0.55) * 2;
      const impulse = context.createBuffer(2, Math.floor(context.sampleRate * seconds), context.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
      }
      convolver.buffer = impulse;
      return convolver;
    }
    return null;
  }

  private playVoice(track: Track, note: number, velocity: number, gate: number, project: StudioProject): void {
    const context = this.context!;
    const now = context.currentTime;
    const duration = Math.max(0.04, 60 / project.transport.tempo / project.transport.stepsPerBeat * gate);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(velocity, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    envelope.connect(this.makeTrackOutput(track, project));

    let source: ActiveSource;
    if (track.instrument.kind === "drum") {
      const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        const t = i / context.sampleRate;
        if (note <= 36) data[i] = Math.sin(Math.PI * 2 * (52 + 110 * Math.exp(-t * 24)) * t) * Math.exp(-t * 12);
        else if (note <= 40) data[i] = ((Math.random() * 2 - 1) * 0.8 + Math.sin(Math.PI * 2 * 175 * t) * 0.2) * Math.exp(-t * 18);
        else data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 36);
      }
      const bufferSource = context.createBufferSource();
      bufferSource.buffer = buffer;
      source = bufferSource;
    } else {
      const oscillator = context.createOscillator();
      oscillator.type = track.instrument.waveform;
      oscillator.frequency.value = midiFrequency(note + track.instrument.octave * 12);
      source = oscillator;
    }
    source.connect(envelope);
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
    this.sources.add(source);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  private async playClip(track: Track, clipId: string, dataUrl: string | undefined, sourceUrl: string | undefined, gainValue: number, project: StudioProject): Promise<void> {
    if (!dataUrl && !sourceUrl) return;
    const context = await this.ensureContext();
    let buffer = this.clipBuffers.get(clipId);
    if (!buffer) {
      const bytes = dataUrl ? dataUrlBytes(dataUrl) : await (await fetch(sourceUrl!)).arrayBuffer();
      buffer = await context.decodeAudioData(bytes.slice(0));
      this.clipBuffers.set(clipId, buffer);
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = gainValue;
    source.buffer = buffer;
    source.connect(gain).connect(this.makeTrackOutput(track, project));
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
    this.sources.add(source);
    source.start();
  }
}
