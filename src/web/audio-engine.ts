import type { AudioClip, Effect, EffectType, StudioProject, Track } from "../shared/types.js";
import { automateTrackAtStep, automatedMasterAtStep, createAutomationReader, type AutomationReader } from "../shared/automation.js";

type ActiveSource = AudioScheduledSourceNode;

interface EffectRuntime {
  id: string;
  type: EffectType;
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
  nodes: AudioNode[];
  filter?: BiquadFilterNode;
  delay?: DelayNode;
  feedback?: GainNode;
  convolver?: ConvolverNode;
  damping?: BiquadFilterNode;
  preDelay?: DelayNode;
  shaper?: WaveShaperNode;
  compressor?: DynamicsCompressorNode;
  lfo?: OscillatorNode;
  lfoDepth?: GainNode;
  impulseSize?: number;
}

interface TrackOutput {
  input: GainNode;
  gain: GainNode;
  panner: StereoPannerNode;
  pluginGain: GainNode;
  width: StereoWidthRuntime;
  sendA: GainNode;
  sendB: GainNode;
  eq: BiquadFilterNode[];
  effects: Map<string, EffectRuntime>;
  topology: string;
}

interface StereoWidthRuntime {
  input: ChannelSplitterNode;
  output: ChannelMergerNode;
  directLeft: GainNode;
  crossLeft: GainNode;
  directRight: GainNode;
  crossRight: GainNode;
  nodes: AudioNode[];
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class AudioEngine {
  private context?: AudioContext;
  private masterInput?: GainNode;
  private masterPanner?: StereoPannerNode;
  private master?: GainNode;
  private analyser?: AnalyserNode;
  private sendAInput?: GainNode;
  private sendBInput?: GainNode;
  private timer?: number;
  private currentStep = 0;
  private resumeOverlappingClips = true;
  private sources = new Set<ActiveSource>();
  private clipBuffers = new Map<string, AudioBuffer>();
  private trackOutputs = new Map<string, TrackOutput>();
  private meterData = new Uint8Array(128);
  private project?: StudioProject;
  private automation?: AutomationReader;

  constructor(private readonly onStep: (step: number) => void) {}

  get playing(): boolean {
    return this.timer !== undefined;
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      this.context = new AudioContext();
      this.masterInput = this.context.createGain();
      this.masterPanner = this.context.createStereoPanner();
      this.master = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.masterInput.connect(this.masterPanner).connect(this.master).connect(this.analyser).connect(this.context.destination);
      this.createSendBuses();
    }
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  async start(project: StudioProject, fromStep = project.transport.loopStart): Promise<void> {
    this.stop();
    await this.ensureContext();
    this.updateProject(project);
    this.currentStep = Math.max(project.transport.loopStart, Math.min(project.transport.loopEnd - 1, fromStep));
    this.resumeOverlappingClips = true;
    this.tick();
    this.restartTimer();
  }

  updateProject(project: StudioProject): void {
    const previousStepMs = this.project ? this.stepMilliseconds(this.project) : undefined;
    this.project = project;
    this.automation = createAutomationReader(project);
    const context = this.context;
    if (!context) return;

    const master = automatedMasterAtStep(project, this.currentStep, this.automation);
    this.master?.gain.setTargetAtTime(master.mute ? 0 : master.volume, context.currentTime, 0.01);
    this.masterPanner?.pan.setTargetAtTime(clamp(master.pan, -1, 1), context.currentTime, 0.01);
    const anySolo = project.tracks.some((track) => track.mixer.solo);
    for (const [trackId, output] of this.trackOutputs) {
      const track = project.tracks.find((entry) => entry.id === trackId);
      if (!track) {
        this.destroyTrackOutput(output);
        this.trackOutputs.delete(trackId);
        continue;
      }
      this.syncTrackOutput(output, automateTrackAtStep(track, this.currentStep, this.automation), anySolo);
    }

    const nextStepMs = this.stepMilliseconds(project);
    if (this.timer !== undefined && previousStepMs !== undefined && Math.abs(previousStepMs - nextStepMs) > 0.01) {
      this.restartTimer();
    }
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    for (const output of this.trackOutputs.values()) this.destroyTrackOutput(output);
    this.trackOutputs.clear();
  }

  meter(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.meterData);
    let sum = 0;
    for (const value of this.meterData) sum += ((value - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.meterData.length) * 2.8);
  }

