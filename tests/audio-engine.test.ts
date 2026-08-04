import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultProject, makeEffect } from "../src/server/project.js";
import { AudioEngine } from "../src/web/audio-engine.js";

class FakeAudioParam {
  value = 0;

  setTargetAtTime(value: number): void { this.value = value; }
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
}

class FakeAudioNode {
  connect<T>(destination: T): T { return destination; }
  disconnect(): void {}
  addEventListener(): void {}
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 0;
  getByteTimeDomainData(): void {}
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = "peaking";
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  gain = new FakeAudioParam();
}

class FakeStereoPannerNode extends FakeAudioNode {
  pan = new FakeAudioParam();
}

class FakeChannelSplitterNode extends FakeAudioNode {}
class FakeChannelMergerNode extends FakeAudioNode {}

class FakeDelayNode extends FakeAudioNode {
  delayTime = new FakeAudioParam();
}

class FakeWaveShaperNode extends FakeAudioNode {
  curve?: Float32Array;
  oversample = "none";
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
}

class FakeConvolverNode extends FakeAudioNode {
  buffer?: AudioBuffer;
}

class FakeScheduledSourceNode extends FakeAudioNode {
  buffer?: unknown;
  type = "sine";
  frequency = new FakeAudioParam();
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  sampleRate = 44_100;
  destination = new FakeAudioNode();

  async resume(): Promise<void> {}
  createGain(): GainNode { return new FakeGainNode() as unknown as GainNode; }
  createAnalyser(): AnalyserNode { return new FakeAnalyserNode() as unknown as AnalyserNode; }
  createBiquadFilter(): BiquadFilterNode { return new FakeBiquadFilterNode() as unknown as BiquadFilterNode; }
  createStereoPanner(): StereoPannerNode { return new FakeStereoPannerNode() as unknown as StereoPannerNode; }
  createChannelSplitter(): ChannelSplitterNode { return new FakeChannelSplitterNode() as unknown as ChannelSplitterNode; }
  createChannelMerger(): ChannelMergerNode { return new FakeChannelMergerNode() as unknown as ChannelMergerNode; }
  createDelay(): DelayNode { return new FakeDelayNode() as unknown as DelayNode; }
  createWaveShaper(): WaveShaperNode { return new FakeWaveShaperNode() as unknown as WaveShaperNode; }
  createDynamicsCompressor(): DynamicsCompressorNode { return new FakeDynamicsCompressorNode() as unknown as DynamicsCompressorNode; }
  createConvolver(): ConvolverNode { return new FakeConvolverNode() as unknown as ConvolverNode; }
  createOscillator(): OscillatorNode { return new FakeScheduledSourceNode() as unknown as OscillatorNode; }
  createBufferSource(): AudioBufferSourceNode { return new FakeScheduledSourceNode() as unknown as AudioBufferSourceNode; }
  createBuffer(_channels: number, length: number): AudioBuffer {
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("AudioEngine", () => {
  it("applies mixer changes to the active audio graph", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });

    const project = createDefaultProject();
    project.tracks = [project.tracks[0]];
    const track = project.tracks[0];
    const engine = new AudioEngine(() => {});
    await engine.start(project);

    const next = structuredClone(project);
    next.master.volume = 0.23;
    next.tracks[0].mixer.volume = 0.17;
    next.tracks[0].mixer.pan = -0.4;
    engine.updateProject(next);

    const exposed = engine as unknown as {
      master: FakeGainNode;
      trackOutputs: Map<string, { gain: FakeGainNode; panner: FakeStereoPannerNode }>;
    };
    const output = exposed.trackOutputs.get(track.id);
    expect(exposed.master.gain.value).toBe(0.23);
    expect(output?.gain.gain.value).toBe(0.17);
    expect(output?.panner.pan.value).toBe(-0.4);

    engine.stop();
  });

