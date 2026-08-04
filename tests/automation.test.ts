import { describe, expect, it } from "vitest";
import { automateTrackAtStep, createAutomationReader } from "../src/shared/automation.js";
import { createDefaultProject, makeEffect } from "../src/server/project.js";

describe("automation evaluation", () => {
  it("uses smoothstep interpolation instead of treating smooth as linear", () => {
    const project = createDefaultProject();
    project.automation = [{
      id: "smooth",
      name: "Smooth",
      target: "master.volume",
      color: "#ffffff",
      min: 0,
      max: 1,
      enabled: true,
      points: [
        { step: 0, value: 0, curve: "smooth" },
        { step: 10, value: 1, curve: "linear" },
      ],
    }];
    const reader = createAutomationReader(project);
    expect(reader.value("master.volume", 2.5, 1)).toBeCloseTo(0.15625);
    expect(reader.value("master.volume", 5, 1)).toBeCloseTo(0.5);
  });

  it("resolves mixer, instrument, effect, EQ, send, and plugin parameters", () => {
    const project = createDefaultProject();
    const track = project.tracks[0];
    const effect = makeEffect("filter");
    track.effects = [effect];
    track.plugins = [{ id: "enhancer", format: "builtin", name: "Stereo Enhancer", vendor: "Audio Studio", enabled: true, parameters: { width: 1 } }];
    const targets: Array<[string, number]> = [
      [`track:${track.id}.volume`, 0.31],
      [`track:${track.id}.sendA`, 0.42],
      [`track:${track.id}.eq.low`, 6],
      [`track:${track.id}.instrument.cutoff`, 900],
      [`track:${track.id}.effect:${effect.id}.mix`, 0.77],
      [`track:${track.id}.effect:${effect.id}.cutoff`, 1200],
      [`track:${track.id}.plugin:enhancer.width`, 0.25],
    ];
    project.automation = targets.map(([target, value], index) => ({
      id: String(index), name: target, target, color: "#ffffff", min: 0, max: 20_000, enabled: true,
      points: [{ step: 0, value, curve: "linear" }],
    }));
    const automated = automateTrackAtStep(track, 0, createAutomationReader(project));
    expect(automated.mixer.volume).toBe(0.31);
    expect(automated.mixer.sendA).toBe(0.42);
    expect(automated.eq.low).toBe(6);
    expect(automated.instrument.parameters.cutoff).toBe(900);
    expect(automated.effects[0].mix).toBe(0.77);
    expect(automated.effects[0].parameters.cutoff).toBe(1200);
    expect(automated.plugins[0].parameters.width).toBe(0.25);
  });
});
