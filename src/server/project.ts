import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Effect,
  Instrument,
  MixerSettings,
  Step,
  StudioProject,
  Track,
  TrackType,
} from "../shared/types.js";

const COLORS = ["#ff9f43", "#ff5c8a", "#54d6a1", "#43b5ff", "#b983ff", "#ffe066", "#ff6b6b"];

export const DEFAULT_MIXER: MixerSettings = {
  volume: 0.82,
  pan: 0,
  mute: false,
  solo: false,
  sendA: 0,
  sendB: 0,
};

export function makeStep(enabled = false, note = 60, velocity = 0.82): Step {
  return { enabled, note, velocity, gate: 0.78 };
}

function defaultInstrument(name: string, kind: Instrument["kind"] = "synth"): Instrument {
  return {
    kind,
    name,
    preset: kind === "drum" ? name : "Init",
    waveform: name.toLowerCase().includes("bass") ? "sawtooth" : "triangle",
    octave: name.toLowerCase().includes("bass") ? -1 : 0,
    parameters: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15, cutoff: 16000 },
  };
}

export function makeTrack(input: {
  name: string;
  type?: TrackType;
  kind?: Instrument["kind"];
  color?: string;
  pattern?: number[];
  note?: number;
}): Track {
  const note = input.note ?? 60;
  const enabled = new Set(input.pattern ?? []);
  const id = randomUUID();
  return {
    id,
    name: input.name,
    color: input.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
    type: input.type ?? "instrument",
    instrument: defaultInstrument(input.name, input.kind ?? (input.type === "audio" ? "sampler" : "synth")),
    steps: Array.from({ length: 16 }, (_, index) => makeStep(enabled.has(index), note)),
    patterns: input.type === "audio" ? [] : [{ id: randomUUID(), name: "Pattern 1", startStep: 0, lengthSteps: 16 }],
    clips: [],
    mixer: { ...DEFAULT_MIXER },
    eq: { low: 0, lowMid: 0, highMid: 0, high: 0 },
    effects: [],
    plugins: [],
  };
}

export function makeEffect(type: Effect["type"]): Effect {
  const defaults: Record<Effect["type"], Record<string, number>> = {
    filter: { cutoff: 8000, resonance: 0.7 },
    delay: { time: 0.25, feedback: 0.28 },
    reverb: { size: 0.55, damping: 0.4, preDelay: 0.02 },
    distortion: { drive: 1.8 },
    compressor: { threshold: -18, ratio: 4, attack: 0.01, release: 0.25 },
    chorus: { rate: 0.8, depth: 0.25 },
    limiter: { ceiling: -0.8, release: 0.08 },
  };
  return {
    id: randomUUID(),
    type,
    name: type[0].toUpperCase() + type.slice(1),
    enabled: true,
    mix: type === "limiter" ? 1 : 0.35,
    parameters: defaults[type],
  };
}

export function createDefaultProject(name = "Neon Session"): StudioProject {
  const now = new Date().toISOString();
  const tracks = [
    makeTrack({ name: "Kick", kind: "drum", color: "#ff9f43", pattern: [0, 4, 8, 12], note: 36 }),
    makeTrack({ name: "Clap", kind: "drum", color: "#ff5c8a", pattern: [4, 12], note: 38 }),
    makeTrack({ name: "Hi Hat", kind: "drum", color: "#ffe066", pattern: [2, 6, 10, 14], note: 42 }),
    makeTrack({ name: "Bassline", color: "#54d6a1", pattern: [0, 3, 6, 8, 11, 14], note: 40 }),
    makeTrack({ name: "Lead", color: "#43b5ff", pattern: [2, 7, 10, 15], note: 64 }),
    makeTrack({ name: "Audio 1", type: "audio", color: "#b983ff" }),
  ];
  tracks[3].effects.push(makeEffect("filter"));
  tracks[4].effects.push(makeEffect("delay"));
  return {
    schemaVersion: 1,
    id: randomUUID(),
    name,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    transport: {
      tempo: 128,
      numerator: 4,
      denominator: 4,
      swing: 0.08,
      stepsPerBeat: 4,
      playing: false,
      recording: false,
      metronome: false,
      positionStep: 0,
      loopStart: 0,
      loopEnd: 16,
    },
    master: { ...DEFAULT_MIXER, volume: 0.88 },
    tracks,
    automation: [],
  };
}

function isProject(value: unknown): value is StudioProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<StudioProject>;
  return project.schemaVersion === 1 && typeof project.name === "string" && Array.isArray(project.tracks);
}

function normalizeProject(project: StudioProject): StudioProject {
  for (const track of project.tracks) {
    if (!Array.isArray(track.patterns)) {
      track.patterns = track.type === "instrument"
        ? [{ id: randomUUID(), name: "Pattern 1", startStep: project.transport.loopStart, lengthSteps: Math.max(1, track.steps.length) }]
        : [];
    }
  }
  return project;
}

export class ProjectStore {
  private project: StudioProject;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(project: StudioProject, private readonly dataPath?: string) {
    this.project = normalizeProject(project);
  }

  static async open(dataPath?: string): Promise<ProjectStore> {
    if (dataPath) {
      try {
        const parsed = JSON.parse(await readFile(path.resolve(dataPath), "utf8"));
        if (isProject(parsed)) return new ProjectStore(parsed, dataPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[audio-studio] Could not load ${dataPath}:`, error);
        }
      }
    }
    return new ProjectStore(createDefaultProject(), dataPath);
  }

  snapshot(): StudioProject {
    return structuredClone(this.project);
  }

  async replace(next: StudioProject): Promise<StudioProject> {
    if (!isProject(next)) throw new Error("Unsupported project document");
    const now = new Date().toISOString();
    this.project = normalizeProject(structuredClone({ ...next, revision: this.project.revision + 1, updatedAt: now }));
    await this.persist();
    return this.snapshot();
  }

  async reset(name?: string): Promise<StudioProject> {
    this.project = createDefaultProject(name);
    await this.persist();
    return this.snapshot();
  }

  async mutate(mutator: (project: StudioProject) => void): Promise<StudioProject> {
    mutator(this.project);
    this.project.revision += 1;
    this.project.updatedAt = new Date().toISOString();
    await this.persist();
    return this.snapshot();
  }

  private async persist(): Promise<void> {
    if (!this.dataPath) return;
    const target = path.resolve(this.dataPath);
    const payload = JSON.stringify(this.project, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, payload, "utf8");
    });
    await this.writeQueue;
  }
}
