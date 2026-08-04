import { describe, expect, it } from "vitest";
import { encodeAudioBufferAsWav } from "../src/web/wav.js";

describe("browser WAV conversion", () => {
  it("encodes decoded browser audio as PCM WAV for server rendering", () => {
    const channels = [new Float32Array([0, 0.5, -0.5]), new Float32Array([0.25, -0.25, 1])];
    const audio = {
      numberOfChannels: 2,
      length: 3,
      sampleRate: 48_000,
      getChannelData: (channel: number) => channels[channel],
    } as AudioBuffer;
    const buffer = Buffer.from(encodeAudioBufferAsWav(audio));
    expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buffer.readUInt16LE(20)).toBe(1);
    expect(buffer.readUInt16LE(22)).toBe(2);
    expect(buffer.readUInt32LE(24)).toBe(48_000);
    expect(buffer.readInt16LE(48)).toBe(16_384);
    expect(buffer.readInt16LE(50)).toBe(-8192);
  });
});
