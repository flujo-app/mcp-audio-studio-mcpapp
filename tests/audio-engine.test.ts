import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultProject } from "../src/server/project.js";
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
});