  it("updates effect mix and parameters on the active graph", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });

    const project = createDefaultProject();
    project.tracks = [project.tracks[0]];
    const effect = makeEffect("filter");
    project.tracks[0].effects = [effect];
    const engine = new AudioEngine(() => {});
    await engine.start(project);

    const exposed = engine as unknown as { trackOutputs: Map<string, { effects: Map<string, { filter: FakeBiquadFilterNode; dry: FakeGainNode; wet: FakeGainNode }> }> };
    const runtime = exposed.trackOutputs.get(project.tracks[0].id)?.effects.get(effect.id);
    expect(runtime?.filter.frequency.value).toBe(8000);

    const next = structuredClone(project);
    next.tracks[0].effects[0].mix = 0.72;
    next.tracks[0].effects[0].parameters.cutoff = 940;
    next.tracks[0].effects[0].parameters.resonance = 8.5;
    engine.updateProject(next);

    const updated = exposed.trackOutputs.get(project.tracks[0].id)?.effects.get(effect.id);
    expect(updated).toBe(runtime);
    expect(updated?.filter.frequency.value).toBe(940);
    expect(updated?.filter.Q.value).toBe(8.5);
    expect(updated?.dry.gain.value).toBeCloseTo(Math.cos(0.72 * Math.PI / 2));
    expect(updated?.wet.gain.value).toBeCloseTo(Math.sin(0.72 * Math.PI / 2));
    engine.stop();
  });

  it("builds a wet/dry reverb and regenerates its impulse live", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });

    const project = createDefaultProject();
    project.tracks = [project.tracks[0]];
    const effect = makeEffect("reverb");
    project.tracks[0].effects = [effect];
    const engine = new AudioEngine(() => {});
    await engine.start(project);

    const exposed = engine as unknown as { trackOutputs: Map<string, { effects: Map<string, { convolver: FakeConvolverNode; damping: FakeBiquadFilterNode; preDelay: FakeDelayNode; impulseSize: number }> }> };
    const runtime = exposed.trackOutputs.get(project.tracks[0].id)?.effects.get(effect.id);
    const firstImpulse = runtime?.convolver.buffer;
    expect(firstImpulse).toBeDefined();

    const next = structuredClone(project);
    next.tracks[0].effects[0].parameters.size = 0.9;
    next.tracks[0].effects[0].parameters.damping = 0.8;
    next.tracks[0].effects[0].parameters.preDelay = 0.12;
    engine.updateProject(next);

    expect(runtime?.convolver.buffer).not.toBe(firstImpulse);
    expect(runtime?.impulseSize).toBe(0.9);
    expect(runtime?.damping.frequency.value).toBe(4000);
    expect(runtime?.preDelay.delayTime.value).toBe(0.12);
    engine.stop();
  });

  it("reschedules the running transport when tempo changes", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const setInterval = vi.fn(() => 1);
    const clearInterval = vi.fn();
    vi.stubGlobal("window", { setInterval, clearInterval });

    const project = createDefaultProject();
    project.tracks = [project.tracks[0]];
    const engine = new AudioEngine(() => {});
    await engine.start(project);
    expect(setInterval).toHaveBeenLastCalledWith(expect.any(Function), 60_000 / 128 / 4);

    const next = structuredClone(project);
    next.transport.tempo = 96;
    engine.updateProject(next);
    expect(clearInterval).toHaveBeenCalledWith(1);
    expect(setInterval).toHaveBeenLastCalledWith(expect.any(Function), 60_000 / 96 / 4);
    engine.stop();
  });

  it("applies automated mixer, effect, and built-in plugin values while playing", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });

    const project = createDefaultProject();
    project.tracks = [project.tracks[0]];
    const track = project.tracks[0];
    const effect = makeEffect("filter");
    track.effects = [effect];
    track.plugins = [{ id: "enhancer", format: "builtin", name: "Stereo Enhancer", vendor: "Audio Studio", enabled: true, parameters: { width: 1 } }];
    project.automation = [
      { id: "volume", name: "Volume", target: `track:${track.id}.volume`, color: "#ffffff", min: 0, max: 1, enabled: true, points: [{ step: 0, value: 0.2, curve: "linear" }] },
      { id: "cutoff", name: "Cutoff", target: `track:${track.id}.effect:${effect.id}.cutoff`, color: "#ffffff", min: 40, max: 20_000, enabled: true, points: [{ step: 0, value: 640, curve: "linear" }] },
      { id: "width", name: "Width", target: `track:${track.id}.plugin:enhancer.width`, color: "#ffffff", min: 0, max: 2, enabled: true, points: [{ step: 0, value: 0, curve: "linear" }] },
    ];

    const engine = new AudioEngine(() => {});
    await engine.start(project);
    const exposed = engine as unknown as { trackOutputs: Map<string, {
      gain: FakeGainNode;
      effects: Map<string, { filter: FakeBiquadFilterNode }>;
      width: { directLeft: FakeGainNode; crossLeft: FakeGainNode };
    }> };
    const output = exposed.trackOutputs.get(track.id)!;
    expect(output.gain.gain.value).toBe(0.2);
    expect(output.effects.get(effect.id)?.filter.frequency.value).toBe(640);
    expect(output.width.directLeft.gain.value).toBe(0.5);
    expect(output.width.crossLeft.gain.value).toBe(0.5);
    engine.stop();
  });
});
