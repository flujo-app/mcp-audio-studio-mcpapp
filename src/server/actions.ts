import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AutomationPoint,
  Effect,
  PluginSlot,
  RenderRecord,
  StudioProject,
  Track,
} from "../shared/types.js";
import { renderProject } from "./audio-renderer.js";
import { makeEffect, makeStep, makeTrack, ProjectStore } from "./project.js";

export interface ToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ActionDefinition {
  title: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface StudioRuntime {
  store: ProjectStore;
  actions: Map<string, ActionDefinition>;
  renders: Map<string, RenderRecord>;
  call(name: string, input: unknown): Promise<ToolResult>;
}

const id = z.string().min(1);
const finite = z.number().finite();

function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function projectResult(project: StudioProject, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return textResult(`${message} Project revision ${project.revision}.`, { project, revision: project.revision, ...extra });
}

function trackById(project: StudioProject, trackId: string): Track {
  const track = project.tracks.find((entry) => entry.id === trackId);
  if (!track) throw new Error(`Track not found: ${trackId}`);
  return track;
}

function effectById(track: Track, effectId: string): Effect {
  const effect = track.effects.find((entry) => entry.id === effectId);
  if (!effect) throw new Error(`Effect not found: ${effectId}`);
  return effect;
}

function pluginById(track: Track, pluginId: string): PluginSlot {
  const plugin = track.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
  return plugin;
}

function numberOr<T extends object, K extends keyof T>(target: T, key: K, value: unknown, min: number, max: number): void {
  if (typeof value === "number") target[key] = Math.max(min, Math.min(max, value)) as T[K];
}

export async function createStudioRuntime(dataPath?: string): Promise<StudioRuntime> {
  const store = await ProjectStore.open(dataPath);
  const renders = new Map<string, RenderRecord>();
  const actions = new Map<string, ActionDefinition>();

  const define = (name: string, definition: ActionDefinition): void => {
    actions.set(name, definition);
  };

  define("studio_ui", {
    title: "Open Audio Studio",
    description: "Open the complete interactive DAW. Use this when the user wants to see or edit the studio visually.",
    schema: z.object({}),
    readOnly: true,
    handler: async () => projectResult(store.snapshot(), "Opened Audio Studio."),
  });

  define("get_project", {
    title: "Get project",
    description: "Return the authoritative DAW project, including transport, tracks, steps, clips, mixer, effects, plugins, EQ, and automation.",
    schema: z.object({}),
    readOnly: true,
    handler: async () => projectResult(store.snapshot(), "Read the current project."),
  });

  define("new_project", {
    title: "New project",
    description: "Create a fresh demo-ready audio project, replacing the current project.",
    schema: z.object({ name: z.string().min(1).max(100).optional() }),
    destructive: true,
    handler: async ({ name }) => projectResult(await store.reset(name as string | undefined), "Created a new project."),
  });

  define("set_project", {
    title: "Set project metadata",
    description: "Rename the current project.",
    schema: z.object({ name: z.string().min(1).max(100) }),
    handler: async ({ name }) => projectResult(await store.mutate((project) => { project.name = name as string; }), "Updated project metadata."),
  });

  define("set_transport", {
    title: "Set transport",
    description: "Change playback, recording, tempo, time signature, swing, metronome, position, and loop settings.",
    schema: z.object({
      tempo: finite.min(30).max(300).optional(),
      numerator: z.number().int().min(1).max(16).optional(),
      denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]).optional(),
      swing: finite.min(0).max(0.75).optional(),
      stepsPerBeat: z.number().int().min(1).max(8).optional(),
      playing: z.boolean().optional(),
      recording: z.boolean().optional(),
      metronome: z.boolean().optional(),
      positionStep: z.number().int().min(0).optional(),
      loopStart: z.number().int().min(0).optional(),
      loopEnd: z.number().int().min(1).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const transport = project.transport;
      for (const key of ["tempo", "numerator", "denominator", "swing", "stepsPerBeat", "positionStep", "loopStart", "loopEnd"] as const) {
        if (typeof input[key] === "number") (transport[key] as number) = input[key] as number;
      }
      for (const key of ["playing", "recording", "metronome"] as const) {
        if (typeof input[key] === "boolean") transport[key] = input[key] as boolean;
      }
      if (transport.loopEnd <= transport.loopStart) transport.loopEnd = transport.loopStart + 1;
    }), "Updated transport."),
  });

  define("add_track", {
    title: "Add track",
    description: "Add an instrument or audio track linked to a built-in, sampler, WAM, or VST3 instrument slot.",
    schema: z.object({
      name: z.string().min(1).max(80),
      type: z.enum(["instrument", "audio"]).default("instrument"),
      instrumentKind: z.enum(["synth", "drum", "sampler", "wam", "vst3"]).default("synth"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      note: z.number().int().min(0).max(127).optional(),
    }),
    handler: async (input) => {
      let created!: Track;
      const project = await store.mutate((draft) => {
        created = makeTrack({
          name: input.name as string,
          type: input.type as Track["type"],
          kind: input.instrumentKind as Track["instrument"]["kind"],
          color: input.color as string | undefined,
          note: input.note as number | undefined,
        });
        draft.tracks.push(created);
      });
      return projectResult(project, `Added track ${created.name}.`, { trackId: created.id });
    },
  });

  define("update_track", {
    title: "Update track",
    description: "Update track name, color, type, instrument, preset, oscillator, or instrument parameters.",
    schema: z.object({
      trackId: id,
      name: z.string().min(1).max(80).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      type: z.enum(["instrument", "audio"]).optional(),
      instrumentKind: z.enum(["synth", "drum", "sampler", "wam", "vst3"]).optional(),
      instrumentName: z.string().min(1).max(100).optional(),
      preset: z.string().max(160).optional(),
      waveform: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
      octave: z.number().int().min(-4).max(4).optional(),
      parameters: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const track = trackById(project, input.trackId as string);
      if (input.name) track.name = input.name as string;
      if (input.color) track.color = input.color as string;
      if (input.type) track.type = input.type as Track["type"];
      if (input.instrumentKind) track.instrument.kind = input.instrumentKind as Track["instrument"]["kind"];
      if (input.instrumentName) track.instrument.name = input.instrumentName as string;
      if (typeof input.preset === "string") track.instrument.preset = input.preset;
      if (input.waveform) track.instrument.waveform = input.waveform as Track["instrument"]["waveform"];
      if (typeof input.octave === "number") track.instrument.octave = input.octave;
      if (input.parameters) Object.assign(track.instrument.parameters, input.parameters);
    }), "Updated track."),
  });

  define("remove_track", {
    title: "Remove track",
    description: "Remove a track and its notes, clips, mixer channel, effects, plugins, and related automation.",
    schema: z.object({ trackId: id }),
    destructive: true,
    handler: async ({ trackId }) => projectResult(await store.mutate((project) => {
      const index = project.tracks.findIndex((track) => track.id === trackId);
      if (index < 0) throw new Error(`Track not found: ${trackId}`);
      project.tracks.splice(index, 1);
      project.automation = project.automation.filter((lane) => !lane.target.startsWith(`track:${trackId}.`));
    }), "Removed track."),
  });

  define("set_steps", {
    title: "Set sequencer steps",
    description: "Edit step-sequencer or piano-roll notes. Each update can toggle a step and set MIDI note, velocity, and gate length.",
    schema: z.object({
      trackId: id,
      patternLength: z.number().int().min(1).max(256).optional(),
      updates: z.array(z.object({
        index: z.number().int().min(0).max(255),
        enabled: z.boolean().optional(),
        note: z.number().int().min(0).max(127).optional(),
        velocity: finite.min(0).max(1).optional(),
        gate: finite.min(0.01).max(4).optional(),
      })).min(1),
    }),
    handler: async ({ trackId, patternLength, updates }) => projectResult(await store.mutate((project) => {
      const track = trackById(project, trackId as string);
      if (typeof patternLength === "number") {
        while (track.steps.length < patternLength) track.steps.push(makeStep());
        track.steps.length = patternLength;
      }
      for (const update of updates as Array<Record<string, unknown>>) {
        const index = update.index as number;
        while (track.steps.length <= index) track.steps.push(makeStep());
        const step = track.steps[index];
        if (typeof update.enabled === "boolean") step.enabled = update.enabled;
        numberOr(step, "note", update.note, 0, 127);
        numberOr(step, "velocity", update.velocity, 0, 1);
        numberOr(step, "gate", update.gate, 0.01, 4);
      }
    }), "Updated sequencer notes."),
  });

  define("add_pattern_clip", {
    title: "Add pattern clip",
    description: "Place a sequencer pattern section on an instrument track in the playlist.",
    schema: z.object({
      trackId: id,
      name: z.string().min(1).max(160).optional(),
      startStep: z.number().int().min(0),
      lengthSteps: z.number().int().min(1).max(4096).optional(),
    }),
    handler: async (input) => {
      const patternId = randomUUID();
      const project = await store.mutate((project) => {
        const track = trackById(project, input.trackId as string);
        if (track.type !== "instrument") throw new Error("Pattern clips can only be added to instrument tracks");
        track.patterns.push({
          id: patternId,
          name: (input.name as string | undefined) ?? `Pattern ${track.patterns.length + 1}`,
          startStep: input.startStep as number,
          lengthSteps: (input.lengthSteps as number | undefined) ?? Math.max(1, track.steps.length),
        });
        project.transport.loopEnd = Math.max(project.transport.loopEnd, (input.startStep as number) + ((input.lengthSteps as number | undefined) ?? Math.max(1, track.steps.length)));
      });
      return projectResult(project, "Added pattern clip.", { patternId });
    },
  });

  define("update_pattern_clip", {
    title: "Update pattern clip",
    description: "Move, trim, or rename a sequencer pattern section in the playlist.",
    schema: z.object({
      trackId: id,
      patternId: id,
      name: z.string().min(1).max(160).optional(),
      startStep: z.number().int().min(0).optional(),
      lengthSteps: z.number().int().min(1).max(4096).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const pattern = trackById(project, input.trackId as string).patterns.find((entry) => entry.id === input.patternId);
      if (!pattern) throw new Error(`Pattern clip not found: ${input.patternId}`);
      if (input.name) pattern.name = input.name as string;
      numberOr(pattern, "startStep", input.startStep, 0, 1_000_000);
      numberOr(pattern, "lengthSteps", input.lengthSteps, 1, 1_000_000);
    }), "Updated pattern clip."),
  });

  define("remove_pattern_clip", {
    title: "Remove pattern clip",
    description: "Remove a sequencer pattern section from the playlist.",
    schema: z.object({ trackId: id, patternId: id }),
    destructive: true,
    handler: async ({ trackId, patternId }) => projectResult(await store.mutate((project) => {
      const track = trackById(project, trackId as string);
      const index = track.patterns.findIndex((pattern) => pattern.id === patternId);
      if (index < 0) throw new Error(`Pattern clip not found: ${patternId}`);
      track.patterns.splice(index, 1);
    }), "Removed pattern clip."),
  });

  define("add_audio_clip", {
    title: "Add audio clip",
    description: "Place an audio file on a track. Pass a data URL for bundled audio or a source URL for a remotely hosted file.",
    schema: z.object({
      trackId: id,
      name: z.string().min(1).max(160),
      startStep: z.number().int().min(0),
      lengthSteps: z.number().int().min(1).max(4096),
      gain: finite.min(0).max(4).default(1),
      mimeType: z.string().min(1).default("audio/wav"),
      dataUrl: z.string().startsWith("data:audio/").optional(),
      sourceUrl: z.string().url().optional(),
    }),
    handler: async (input) => {
      const clipId = randomUUID();
      const project = await store.mutate((project) => {
        const track = trackById(project, input.trackId as string);
        track.clips.push({
          id: clipId,
          name: input.name as string,
          startStep: input.startStep as number,
          lengthSteps: input.lengthSteps as number,
          gain: input.gain as number,
          mimeType: input.mimeType as string,
          dataUrl: input.dataUrl as string | undefined,
          sourceUrl: input.sourceUrl as string | undefined,
        });
      });
      return projectResult(project, "Added audio clip.", { clipId });
    },
  });

  define("update_audio_clip", {
    title: "Update audio clip",
    description: "Move, trim, rename, or change the gain of an audio clip.",
    schema: z.object({
      trackId: id,
      clipId: id,
      name: z.string().min(1).max(160).optional(),
      startStep: z.number().int().min(0).optional(),
      lengthSteps: z.number().int().min(1).max(4096).optional(),
      gain: finite.min(0).max(4).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const clip = trackById(project, input.trackId as string).clips.find((entry) => entry.id === input.clipId);
      if (!clip) throw new Error(`Audio clip not found: ${input.clipId}`);
      if (input.name) clip.name = input.name as string;
      numberOr(clip, "startStep", input.startStep, 0, 1_000_000);
      numberOr(clip, "lengthSteps", input.lengthSteps, 1, 1_000_000);
      numberOr(clip, "gain", input.gain, 0, 4);
    }), "Updated audio clip."),
  });

  define("remove_audio_clip", {
    title: "Remove audio clip",
    description: "Remove an audio clip from a track.",
    schema: z.object({ trackId: id, clipId: id }),
    destructive: true,
    handler: async ({ trackId, clipId }) => projectResult(await store.mutate((project) => {
      const track = trackById(project, trackId as string);
      const index = track.clips.findIndex((clip) => clip.id === clipId);
      if (index < 0) throw new Error(`Audio clip not found: ${clipId}`);
      track.clips.splice(index, 1);
    }), "Removed audio clip."),
  });

  define("set_mixer", {
    title: "Set mixer channel",
    description: "Set volume, panning, mute, solo, and send levels for a track or the master channel.",
    schema: z.object({
      target: z.string().min(1).describe("A track ID or the literal 'master'."),
      volume: finite.min(0).max(1.5).optional(),
      pan: finite.min(-1).max(1).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      sendA: finite.min(0).max(1).optional(),
      sendB: finite.min(0).max(1).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const mixer = input.target === "master" ? project.master : trackById(project, input.target as string).mixer;
      numberOr(mixer, "volume", input.volume, 0, 1.5);
      numberOr(mixer, "pan", input.pan, -1, 1);
      numberOr(mixer, "sendA", input.sendA, 0, 1);
      numberOr(mixer, "sendB", input.sendB, 0, 1);
      if (typeof input.mute === "boolean") mixer.mute = input.mute;
      if (typeof input.solo === "boolean") mixer.solo = input.solo;
    }), "Updated mixer channel."),
  });

  define("set_equalizer", {
    title: "Set equalizer",
    description: "Set the four-band EQ gains in dB for a track.",
    schema: z.object({
      trackId: id,
      low: finite.min(-24).max(24).optional(),
      lowMid: finite.min(-24).max(24).optional(),
      highMid: finite.min(-24).max(24).optional(),
      high: finite.min(-24).max(24).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const eq = trackById(project, input.trackId as string).eq;
      for (const key of ["low", "lowMid", "highMid", "high"] as const) numberOr(eq, key, input[key], -24, 24);
    }), "Updated equalizer."),
  });

  define("add_effect", {
    title: "Add effect",
    description: "Add a filter, delay, reverb, distortion, compressor, chorus, or limiter to a track effects chain.",
    schema: z.object({
      trackId: id,
      type: z.enum(["filter", "delay", "reverb", "distortion", "compressor", "chorus", "limiter"]),
      mix: finite.min(0).max(1).optional(),
      parameters: z.record(z.number().finite()).optional(),
    }),
    handler: async (input) => {
      let created!: Effect;
      const project = await store.mutate((project) => {
        created = makeEffect(input.type as Effect["type"]);
        if (typeof input.mix === "number") created.mix = input.mix;
        if (input.parameters) Object.assign(created.parameters, input.parameters);
        trackById(project, input.trackId as string).effects.push(created);
      });
      return projectResult(project, `Added ${created.name}.`, { effectId: created.id });
    },
  });

  define("update_effect", {
    title: "Update effect",
    description: "Enable, bypass, rename, mix, or change parameters on an effect slot.",
    schema: z.object({
      trackId: id,
      effectId: id,
      name: z.string().min(1).max(100).optional(),
      enabled: z.boolean().optional(),
      mix: finite.min(0).max(1).optional(),
      parameters: z.record(z.number().finite()).optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const effect = effectById(trackById(project, input.trackId as string), input.effectId as string);
      if (input.name) effect.name = input.name as string;
      if (typeof input.enabled === "boolean") effect.enabled = input.enabled;
      numberOr(effect, "mix", input.mix, 0, 1);
      if (input.parameters) Object.assign(effect.parameters, input.parameters);
    }), "Updated effect."),
  });

  define("remove_effect", {
    title: "Remove effect",
    description: "Remove an effect from a track effects chain.",
    schema: z.object({ trackId: id, effectId: id }),
    destructive: true,
    handler: async ({ trackId, effectId }) => projectResult(await store.mutate((project) => {
      const track = trackById(project, trackId as string);
      const index = track.effects.findIndex((effect) => effect.id === effectId);
      if (index < 0) throw new Error(`Effect not found: ${effectId}`);
      track.effects.splice(index, 1);
    }), "Removed effect."),
  });

  define("add_plugin", {
    title: "Add plugin",
    description: "Add a built-in, Web Audio Module (WAM), or VST3 plugin slot. VST3 slots expose parameters and state for a native bridge.",
    schema: z.object({
      trackId: id,
      format: z.enum(["builtin", "wam", "vst3"]),
      name: z.string().min(1).max(160),
      vendor: z.string().max(160).default("Unknown"),
      uri: z.string().url().optional(),
      path: z.string().optional(),
      parameters: z.record(z.number().finite()).optional(),
    }),
    handler: async (input) => {
      const pluginId = randomUUID();
      const project = await store.mutate((project) => {
        trackById(project, input.trackId as string).plugins.push({
          id: pluginId,
          format: input.format as PluginSlot["format"],
          name: input.name as string,
          vendor: input.vendor as string,
          enabled: true,
          uri: input.uri as string | undefined,
          path: input.path as string | undefined,
          parameters: (input.parameters as Record<string, number> | undefined) ?? {},
        });
      });
      return projectResult(project, "Added plugin slot.", { pluginId });
    },
  });

  define("update_plugin", {
    title: "Update plugin",
    description: "Enable, bypass, rename, change parameters, or store opaque plugin state for a plugin slot.",
    schema: z.object({
      trackId: id,
      pluginId: id,
      name: z.string().min(1).max(160).optional(),
      enabled: z.boolean().optional(),
      parameters: z.record(z.number().finite()).optional(),
      state: z.string().optional(),
    }),
    handler: async (input) => projectResult(await store.mutate((project) => {
      const plugin = pluginById(trackById(project, input.trackId as string), input.pluginId as string);
      if (input.name) plugin.name = input.name as string;
      if (typeof input.enabled === "boolean") plugin.enabled = input.enabled;
      if (input.parameters) Object.assign(plugin.parameters, input.parameters);
      if (typeof input.state === "string") plugin.state = input.state;
    }), "Updated plugin slot."),
  });

  define("remove_plugin", {
    title: "Remove plugin",
    description: "Remove a plugin slot from a track.",
    schema: z.object({ trackId: id, pluginId: id }),
    destructive: true,
    handler: async ({ trackId, pluginId }) => projectResult(await store.mutate((project) => {
      const track = trackById(project, trackId as string);
      const index = track.plugins.findIndex((plugin) => plugin.id === pluginId);
      if (index < 0) throw new Error(`Plugin not found: ${pluginId}`);
      track.plugins.splice(index, 1);
    }), "Removed plugin slot."),
  });

  define("upsert_automation", {
    title: "Set automation lane",
    description: "Create or update an automation lane for master/track volume, pan, effect, plugin, or instrument parameters.",
    schema: z.object({
      laneId: z.string().optional(),
      name: z.string().min(1).max(120),
      target: z.string().min(1).describe("Examples: master.volume, track:<id>.volume, track:<id>.pan, track:<id>.effect:<id>.mix"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ff9f43"),
      min: finite.default(0),
      max: finite.default(1),
      enabled: z.boolean().default(true),
      points: z.array(z.object({
        step: finite.min(0),
        value: finite,
        curve: z.enum(["linear", "hold", "smooth"]).default("linear"),
      })).default([]),
    }),
    handler: async (input) => {
      const laneId = (input.laneId as string | undefined) ?? randomUUID();
      const project = await store.mutate((project) => {
        const next = {
          id: laneId,
          name: input.name as string,
          target: input.target as string,
          color: input.color as string,
          min: input.min as number,
          max: input.max as number,
          enabled: input.enabled as boolean,
          points: (input.points as AutomationPoint[]).sort((a, b) => a.step - b.step),
        };
        const index = project.automation.findIndex((lane) => lane.id === laneId);
        if (index >= 0) project.automation[index] = next;
        else project.automation.push(next);
      });
      return projectResult(project, "Updated automation lane.", { laneId });
    },
  });

  define("remove_automation", {
    title: "Remove automation lane",
    description: "Remove an automation lane.",
    schema: z.object({ laneId: id }),
    destructive: true,
    handler: async ({ laneId }) => projectResult(await store.mutate((project) => {
      const index = project.automation.findIndex((lane) => lane.id === laneId);
      if (index < 0) throw new Error(`Automation lane not found: ${laneId}`);
      project.automation.splice(index, 1);
    }), "Removed automation lane."),
  });

  define("export_project", {
    title: "Export project",
    description: "Export the complete project as portable JSON.",
    schema: z.object({ pretty: z.boolean().default(true) }),
    readOnly: true,
    handler: async ({ pretty }) => {
      const project = store.snapshot();
      const json = JSON.stringify(project, null, pretty ? 2 : 0);
      return textResult(json, { project, json });
    },
  });

  define("import_project", {
    title: "Import project",
    description: "Replace the current project from an exported project JSON document.",
    schema: z.object({ json: z.string().min(2) }),
    destructive: true,
    handler: async ({ json }) => projectResult(await store.replace(JSON.parse(json as string)), "Imported project."),
  });

  define("render_audio", {
    title: "Render audio",
    description: "Offline-render the current project to a stereo 16-bit WAV file and return playable audio.",
    schema: z.object({
      name: z.string().min(1).max(120).default("audio-studio-render"),
      sampleRate: z.union([z.literal(22050), z.literal(44100), z.literal(48000), z.literal(96000)]).default(44100),
      bars: z.number().int().min(1).max(128).optional(),
    }),
    readOnly: true,
    handler: async ({ name, sampleRate, bars }) => {
      const rendered = renderProject(store.snapshot(), { sampleRate: sampleRate as number, bars: bars as number | undefined });
      const renderId = randomUUID();
      const record: RenderRecord = {
        id: renderId,
        name: `${String(name).replace(/[^a-z0-9-_]+/gi, "-")}.wav`,
        mimeType: "audio/wav",
        durationSeconds: rendered.durationSeconds,
        sampleRate: rendered.sampleRate,
        channels: 2,
        buffer: rendered.buffer,
        createdAt: new Date().toISOString(),
      };
      renders.set(renderId, record);
      while (renders.size > 8) renders.delete(renders.keys().next().value!);
      return {
        content: [
          { type: "text", text: `Rendered ${record.name} (${record.durationSeconds.toFixed(2)}s, ${record.sampleRate} Hz stereo). Render ID: ${renderId}` },
          { type: "audio", data: record.buffer.toString("base64"), mimeType: "audio/wav" },
        ],
        structuredContent: {
          renderId,
          name: record.name,
          durationSeconds: record.durationSeconds,
          sampleRate: record.sampleRate,
          byteLength: record.buffer.length,
        },
      };
    },
  });

  define("get_render", {
    title: "Get audio render",
    description: "Retrieve a recent rendered WAV file by render ID.",
    schema: z.object({ renderId: id }),
    readOnly: true,
    handler: async ({ renderId }) => {
      const record = renders.get(renderId as string);
      if (!record) throw new Error(`Render not found or expired: ${renderId}`);
      return {
        content: [
          { type: "text", text: `${record.name}, ${record.durationSeconds.toFixed(2)} seconds.` },
          { type: "audio", data: record.buffer.toString("base64"), mimeType: record.mimeType },
        ],
        structuredContent: { renderId: record.id, name: record.name, durationSeconds: record.durationSeconds, sampleRate: record.sampleRate },
      };
    },
  });

  const runtime: StudioRuntime = {
    store,
    actions,
    renders,
    async call(name, input) {
      const action = actions.get(name);
      if (!action) throw new Error(`Unknown studio tool: ${name}`);
      const parsed = action.schema.parse(input ?? {});
      return action.handler(parsed);
    },
  };
  return runtime;
}
