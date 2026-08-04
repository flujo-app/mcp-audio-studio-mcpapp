import { describe, expect, it } from "vitest";
import { createStudioRuntime } from "../src/server/actions.js";

describe("studio runtime", () => {
  it("mutates sequencer, mixer, effects, plugins, and automation through tools", async () => {
    const runtime = await createStudioRuntime();
    const initial = runtime.store.snapshot();
    const track = initial.tracks[0];

    await runtime.call("set_steps", { trackId: track.id, updates: [{ index: 1, enabled: true, note: 48, velocity: 0.7 }] });
    await runtime.call("set_mixer", { target: track.id, volume: 0.6, pan: -0.25 });
    const effect = await runtime.call("add_effect", { trackId: track.id, type: "distortion", mix: 0.2 });
    const plugin = await runtime.call("add_plugin", { trackId: track.id, format: "vst3", name: "Test VST", vendor: "Test", path: "C:/plugins/test.vst3" });
    const automation = await runtime.call("upsert_automation", {
      name: "Kick volume",
      target: `track:${track.id}.volume`,
      color: "#ff9f43",
      min: 0,
      max: 1,
      points: [{ step: 0, value: 0.2 }, { step: 15, value: 1 }],
    });
    await runtime.call("upsert_automation", {
      laneId: automation.structuredContent?.laneId,
      name: "Kick volume updated",
      target: `track:${track.id}.volume`,
      color: "#ff9f43",
      min: 0,
      max: 1,
      points: [{ step: 4, value: 0.5 }],
    });

    const current = runtime.store.snapshot();
    expect(current.tracks[0].steps[1]).toMatchObject({ enabled: true, note: 48, velocity: 0.7 });
    expect(current.tracks[0].mixer).toMatchObject({ volume: 0.6, pan: -0.25 });
    expect(current.tracks[0].effects.at(-1)).toMatchObject({ id: effect.structuredContent?.effectId, type: "distortion" });
    expect(current.tracks[0].plugins[0]).toMatchObject({ id: plugin.structuredContent?.pluginId, format: "vst3" });
    expect(current.automation).toHaveLength(1);
    expect(current.automation[0]).toMatchObject({ id: automation.structuredContent?.laneId, name: "Kick volume updated" });
    expect(current.automation[0].points).toHaveLength(1);
    expect(current.revision).toBe(initial.revision + 6);
  });

  it("renders a playable stereo WAV", async () => {
    const runtime = await createStudioRuntime();
    const result = await runtime.call("render_audio", { name: "test", sampleRate: 22050, bars: 1 });
    const audio = result.content.find((item) => item.type === "audio");
    const buffer = Buffer.from(audio?.data as string, "base64");

    expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buffer.readUInt16LE(22)).toBe(2);
    expect(buffer.readUInt32LE(24)).toBe(22050);
    expect(buffer.length).toBeGreaterThan(100_000);
    expect(runtime.renders.get(result.structuredContent?.renderId as string)?.buffer.length).toBe(buffer.length);
  });

  it("exports and imports the project without losing structure", async () => {
    const runtime = await createStudioRuntime();
    await runtime.call("set_project", { name: "Portable Session" });
    const exported = await runtime.call("export_project", { pretty: false });
    await runtime.call("new_project", { name: "Temporary" });
    await runtime.call("import_project", { json: exported.structuredContent?.json });
    expect(runtime.store.snapshot().name).toBe("Portable Session");
    expect(runtime.store.snapshot().tracks).toHaveLength(6);
  });
});
