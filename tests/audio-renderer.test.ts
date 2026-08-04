import { describe, expect, it } from "vitest";
import { renderProject } from "../src/server/audio-renderer.js";
import { createDefaultProject } from "../src/server/project.js";
import type { StudioProject, Track } from "../src/shared/types.js";

function wavDataUrl(leftValue: number, rightValue: number, frames = 4000, sampleRate = 8000): string {
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
  for (let frame = 0; frame < frames; frame += 1) {
    buffer.writeInt16LE(Math.round(leftValue * 32767), 44 + frame * 4);
    buffer.writeInt16LE(Math.round(rightValue * 32767), 46 + frame * 4);
  }
  return `data:audio/wav;base64,${buffer.toString("base64")}`;
}

function audioProject(): { project: StudioProject; track: Track } {
  const project = createDefaultProject();
  const track = project.tracks.find((entry) => entry.type === "audio")!;
  project.tracks = [track];
  project.transport.tempo = 120;
  project.transport.stepsPerBeat = 4;
  project.transport.loopStart = 8;
  project.transport.loopEnd = 12;
  project.master.volume = 1;
  track.mixer.volume = 1;
  track.mixer.pan = 0;
  track.eq = { low: 0, lowMid: 0, highMid: 0, high: 0 };
  track.effects = [];
  track.plugins = [];
  return { project, track };
}

function sample(buffer: Buffer, frame: number, channel: 0 | 1): number {
  return buffer.readInt16LE(44 + frame * 4 + channel * 2) / 32767;
}

function peak(buffer: Buffer): number {
  let maximum = 0;
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) maximum = Math.max(maximum, Math.abs(buffer.readInt16LE(offset)));
  return maximum;
}

describe("offline renderer parity", () => {
  it("places clips relative to loopStart and preserves overlapping source offsets", () => {
    const { project, track } = audioProject();
    track.clips = [{ id: "clip", name: "clip.wav", startStep: 6, lengthSteps: 6, gain: 1, mimeType: "audio/wav", dataUrl: wavDataUrl(0.2, 0.2) }];
    const rendered = renderProject(project, { sampleRate: 8000 });
    expect(Math.abs(sample(rendered.buffer, 100, 0))).toBeGreaterThan(0.05);
  });

  it("honors master mute", () => {
    const { project, track } = audioProject();
    track.clips = [{ id: "clip", name: "clip.wav", startStep: 8, lengthSteps: 4, gain: 1, mimeType: "audio/wav", dataUrl: wavDataUrl(0.3, 0.3) }];
    project.master.mute = true;
    expect(peak(renderProject(project, { sampleRate: 8000 }).buffer)).toBe(0);
  });

  it("processes EQ, mixer sends, and the built-in stereo-width plugin", () => {
    const { project, track } = audioProject();
    track.clips = [{ id: "clip", name: "clip.wav", startStep: 8, lengthSteps: 1, gain: 1, mimeType: "audio/wav", dataUrl: wavDataUrl(0.2, 0.05, 1000) }];
    const dry = renderProject(project, { sampleRate: 8000 });

    track.eq.low = 9;
    track.mixer.sendB = 0.8;
    track.plugins = [{ id: "enhancer", format: "builtin", name: "Stereo Enhancer", vendor: "Audio Studio", enabled: true, parameters: { width: 0 } }];
    const processed = renderProject(project, { sampleRate: 8000 });
    expect(processed.buffer.equals(dry.buffer)).toBe(false);
    expect(sample(processed.buffer, 100, 0)).toBeCloseTo(sample(processed.buffer, 100, 1), 3);
    expect(Math.abs(sample(processed.buffer, 2400, 0))).toBeGreaterThan(0.001);
  });
});
