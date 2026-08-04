export type TrackType = "instrument" | "audio";
export type InstrumentKind = "synth" | "drum" | "sampler" | "wam" | "vst3";
export type Waveform = "sine" | "square" | "sawtooth" | "triangle";
export type EffectType =
  | "filter"
  | "delay"
  | "reverb"
  | "distortion"
  | "compressor"
  | "chorus"
  | "limiter";

export interface Step {
  enabled: boolean;
  note: number;
  velocity: number;
  gate: number;
}

export interface Instrument {
  kind: InstrumentKind;
  name: string;
  preset: string;
  waveform: Waveform;
  octave: number;
  parameters: Record<string, number | string | boolean>;
}

export interface MixerSettings {
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sendA: number;
  sendB: number;
}

export interface Effect {
  id: string;
  type: EffectType;
  name: string;
  enabled: boolean;
  mix: number;
  parameters: Record<string, number>;
}

export interface PluginSlot {
  id: string;
  format: "builtin" | "wam" | "vst3";
  name: string;
  vendor: string;
  enabled: boolean;
  uri?: string;
  path?: string;
  parameters: Record<string, number>;
  state?: string;
}

export interface Equalizer {
  low: number;
  lowMid: number;
  highMid: number;
  high: number;
}

export interface AudioClip {
  id: string;
  name: string;
  startStep: number;
  lengthSteps: number;
  gain: number;
  mimeType: string;
  dataUrl?: string;
  sourceUrl?: string;
}

export interface PatternClip {
  id: string;
  name: string;
  startStep: number;
  lengthSteps: number;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  type: TrackType;
  instrument: Instrument;
  steps: Step[];
  patterns: PatternClip[];
  clips: AudioClip[];
  mixer: MixerSettings;
  eq: Equalizer;
  effects: Effect[];
  plugins: PluginSlot[];
}

export interface AutomationPoint {
  step: number;
  value: number;
  curve: "linear" | "hold" | "smooth";
}

export interface AutomationLane {
  id: string;
  name: string;
  target: string;
  color: string;
  min: number;
  max: number;
  enabled: boolean;
  points: AutomationPoint[];
}

export interface Transport {
  tempo: number;
  numerator: number;
  denominator: number;
  swing: number;
  stepsPerBeat: number;
  playing: boolean;
  recording: boolean;
  metronome: boolean;
  positionStep: number;
  loopStart: number;
  loopEnd: number;
}

export interface StudioProject {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  transport: Transport;
  master: MixerSettings;
  tracks: Track[];
  automation: AutomationLane[];
}

export interface RenderRecord {
  id: string;
  name: string;
  mimeType: "audio/wav";
  durationSeconds: number;
  sampleRate: number;
  channels: 2;
  buffer: Buffer;
  createdAt: string;
}
