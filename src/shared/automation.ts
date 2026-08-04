import type { AutomationLane, StudioProject, Track } from "./types.js";

export interface AutomationReader {
  has(target: string): boolean;
  value(target: string, step: number, fallback: number): number;
  first(targets: readonly string[], step: number, fallback: number): number;
}

function evaluateLane(lane: AutomationLane, step: number, fallback: number): number {
  const points = lane.points;
  if (points.length === 0) return fallback;
  if (step <= points[0].step) return points[0].value;
  const last = points.at(-1)!;
  if (step >= last.step) return last.value;

  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].step <= step) low = middle;
    else high = middle;
  }

  const previous = points[low];
  const next = points[high];
  if (previous.curve === "hold") return previous.value;
  let ratio = (step - previous.step) / Math.max(Number.EPSILON, next.step - previous.step);
  if (previous.curve === "smooth") ratio = ratio * ratio * (3 - 2 * ratio);
  return previous.value + (next.value - previous.value) * ratio;
}

export function createAutomationReader(project: StudioProject): AutomationReader {
  const lanes = new Map<string, AutomationLane>();
  for (const lane of project.automation) {
    if (!lane.enabled || lane.points.length === 0 || lanes.has(lane.target)) continue;
    lanes.set(lane.target, { ...lane, points: [...lane.points].sort((a, b) => a.step - b.step) });
  }
  return {
    has: (target) => lanes.has(target),
    value(target, step, fallback) {
      const lane = lanes.get(target);
      return lane ? evaluateLane(lane, step, fallback) : fallback;
    },
    first(targets, step, fallback) {
      const target = targets.find((candidate) => lanes.has(candidate));
      return target ? evaluateLane(lanes.get(target)!, step, fallback) : fallback;
    },
  };
}

function parameterValue(
  reader: AutomationReader,
  targets: readonly string[],
  step: number,
  fallback: number | string | boolean,
): number | string | boolean {
  return typeof fallback === "number" ? reader.first(targets, step, fallback) : fallback;
}

export function automateTrackAtStep(track: Track, step: number, reader: AutomationReader): Track {
  const prefix = `track:${track.id}`;
  const parameters = Object.fromEntries(Object.entries(track.instrument.parameters).map(([key, value]) => [
    key,
    parameterValue(reader, [`${prefix}.instrument.${key}`, `${prefix}.instrument:${key}`], step, value),
  ]));
  const effects = track.effects.map((effect) => ({
    ...effect,
    mix: reader.value(`${prefix}.effect:${effect.id}.mix`, step, effect.mix),
    parameters: Object.fromEntries(Object.entries(effect.parameters).map(([key, value]) => [
      key,
      reader.value(`${prefix}.effect:${effect.id}.${key}`, step, value),
    ])),
  }));
  const plugins = track.plugins.map((plugin) => ({
    ...plugin,
    parameters: Object.fromEntries(Object.entries(plugin.parameters).map(([key, value]) => [
      key,
      reader.value(`${prefix}.plugin:${plugin.id}.${key}`, step, value),
    ])),
  }));
  return {
    ...track,
    instrument: {
      ...track.instrument,
      octave: reader.first([`${prefix}.instrument.octave`, `${prefix}.instrument:octave`], step, track.instrument.octave),
      parameters,
    },
    mixer: {
      ...track.mixer,
      volume: reader.value(`${prefix}.volume`, step, track.mixer.volume),
      pan: reader.value(`${prefix}.pan`, step, track.mixer.pan),
      sendA: reader.value(`${prefix}.sendA`, step, track.mixer.sendA),
      sendB: reader.value(`${prefix}.sendB`, step, track.mixer.sendB),
    },
    eq: {
      low: reader.value(`${prefix}.eq.low`, step, track.eq.low),
      lowMid: reader.value(`${prefix}.eq.lowMid`, step, track.eq.lowMid),
      highMid: reader.value(`${prefix}.eq.highMid`, step, track.eq.highMid),
      high: reader.value(`${prefix}.eq.high`, step, track.eq.high),
    },
    effects,
    plugins,
  };
}

export function automatedMasterAtStep(project: StudioProject, step: number, reader: AutomationReader) {
  return {
    ...project.master,
    volume: reader.value("master.volume", step, project.master.volume),
    pan: reader.value("master.pan", step, project.master.pan),
  };
}