  private stepMilliseconds(project: StudioProject): number {
    return 60_000 / project.transport.tempo / project.transport.stepsPerBeat;
  }

  private restartTimer(): void {
    if (!this.project) return;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), this.stepMilliseconds(this.project));
  }

  private tick(): void {
    const current = this.project;
    if (!current) return;
    if (this.currentStep < current.transport.loopStart || this.currentStep >= current.transport.loopEnd) {
      this.currentStep = current.transport.loopStart;
    }
    const resumeOverlaps = this.resumeOverlappingClips;
    this.resumeOverlappingClips = false;
    this.scheduleStep(current, this.currentStep, resumeOverlaps);
    this.onStep(this.currentStep);
    this.currentStep += 1;
    if (this.currentStep >= current.transport.loopEnd) {
      this.currentStep = current.transport.loopStart;
      this.resumeOverlappingClips = true;
    }
  }

  private scheduleStep(project: StudioProject, absoluteStep: number, resumeOverlaps: boolean): void {
    const context = this.context;
    const master = this.master;
    const automation = this.automation;
    if (!context || !master || !automation) return;
    const automatedMaster = automatedMasterAtStep(project, absoluteStep, automation);
    master.gain.setTargetAtTime(automatedMaster.mute ? 0 : automatedMaster.volume, context.currentTime, 0.01);
    this.masterPanner?.pan.setTargetAtTime(clamp(automatedMaster.pan, -1, 1), context.currentTime, 0.01);
    const anySolo = project.tracks.some((track) => track.mixer.solo);
    for (const track of project.tracks) {
      if (track.mixer.mute || (anySolo && !track.mixer.solo)) continue;
      const automatedTrack = automateTrackAtStep(track, absoluteStep, automation);
      const output = this.ensureTrackOutput(automatedTrack, project);
      this.syncTrackOutput(output, automatedTrack, anySolo);
      const pattern = automatedTrack.patterns?.find((entry) => absoluteStep >= entry.startStep && absoluteStep < entry.startStep + entry.lengthSteps);
      const patternStep = pattern
        ? (absoluteStep - pattern.startStep) % Math.max(1, automatedTrack.steps.length)
        : absoluteStep % Math.max(1, automatedTrack.steps.length);
      const step = automatedTrack.steps[patternStep];
      if (automatedTrack.type === "instrument" && pattern && step?.enabled) this.playVoice(automatedTrack, step.note, step.velocity, step.gate, project);
      for (const clip of automatedTrack.clips) {
        const startsNow = clip.startStep === absoluteStep;
        const overlapsResume = resumeOverlaps && clip.startStep < absoluteStep && clip.startStep + clip.lengthSteps > absoluteStep;
        if (startsNow || overlapsResume) void this.playClip(automatedTrack, clip, project, absoluteStep);
      }
    }
    if (project.transport.metronome && project.tracks[0] && absoluteStep % project.transport.stepsPerBeat === 0) {
      const metronome = { ...project.tracks[0], instrument: { ...project.tracks[0].instrument, kind: "synth" as const, waveform: "square" as const }, effects: [] };
      this.playVoice(metronome, absoluteStep % (project.transport.stepsPerBeat * project.transport.numerator) === 0 ? 96 : 84, 0.16, 0.1, project);
    }
  }

  private createSendBuses(): void {
    const context = this.context!;
    const masterInput = this.masterInput!;
    this.sendAInput = context.createGain();
    const convolver = context.createConvolver();
    const reverbReturn = context.createGain();
    reverbReturn.gain.value = 0.38;
    const impulse = context.createBuffer(2, Math.floor(context.sampleRate * 1.8), context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / data.length) ** 2.4;
    }
    convolver.buffer = impulse;
    this.sendAInput.connect(convolver).connect(reverbReturn).connect(masterInput);

    this.sendBInput = context.createGain();
    const delay = context.createDelay(2);
    const feedback = context.createGain();
    const delayReturn = context.createGain();
    delay.delayTime.value = 0.25;
    feedback.gain.value = 0.32;
    delayReturn.gain.value = 0.42;
    this.sendBInput.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(delayReturn).connect(masterInput);
  }

  private createStereoWidthRuntime(): StereoWidthRuntime {
    const context = this.context!;
    const input = context.createChannelSplitter(2);
    const output = context.createChannelMerger(2);
    const directLeft = context.createGain();
    const crossLeft = context.createGain();
    const directRight = context.createGain();
    const crossRight = context.createGain();
    input.connect(directLeft, 0);
    input.connect(crossLeft, 0);
    input.connect(directRight, 1);
    input.connect(crossRight, 1);
    directLeft.connect(output, 0, 0);
    crossRight.connect(output, 0, 0);
    crossLeft.connect(output, 0, 1);
    directRight.connect(output, 0, 1);
    return { input, output, directLeft, crossLeft, directRight, crossRight, nodes: [input, output, directLeft, crossLeft, directRight, crossRight] };
  }

  private updateBuiltinPlugins(output: TrackOutput, track: Track): void {
    let gain = 1;
    let width = 1;
    for (const plugin of track.plugins.filter((entry) => entry.enabled && entry.format === "builtin")) {
      gain *= clamp(plugin.parameters.gain ?? 1, 0, 4);
      if ("width" in plugin.parameters) width *= clamp(plugin.parameters.width, 0, 2);
    }
    output.pluginGain.gain.setTargetAtTime(gain, this.context!.currentTime, 0.01);
    const direct = (1 + width) / 2;
    const cross = (1 - width) / 2;
    output.width.directLeft.gain.setTargetAtTime(direct, this.context!.currentTime, 0.01);
    output.width.directRight.gain.setTargetAtTime(direct, this.context!.currentTime, 0.01);
    output.width.crossLeft.gain.setTargetAtTime(cross, this.context!.currentTime, 0.01);
    output.width.crossRight.gain.setTargetAtTime(cross, this.context!.currentTime, 0.01);
  }

  private ensureTrackOutput(track: Track, project: StudioProject): TrackOutput {
    const existing = this.trackOutputs.get(track.id);
    if (existing) return existing;

    const context = this.context!;
    const input = context.createGain();
    const eqFrequencies = [100, 500, 2500, 9000];
    const eq = eqFrequencies.map((frequency, index) => {
      const node = context.createBiquadFilter();
      node.type = index === 0 ? "lowshelf" : index === 3 ? "highshelf" : "peaking";
      node.frequency.value = frequency;
      node.Q.value = 0.7;
      return node;
    });
    const output: TrackOutput = {
      input,
      gain: context.createGain(),
      panner: context.createStereoPanner(),
      pluginGain: context.createGain(),
      width: this.createStereoWidthRuntime(),
      sendA: context.createGain(),
      sendB: context.createGain(),
      eq,
      effects: new Map(),
      topology: "__unbuilt__",
    };
    this.trackOutputs.set(track.id, output);
    this.syncTrackOutput(output, track, project.tracks.some((entry) => entry.mixer.solo));
    return output;
  }

  private makeTrackOutput(track: Track, project: StudioProject): AudioNode {
    return this.ensureTrackOutput(track, project).input;
  }

  private syncTrackOutput(output: TrackOutput, track: Track, anySolo: boolean): void {
    const context = this.context!;
    const eqValues = [track.eq.low, track.eq.lowMid, track.eq.highMid, track.eq.high];
    output.eq.forEach((node, index) => node.gain.setTargetAtTime(eqValues[index], context.currentTime, 0.01));

    const enabledEffects = track.effects.filter((effect) => effect.enabled);
    const topology = enabledEffects.map((effect) => `${effect.id}:${effect.type}`).join("|");
    if (topology !== output.topology) this.rebuildEffectChain(output, enabledEffects);
    for (const effect of enabledEffects) {
      const runtime = output.effects.get(effect.id);
      if (runtime) this.updateEffectRuntime(runtime, effect);
    }

    this.updateBuiltinPlugins(output, track);

    output.panner.pan.setTargetAtTime(track.mixer.pan, context.currentTime, 0.01);
    const volume = track.mixer.mute || (anySolo && !track.mixer.solo) ? 0 : track.mixer.volume;
    output.gain.gain.setTargetAtTime(volume, context.currentTime, 0.01);
    output.sendA.gain.setTargetAtTime(clamp(track.mixer.sendA, 0, 1), context.currentTime, 0.01);
    output.sendB.gain.setTargetAtTime(clamp(track.mixer.sendB, 0, 1), context.currentTime, 0.01);
  }

  private rebuildEffectChain(output: TrackOutput, effects: Effect[]): void {
    output.input.disconnect();
    output.eq.forEach((node) => node.disconnect());
    output.panner.disconnect();
    output.pluginGain.disconnect();
    output.width.output.disconnect();
    output.gain.disconnect();
    output.sendA.disconnect();
    output.sendB.disconnect();
    for (const runtime of output.effects.values()) this.destroyEffectRuntime(runtime);
    output.effects.clear();

    let tail: AudioNode = output.input;
    for (const node of output.eq) {
      tail.connect(node);
      tail = node;
    }
    for (const effect of effects) {
      const runtime = this.createEffectRuntime(effect);
      output.effects.set(effect.id, runtime);
      tail.connect(runtime.input);
      tail = runtime.output;
    }
    tail.connect(output.pluginGain);
    output.pluginGain.connect(output.width.input);
    output.width.output.connect(output.panner);
    output.panner.connect(output.gain);
    output.gain.connect(this.masterInput!);
    output.gain.connect(output.sendA).connect(this.sendAInput!);
    output.gain.connect(output.sendB).connect(this.sendBInput!);
    output.topology = effects.map((effect) => `${effect.id}:${effect.type}`).join("|");
  }

  private createEffectRuntime(effect: Effect): EffectRuntime {
    const context = this.context!;
    const input = context.createGain();
    const output = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    const runtime: EffectRuntime = { id: effect.id, type: effect.type, input, output, dry, wet, nodes: [input, output, dry, wet] };
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);

    if (effect.type === "filter") {
      runtime.filter = context.createBiquadFilter();
      runtime.filter.type = "lowpass";
      input.connect(runtime.filter);
      runtime.filter.connect(wet);
      runtime.nodes.push(runtime.filter);
    } else if (effect.type === "distortion") {
      runtime.shaper = context.createWaveShaper();
      runtime.shaper.oversample = "2x";
      input.connect(runtime.shaper);
      runtime.shaper.connect(wet);
      runtime.nodes.push(runtime.shaper);
    } else if (effect.type === "compressor" || effect.type === "limiter") {
      runtime.compressor = context.createDynamicsCompressor();
      input.connect(runtime.compressor);
      runtime.compressor.connect(wet);
      runtime.nodes.push(runtime.compressor);
    } else if (effect.type === "delay") {
      runtime.delay = context.createDelay(2);
      runtime.feedback = context.createGain();
      input.connect(runtime.delay);
      runtime.delay.connect(runtime.feedback);
      runtime.feedback.connect(runtime.delay);
      runtime.delay.connect(wet);
      runtime.nodes.push(runtime.delay, runtime.feedback);
    } else if (effect.type === "chorus") {
      runtime.delay = context.createDelay(0.1);
      runtime.lfo = context.createOscillator();
      runtime.lfoDepth = context.createGain();
      input.connect(runtime.delay);
      runtime.delay.connect(wet);
      runtime.lfo.connect(runtime.lfoDepth);
      runtime.lfoDepth.connect(runtime.delay.delayTime);
      runtime.lfo.start(context.currentTime);
      runtime.nodes.push(runtime.delay, runtime.lfo, runtime.lfoDepth);
    } else if (effect.type === "reverb") {
      runtime.preDelay = context.createDelay(1);
      runtime.convolver = context.createConvolver();
      runtime.damping = context.createBiquadFilter();
      runtime.damping.type = "lowpass";
      input.connect(runtime.preDelay);
      runtime.preDelay.connect(runtime.convolver);
      runtime.convolver.connect(runtime.damping);
      runtime.damping.connect(wet);
      runtime.nodes.push(runtime.preDelay, runtime.convolver, runtime.damping);
    }

    this.updateEffectRuntime(runtime, effect);
    return runtime;
  }

  private updateEffectRuntime(runtime: EffectRuntime, effect: Effect): void {
    const context = this.context!;
    const mix = clamp(effect.mix, 0, 1);
    runtime.dry.gain.setTargetAtTime(Math.cos(mix * Math.PI / 2), context.currentTime, 0.01);
    runtime.wet.gain.setTargetAtTime(Math.sin(mix * Math.PI / 2), context.currentTime, 0.01);

    if (runtime.filter) {
      runtime.filter.frequency.setTargetAtTime(clamp(effect.parameters.cutoff ?? 8000, 40, 20_000), context.currentTime, 0.015);
      runtime.filter.Q.setTargetAtTime(clamp(effect.parameters.resonance ?? 0.7, 0.1, 24), context.currentTime, 0.015);
    }
    if (runtime.shaper) {
      const drive = clamp(effect.parameters.drive ?? 1.8, 0.1, 20);
      runtime.shaper.curve = Float32Array.from({ length: 2048 }, (_, index) => Math.tanh(((index / 1024) - 1) * drive));
    }
    if (runtime.compressor) {
      const limiter = effect.type === "limiter";
      runtime.compressor.threshold.setTargetAtTime(limiter ? clamp(effect.parameters.ceiling ?? -0.8, -24, 0) : clamp(effect.parameters.threshold ?? -18, -60, 0), context.currentTime, 0.01);
      runtime.compressor.ratio.setTargetAtTime(limiter ? 20 : clamp(effect.parameters.ratio ?? 4, 1, 20), context.currentTime, 0.01);
      runtime.compressor.attack.setTargetAtTime(limiter ? 0.001 : clamp(effect.parameters.attack ?? 0.01, 0, 1), context.currentTime, 0.01);
      runtime.compressor.release.setTargetAtTime(clamp(effect.parameters.release ?? (limiter ? 0.08 : 0.25), 0.01, 1), context.currentTime, 0.01);
    }
    if (effect.type === "delay" && runtime.delay && runtime.feedback) {
      runtime.delay.delayTime.setTargetAtTime(clamp(effect.parameters.time ?? 0.25, 0.01, 1.8), context.currentTime, 0.01);
      runtime.feedback.gain.setTargetAtTime(clamp(effect.parameters.feedback ?? 0.28, 0, 0.92), context.currentTime, 0.01);
    }
    if (effect.type === "chorus" && runtime.delay && runtime.lfo && runtime.lfoDepth) {
      runtime.delay.delayTime.setTargetAtTime(0.018, context.currentTime, 0.01);
      runtime.lfo.frequency.setTargetAtTime(clamp(effect.parameters.rate ?? 0.8, 0.05, 10), context.currentTime, 0.01);
      runtime.lfoDepth.gain.setTargetAtTime(clamp(effect.parameters.depth ?? 0.25, 0, 1) * 0.012, context.currentTime, 0.01);
    }
    if (runtime.convolver && runtime.damping && runtime.preDelay) {
      const size = clamp(effect.parameters.size ?? 0.55, 0.05, 1);
      const damping = clamp(effect.parameters.damping ?? 0.4, 0, 1);
      runtime.preDelay.delayTime.setTargetAtTime(clamp(effect.parameters.preDelay ?? 0.02, 0, 0.25), context.currentTime, 0.01);
      runtime.damping.frequency.setTargetAtTime(14_000 - damping * 12_500, context.currentTime, 0.02);
      if (runtime.impulseSize === undefined || Math.abs(runtime.impulseSize - size) >= 0.01) {
        const seconds = 0.35 + size * 3.2;
        const impulse = context.createBuffer(2, Math.floor(context.sampleRate * seconds), context.sampleRate);
        for (let channel = 0; channel < 2; channel += 1) {
          const data = impulse.getChannelData(channel);
          for (let i = 0; i < data.length; i += 1) {
            const envelope = (1 - i / data.length) ** (1.4 + damping * 3.5);
            data[i] = (Math.random() * 2 - 1) * envelope;
          }
        }
        runtime.convolver.buffer = impulse;
        runtime.impulseSize = size;
      }
    }
  }

  private destroyEffectRuntime(runtime: EffectRuntime): void {
    if (runtime.lfo) {
      try { runtime.lfo.stop(); } catch { /* already stopped */ }
    }
    for (const node of runtime.nodes) node.disconnect();
  }

  private destroyTrackOutput(output: TrackOutput): void {
    output.input.disconnect();
    output.eq.forEach((node) => node.disconnect());
    output.panner.disconnect();
    output.pluginGain.disconnect();
    for (const node of output.width.nodes) node.disconnect();
    output.gain.disconnect();
    output.sendA.disconnect();
    output.sendB.disconnect();
    for (const runtime of output.effects.values()) this.destroyEffectRuntime(runtime);
  }

  private playVoice(track: Track, note: number, velocity: number, gate: number, project: StudioProject): void {
    const context = this.context!;
    const now = context.currentTime;
    const hold = Math.max(0.04, 60 / project.transport.tempo / project.transport.stepsPerBeat * gate);
    const attack = clamp(Number(track.instrument.parameters.attack ?? 0.01), 0.002, 4);
    const decay = clamp(Number(track.instrument.parameters.decay ?? 0.2), 0.002, 4);
    const sustain = clamp(Number(track.instrument.parameters.sustain ?? 0.6), 0.0001, 1);
    const release = clamp(Number(track.instrument.parameters.release ?? 0.15), 0.01, 8);
    const attackDuration = Math.min(attack, hold * 0.5);
    const decayDuration = Math.min(decay, Math.max(0.002, hold - attackDuration));
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(velocity, now + attackDuration);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, velocity * sustain), now + attackDuration + decayDuration);
    envelope.gain.setValueAtTime(Math.max(0.0001, velocity * sustain), now + hold);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + hold + release);
    envelope.connect(this.makeTrackOutput(track, project));

    let source: ActiveSource;
    if (track.instrument.kind === "drum") {
      const buffer = context.createBuffer(1, Math.floor(context.sampleRate * (hold + release)), context.sampleRate);
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
    const cutoff = clamp(Number(track.instrument.parameters.cutoff ?? 20_000), 40, 20_000);
    if (cutoff < 19_999) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cutoff;
      source.connect(filter).connect(envelope);
    } else {
      source.connect(envelope);
    }
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
    this.sources.add(source);
    source.start(now);
    source.stop(now + hold + release + 0.02);
  }

  private async playClip(track: Track, clip: AudioClip, project: StudioProject, absoluteStep: number): Promise<void> {
    if (!clip.dataUrl && !clip.sourceUrl) return;
    const context = await this.ensureContext();
    let buffer = this.clipBuffers.get(clip.id);
    if (!buffer) {
      const bytes = clip.dataUrl ? dataUrlBytes(clip.dataUrl) : await (await fetch(clip.sourceUrl!)).arrayBuffer();
      buffer = await context.decodeAudioData(bytes.slice(0));
      this.clipBuffers.set(clip.id, buffer);
    }
    const currentProject = this.project ?? project;
    const currentTrack = currentProject.tracks.find((entry) => entry.id === track.id) ?? track;
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = clip.gain;
    source.buffer = buffer;
    source.connect(gain).connect(this.makeTrackOutput(currentTrack, currentProject));
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
    this.sources.add(source);
    const secondsPerStep = 60 / currentProject.transport.tempo / currentProject.transport.stepsPerBeat;
    const offset = Math.max(0, absoluteStep - clip.startStep) * secondsPerStep;
    const remaining = Math.max(0, clip.startStep + clip.lengthSteps - absoluteStep) * secondsPerStep;
    const duration = Math.min(Math.max(0, buffer.duration - offset), remaining);
    if (duration > 0) source.start(context.currentTime, offset, Math.max(0.01, duration));
  }
}
