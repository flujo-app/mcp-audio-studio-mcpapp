import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AudioClip, AutomationLane, Effect, EffectType, StudioProject, Track } from "../shared/types.js";
import { AudioEngine } from "./audio-engine.js";
import { callTool, downloadBase64File, downloadTextFile, onHostResult, updateModelContext, type StudioToolResult } from "./bridge.js";
import { normalizeAudioFileToWav } from "./wav.js";
import "./studio.css";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const EFFECTS: EffectType[] = ["filter", "delay", "reverb", "distortion", "compressor", "chorus", "limiter"];
const EFFECT_CONTROLS: Record<EffectType, Array<{ key: string; label: string; min: number; max: number; step: number; unit?: string }>> = {
  filter: [{ key: "cutoff", label: "Cutoff", min: 40, max: 20_000, step: 10, unit: "Hz" }, { key: "resonance", label: "Resonance", min: 0.1, max: 24, step: 0.1 }],
  delay: [{ key: "time", label: "Time", min: 0.01, max: 1.8, step: 0.01, unit: "s" }, { key: "feedback", label: "Feedback", min: 0, max: 0.92, step: 0.01, unit: "%" }],
  reverb: [{ key: "size", label: "Size", min: 0.05, max: 1, step: 0.01, unit: "%" }, { key: "damping", label: "Damping", min: 0, max: 1, step: 0.01, unit: "%" }, { key: "preDelay", label: "Pre-delay", min: 0, max: 0.25, step: 0.005, unit: "s" }],
  distortion: [{ key: "drive", label: "Drive", min: 0.1, max: 20, step: 0.1, unit: "×" }],
  compressor: [{ key: "threshold", label: "Threshold", min: -60, max: 0, step: 0.5, unit: "dB" }, { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, unit: ":1" }, { key: "attack", label: "Attack", min: 0, max: 1, step: 0.005, unit: "s" }, { key: "release", label: "Release", min: 0.01, max: 1, step: 0.01, unit: "s" }],
  chorus: [{ key: "rate", label: "Rate", min: 0.05, max: 10, step: 0.05, unit: "Hz" }, { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, unit: "%" }],
  limiter: [{ key: "ceiling", label: "Ceiling", min: -24, max: 0, step: 0.1, unit: "dB" }, { key: "release", label: "Release", min: 0.01, max: 1, step: 0.01, unit: "s" }],
};
const TRACK_PRESETS = [
  { icon: "◉", name: "Kick", kind: "drum", note: 36, color: "#ff9f43" },
  { icon: "✦", name: "Snare", kind: "drum", note: 38, color: "#ff5c8a" },
  { icon: "✣", name: "Hi Hat", kind: "drum", note: 42, color: "#ffe066" },
  { icon: "≋", name: "Sub Bass", kind: "synth", note: 40, color: "#54d6a1" },
  { icon: "⌁", name: "Analog Lead", kind: "synth", note: 64, color: "#43b5ff" },
] as const;

type View = "rack" | "playlist" | "piano" | "automation";

function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function projectFromResult(result: StudioToolResult): StudioProject | undefined {
  return result.structuredContent?.project as StudioProject | undefined;
}

function displayEffectValue(value: number, unit?: string): string {
  if (unit === "%") return `${Math.round(value * 100)}%`;
  if (unit === "Hz" && value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value < 10 ? value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : Math.round(value)}${unit ?? ""}`;
}

function fallbackPeaks(seed: string, count = 64): number[] {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Array.from({ length: count }, (_, index) => {
    hash = Math.imul(hash ^ index, 16777619);
    return 0.12 + ((hash >>> 0) % 850) / 1000;
  });
}

const waveformCache = new Map<string, Promise<number[]>>();
let waveformContext: AudioContext | undefined;

async function decodePeaks(clip: AudioClip): Promise<number[]> {
  const source = clip.dataUrl ?? clip.sourceUrl;
  if (!source) return fallbackPeaks(clip.name);
  const cacheKey = `${clip.id}:${source.length}`;
  let pending = waveformCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const bytes = await (await fetch(source)).arrayBuffer();
      waveformContext ??= new AudioContext();
      const buffer = await waveformContext.decodeAudioData(bytes.slice(0));
      const channel = buffer.getChannelData(0);
      const count = 72;
      const bucket = Math.max(1, Math.floor(channel.length / count));
      return Array.from({ length: count }, (_, index) => {
        let peak = 0;
        const end = Math.min(channel.length, (index + 1) * bucket);
        for (let cursor = index * bucket; cursor < end; cursor += Math.max(1, Math.floor(bucket / 64))) peak = Math.max(peak, Math.abs(channel[cursor]));
        return Math.max(0.04, peak);
      });
    })().catch(() => fallbackPeaks(clip.name));
    waveformCache.set(cacheKey, pending);
  }
  return pending;
}

function Waveform({ clip }: { clip: AudioClip }): React.ReactElement {
  const [peaks, setPeaks] = useState(() => fallbackPeaks(clip.name));
  useEffect(() => {
    let active = true;
    void decodePeaks(clip).then((next) => { if (active) setPeaks(next); });
    return () => { active = false; };
  }, [clip.id, clip.dataUrl, clip.sourceUrl]);
  const points = useMemo(() => {
    const top = peaks.map((peak, index) => `${(index / Math.max(1, peaks.length - 1)) * 100},${15 - peak * 13}`);
    const bottom = [...peaks].reverse().map((peak, reverseIndex) => `${((peaks.length - 1 - reverseIndex) / Math.max(1, peaks.length - 1)) * 100},${15 + peak * 13}`);
    return [...top, ...bottom].join(" ");
  }, [peaks]);
  return <svg className="waveform" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polygon points={points}/><line x1="0" y1="15" x2="100" y2="15"/></svg>;
}

function PatternPreview({ track, length }: { track: Track; length: number }): React.ReactElement {
  const enabledNotes = track.steps.filter((step) => step.enabled).map((step) => step.note);
  const low = Math.min(...enabledNotes, 60);
  const high = Math.max(...enabledNotes, 61);
  const markers = Array.from({ length }, (_, index) => ({ index, step: track.steps[index % Math.max(1, track.steps.length)] })).filter(({ step }) => step?.enabled);
  return <span className="pattern-notes">{markers.map(({ index, step }) => <i key={index} style={{ left: `${index / length * 100}%`, width: `${Math.max(1.2, step.gate / length * 95)}%`, bottom: `${4 + ((step.note - low) / Math.max(1, high - low)) * 18}px` }}/>)}</span>;
}

function PlaylistBlock({ kind, name, color, startStep, lengthSteps, totalSteps, children, onPreview, onCommit, onRemove }: {
  kind: "pattern" | "audio"; name: string; color: string; startStep: number; lengthSteps: number; totalSteps: number;
  children?: React.ReactNode; onPreview: (start: number, length: number) => void; onCommit: (start: number, length: number) => void; onRemove: () => void;
}): React.ReactElement {
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startStep: number; length: number; currentStart: number; currentLength: number; pixelsPerStep: number } | undefined>(undefined);
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const grid = event.currentTarget.parentElement?.getBoundingClientRect();
    drag.current = { mode: (event.target as HTMLElement).closest(".clip-resize") ? "resize" : "move", startX: event.clientX, startStep, length: lengthSteps, currentStart: startStep, currentLength: lengthSteps, pixelsPerStep: Math.max(1, (grid?.width ?? totalSteps) / totalSteps) };
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = Math.round((event.clientX - state.startX) / state.pixelsPerStep);
    if (state.mode === "move") state.currentStart = Math.max(0, Math.min(totalSteps - state.length, state.startStep + delta));
    else state.currentLength = Math.max(1, Math.min(totalSteps - state.startStep, state.length + delta));
    onPreview(state.currentStart, state.currentLength);
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    event.stopPropagation();
    drag.current = undefined;
    onCommit(state.currentStart, state.currentLength);
  };
  const adjust = (start: number, length: number): void => {
    onPreview(start, length);
    onCommit(start, length);
  };
  return <div className={`playlist-block ${kind}`} style={{ left: `${startStep / totalSteps * 100}%`, width: `${lengthSteps / totalSteps * 100}%`, backgroundColor: `${color}${kind === "pattern" ? "88" : "bb"}` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
    {children}<strong>{name}</strong><span className="playlist-tools" onPointerDown={(event) => event.stopPropagation()}><button disabled={startStep <= 0} onClick={(event) => { event.stopPropagation(); adjust(startStep - 1, lengthSteps); }} aria-label={`Move ${name} left`} title={`Move ${name} left`}>‹</button><button disabled={startStep + lengthSteps >= totalSteps} onClick={(event) => { event.stopPropagation(); adjust(startStep + 1, lengthSteps); }} aria-label={`Move ${name} right`} title={`Move ${name} right`}>›</button><button disabled={lengthSteps <= 1} onClick={(event) => { event.stopPropagation(); adjust(startStep, lengthSteps - 1); }} aria-label={`Shorten ${name}`} title={`Shorten ${name}`}>−</button><button disabled={startStep + lengthSteps >= totalSteps} onClick={(event) => { event.stopPropagation(); adjust(startStep, lengthSteps + 1); }} aria-label={`Lengthen ${name}`} title={`Lengthen ${name}`}>＋</button><button onClick={(event) => { event.stopPropagation(); onRemove(); }} aria-label={`Delete ${name}`} title={`Delete ${name}`}>×</button></span><i className="clip-resize" title="Drag to trim"/>
  </div>;
}

function EffectEditor({ effect, onLocal, onCommit, onToggle, onRemove }: {
  effect: Effect; onLocal: (changes: { mix?: number; parameter?: { key: string; value: number } }) => void;
  onCommit: (changes: Record<string, unknown>) => void; onToggle: () => void; onRemove: () => void;
}): React.ReactElement {
  return <div className={effect.enabled ? "effect-editor" : "effect-editor bypassed"}>
    <div className="effect-title"><button className="power" onClick={onToggle}>●</button><span><b>{effect.name}</b><small>{effect.type}</small></span><button onClick={onRemove}>×</button></div>
    <label className="effect-control"><span>Mix <b>{Math.round(effect.mix * 100)}%</b></span><input type="range" min="0" max="1" step=".01" value={effect.mix} onChange={(event) => onLocal({ mix: Number(event.target.value) })} onPointerUp={(event) => onCommit({ mix: Number(event.currentTarget.value) })} onKeyUp={(event) => onCommit({ mix: Number(event.currentTarget.value) })}/></label>
    {EFFECT_CONTROLS[effect.type].map((control) => {
      const value = effect.parameters[control.key] ?? control.min;
      return <label className="effect-control" key={control.key}><span>{control.label} <b>{displayEffectValue(value, control.unit)}</b></span><input type="range" min={control.min} max={control.max} step={control.step} value={value} onChange={(event) => onLocal({ parameter: { key: control.key, value: Number(event.target.value) } })} onPointerUp={(event) => onCommit({ parameters: { [control.key]: Number(event.currentTarget.value) } })} onKeyUp={(event) => onCommit({ parameters: { [control.key]: Number(event.currentTarget.value) } })}/></label>;
    })}
  </div>;
}

function Knob({ value, min, max, label, onLocal, onCommit }: {
  value: number; min: number; max: number; label: string;
  onLocal: (value: number) => void; onCommit: (value: number) => void;
}): React.ReactElement {
  const degrees = -135 + ((value - min) / (max - min)) * 270;
  return <label className="knob-wrap" title={`${label}: ${value.toFixed(2)}`}>
    <span className="knob" style={{ "--knob-angle": `${degrees}deg` } as React.CSSProperties} />
    <input aria-label={label} type="range" min={min} max={max} step={(max - min) / 100} value={value}
      onChange={(event) => onLocal(Number(event.target.value))}
      onPointerUp={(event) => onCommit(Number(event.currentTarget.value))}
      onKeyUp={(event) => onCommit(Number(event.currentTarget.value))} />
    <small>{label}</small>
  </label>;
}

function AutomationGraph({ lane, loopEnd, onChange }: { lane: AutomationLane; loopEnd: number; onChange: (lane: AutomationLane) => void }): React.ReactElement {
  const points = lane.points.map((point) => {
    const x = 10 + (point.step / Math.max(1, loopEnd)) * 580;
    const normalized = (point.value - lane.min) / Math.max(0.0001, lane.max - lane.min);
    const y = 100 - normalized * 80;
    return { ...point, x, y };
  });
  const addPoint = (event: React.MouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const step = Math.round(((event.clientX - rect.left - 10) / Math.max(1, rect.width - 20)) * loopEnd);
    const normalized = 1 - (event.clientY - rect.top - 10) / Math.max(1, rect.height - 20);
    const value = Math.max(lane.min, Math.min(lane.max, lane.min + normalized * (lane.max - lane.min)));
    onChange({ ...lane, points: [...lane.points.filter((point) => point.step !== step), { step, value, curve: "linear" as const }].sort((a, b) => a.step - b.step) });
  };
  return <svg className="automation-graph" viewBox="0 0 600 110" onClick={addPoint} role="img" aria-label={`${lane.name} automation graph`}>
    <defs><linearGradient id={`fill-${lane.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={lane.color} stopOpacity=".35"/><stop offset="1" stopColor={lane.color} stopOpacity="0"/></linearGradient></defs>
    {Array.from({ length: 17 }, (_, i) => <line key={i} x1={10 + i * 36.25} y1="10" x2={10 + i * 36.25} y2="100" className="graph-grid" />)}
    <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={lane.color} strokeWidth="2.5" />
    {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="5" fill={lane.color} stroke="#161821" strokeWidth="2" />)}
  </svg>;
}

function Studio(): React.ReactElement {
  const [project, setProject] = useState<StudioProject>();
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<View>("rack");
  const [playhead, setPlayhead] = useState(0);
  const [status, setStatus] = useState("Connecting…");
  const [busy, setBusy] = useState(false);
  const [meter, setMeter] = useState(0);
  const [recording, setRecording] = useState(false);
  const engineRef = useRef<AudioEngine | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importTargetRef = useRef<string | undefined>(undefined);
  const pianoScrollRef = useRef<HTMLDivElement>(null);

  if (!engineRef.current) engineRef.current = new AudioEngine(setPlayhead);
  const selected = project?.tracks.find((track) => track.id === selectedId) ?? project?.tracks[0];

  const applyResult = useCallback((result: StudioToolResult): void => {
    const next = projectFromResult(result);
    if (next) {
      setProject(next);
      setSelectedId((current) => current && next.tracks.some((track) => track.id === current) ? current : next.tracks[0]?.id);
      setStatus(`Synced · revision ${next.revision}`);
    }
  }, []);

  const run = useCallback(async (name: string, args: Record<string, unknown> = {}): Promise<StudioToolResult | undefined> => {
    setBusy(true);
    setStatus(`${name.replaceAll("_", " ")}…`);
    try {
      const result = await callTool(name, args);
      if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text ?? `${name} failed`);
      applyResult(result);
      return result;
    } catch (error) {
      setStatus(`Error · ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [applyResult]);

  useEffect(() => {
    const off = onHostResult(applyResult);
    void run("get_project");
    const poll = window.setInterval(async () => {
      try {
        const result = await callTool("get_project", {});
        const next = projectFromResult(result);
        setProject((current) => {
          if (!current || (next && next.revision > current.revision)) return next ?? current;
          return current;
        });
      } catch { /* the host may suspend hidden apps */ }
    }, 1800);
    return () => { off(); window.clearInterval(poll); engineRef.current?.stop(); };
  }, [applyResult, run]);

  useEffect(() => {
    const animation = window.setInterval(() => setMeter(engineRef.current?.meter() ?? 0), 70);
    return () => window.clearInterval(animation);
  }, []);

  useEffect(() => {
    if (project) engineRef.current?.updateProject(project);
  }, [project]);

  useEffect(() => {
    if (selected) void updateModelContext(`Audio Studio selection: track "${selected.name}" (${selected.id}), view ${view}. Project revision ${project?.revision}.`);
  }, [selectedId, view, project?.revision]);

  useEffect(() => {
    if (view !== "piano" || !pianoScrollRef.current) return;
    const targetNote = selected?.steps.find((step) => step.enabled)?.note ?? 60;
    const rowTop = (127 - targetNote) * 26;
    pianoScrollRef.current.scrollTop = Math.max(0, rowTop - pianoScrollRef.current.clientHeight / 2);
  }, [view, selectedId]);

  const localTrack = (trackId: string, mutate: (track: Track) => void): void => {
    setProject((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const track = next.tracks.find((entry) => entry.id === trackId);
      if (track) mutate(track);
      return next;
    });
  };

  const togglePlayback = async (): Promise<void> => {
    if (!project) return;
    if (engineRef.current!.playing) {
      engineRef.current!.stop();
      await run("set_transport", { playing: false, positionStep: playhead });
    } else {
      await engineRef.current!.start(project, playhead);
      await run("set_transport", { playing: true, positionStep: playhead });
    }
  };

  const stopPlayback = async (): Promise<void> => {
    engineRef.current!.stop();
    setPlayhead(project?.transport.loopStart ?? 0);
    await run("set_transport", { playing: false, recording: false, positionStep: project?.transport.loopStart ?? 0 });
  };

  const renderAudio = async (): Promise<void> => {
    const result = await run("render_audio", { name: project?.name ?? "audio-studio-render", sampleRate: 44100 });
    const audio = result?.content?.find((item) => item.type === "audio" && item.data);
    if (!audio?.data) return;
    const name = `${project?.name ?? "audio-studio-render"}.wav`;
    try {
      const downloaded = await downloadBase64File(name, audio.mimeType ?? "audio/wav", audio.data);
      setStatus(downloaded ? `Downloaded · ${name}` : "Download cancelled");
    } catch (error) {
      setStatus(`Download error · ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportProject = async (): Promise<void> => {
    const result = await run("export_project", { pretty: true });
    const json = result?.structuredContent?.json as string | undefined;
    if (!json) return;
    const name = `${project?.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() ?? "project"}.audio-studio.json`;
    try {
      const downloaded = await downloadTextFile(name, "application/json", json);
      setStatus(downloaded ? `Exported · ${name}` : "Export cancelled");
    } catch (error) {
      setStatus(`Export error · ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const addFile = async (file: File, targetId?: string): Promise<void> => {
    if (!project) return;
    let portableFile: File;
    try {
      if (file.type.toLowerCase() !== "audio/wav" && !/\.wav$/i.test(file.name)) setStatus(`Converting ${file.name} to WAV…`);
      portableFile = await normalizeAudioFileToWav(file);
    } catch (error) {
      setStatus(`Audio conversion failed · ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let target = project.tracks.find((track) => track.id === targetId) ?? selected;
    if (!target || target.type !== "audio") {
      const result = await run("add_track", { name: portableFile.name.replace(/\.[^.]+$/, ""), type: "audio", instrumentKind: "sampler", color: "#b983ff" });
      const next = projectFromResult(result!);
      target = next?.tracks.find((track) => track.id === result?.structuredContent?.trackId);
      if (target) setSelectedId(target.id);
    }
    if (!target) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(portableFile);
    });
    await run("add_audio_clip", { trackId: target.id, name: portableFile.name, startStep: 0, lengthSteps: project.transport.loopEnd, gain: 1, mimeType: "audio/wav", dataUrl });
  };

  const requestAudioForTrack = (trackId?: string): void => {
    importTargetRef.current = trackId;
    fileInputRef.current?.click();
  };

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      await run("set_transport", { recording: false });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        await addFile(new File([blob], `recording-${Date.now()}.webm`, { type: recorder.mimeType }));
      };
      recorder.start();
      setRecording(true);
      await run("set_transport", { recording: true });
    } catch (error) {
      setStatus(`Microphone unavailable · ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setStep = async (track: Track, index: number, note?: number): Promise<void> => {
    const current = track.steps[index] ?? { enabled: false, note: note ?? 60, velocity: .82, gate: .78 };
    const enabled = note === undefined ? !current.enabled : current.note === note ? !current.enabled : true;
    localTrack(track.id, (draft) => {
      while (draft.steps.length <= index) draft.steps.push({ enabled: false, note: 60, velocity: .82, gate: .78 });
      Object.assign(draft.steps[index], { enabled, ...(note === undefined ? {} : { note }) });
    });
    await run("set_steps", { trackId: track.id, updates: [{ index, enabled, ...(note === undefined ? {} : { note }) }] });
  };

  const saveAutomation = async (lane: AutomationLane): Promise<void> => {
    const { id: laneId, ...changes } = lane;
    await run("upsert_automation", { laneId, ...changes });
  };

  const addAutomation = async (): Promise<void> => {
    if (!selected || !project) return;
    await run("upsert_automation", {
      name: `${selected.name} Volume`, target: `track:${selected.id}.volume`, color: selected.color,
      min: 0, max: 1.2, enabled: true,
      points: [{ step: 0, value: .2, curve: "linear" }, { step: project.transport.loopEnd / 2, value: 1, curve: "smooth" }, { step: project.transport.loopEnd, value: .45, curve: "linear" }],
    });
    setView("automation");
  };

  const addPatternAt = async (track: Track, startStep: number): Promise<void> => {
    const safeStart = Math.max(0, startStep);
    await run("add_pattern_clip", { trackId: track.id, startStep: safeStart, lengthSteps: Math.max(1, track.steps.length) });
  };

  if (!project) return <main className="loading-screen"><div className="brand-mark">A</div><h1>Audio Studio</h1><p>{status}</p></main>;

  const steps = Array.from({ length: Math.max(16, project.transport.loopEnd) }, (_, index) => index);
  const pianoNotes = Array.from({ length: 128 }, (_, index) => 127 - index);

  return <div className="studio-shell">
    <header className="titlebar">
      <div className="logo"><span>AS</span><strong>AUDIO STUDIO</strong><em>MCP</em></div>
      <nav><button onClick={() => void run("new_project", { name: "Untitled Session" })}>FILE</button><button onClick={exportProject}>EXPORT</button><button onClick={() => requestAudioForTrack()}>ADD AUDIO</button><button onClick={addAutomation}>AUTOMATE</button></nav>
      <div className="status"><span className={busy ? "sync-dot active" : "sync-dot"}/>{status}</div>
      <input ref={fileInputRef} hidden type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; const targetId = importTargetRef.current; importTargetRef.current = undefined; if (file) void addFile(file, targetId); event.target.value = ""; }} />
    </header>

    <section className="transport-bar">
      <div className="transport-buttons">
        <button className="transport-button stop" onClick={stopPlayback} title="Stop">■</button>
        <button className={engineRef.current.playing ? "transport-button play active" : "transport-button play"} onClick={togglePlayback} title="Play / pause">▶</button>
        <button className={recording ? "transport-button record active" : "transport-button record"} onClick={toggleRecording} title="Record microphone">●</button>
      </div>
      <div className="tempo-box"><small>TEMPO</small><input type="number" min="30" max="300" value={project.transport.tempo} onChange={(event) => { const tempo = Number(event.target.value); if (tempo >= 30 && tempo <= 300) setProject({ ...project, transport: { ...project.transport, tempo } }); }} onBlur={(event) => { const tempo = Math.max(30, Math.min(300, Number(event.target.value) || project.transport.tempo)); setProject({ ...project, transport: { ...project.transport, tempo } }); void run("set_transport", { tempo }); }}/><b>BPM</b></div>
      <label className="swing-control"><small>SWING</small><input type="range" min="0" max=".75" step=".01" value={project.transport.swing} onChange={(event) => setProject({ ...project, transport: { ...project.transport, swing: Number(event.target.value) } })} onPointerUp={() => void run("set_transport", { swing: project.transport.swing })}/><b>{Math.round(project.transport.swing * 100)}%</b></label>
      <button className={project.transport.metronome ? "mode-button active" : "mode-button"} onClick={() => void run("set_transport", { metronome: !project.transport.metronome })}>METRO</button>
      <button className="mode-button active">PAT</button>
      <div className="time-display"><small>BAR : BEAT : STEP</small><strong>{String(Math.floor(playhead / 16) + 1).padStart(2, "0")} : {String(Math.floor((playhead % 16) / 4) + 1).padStart(2, "0")} : {String(playhead % 4 + 1).padStart(2, "0")}</strong></div>
      <div className="master-meter"><span style={{ width: `${meter * 100}%` }}/></div>
      <button className="render-button" onClick={renderAudio}>↧ RENDER WAV</button>
    </section>

    <div className="workbench">
      <aside className="browser-panel">
        <div className="panel-heading"><span>BROWSER</span><button>⌕</button></div>
        <section><h3>INSTRUMENTS</h3>{TRACK_PRESETS.map((preset) => <button className="browser-item" key={preset.name} onClick={() => void run("add_track", { name: preset.name, instrumentKind: preset.kind, note: preset.note, color: preset.color })}><i>{preset.icon}</i><span>{preset.name}</span><b>＋</b></button>)}</section>
        <section><h3>AUDIO</h3><button className="browser-item" onClick={() => requestAudioForTrack()}><i>♫</i><span>Import sample</span><b>＋</b></button><button className="browser-item" onClick={() => void run("add_track", { name: "Audio Track", type: "audio", instrumentKind: "sampler" })}><i>▰</i><span>Blank audio track</span><b>＋</b></button></section>
        <section><h3>PLUGINS</h3><button className="browser-item" onClick={() => selected && void run("add_plugin", { trackId: selected.id, format: "builtin", name: "Stereo Enhancer", vendor: "Audio Studio", parameters: { width: .5 } })}><i>⬡</i><span>Built-in DSP</span><b>＋</b></button><button className="browser-item" onClick={() => { const uri = prompt("WAM module URL"); if (uri && selected) void run("add_plugin", { trackId: selected.id, format: "wam", name: "Web Audio Module", vendor: "External", uri }); }}><i>W</i><span>Web Audio Module</span><b>＋</b></button><button className="browser-item" onClick={() => { const path = prompt("VST3 plugin path (stored for a native host bridge)"); if (path && selected) void run("add_plugin", { trackId: selected.id, format: "vst3", name: path.split(/[\\/]/).pop() ?? "VST3", vendor: "External", path }); }}><i>V</i><span>VST3 slot</span><b>＋</b></button></section>
      </aside>

      <main className="main-stage">
        <div className="view-tabs">{(["rack", "playlist", "piano", "automation"] as View[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{item === "rack" ? "CHANNEL RACK" : item.toUpperCase()}</button>)}<span/><button onClick={() => void run("add_track", { name: `Instrument ${project.tracks.length + 1}`, instrumentKind: "synth" })}>＋ TRACK</button></div>

        {view === "rack" && <section className="rack-view">
          <div className="timeline-ruler"><span/><div>{steps.map((step) => <i key={step} className={step % 4 === 0 ? "beat" : ""}>{step % 4 === 0 ? step / 4 + 1 : "·"}</i>)}</div></div>
          {project.tracks.map((track) => <div key={track.id} className={selected?.id === track.id ? "channel-row selected" : "channel-row"} onClick={() => setSelectedId(track.id)}>
            <button className="track-led" style={{ background: track.color }} aria-label={`Select ${track.name}`}/><div className="channel-name"><strong>{track.name}</strong><small>{track.instrument.kind} · {track.instrument.preset}</small></div>
            <Knob label="VOL" min={0} max={1.5} value={track.mixer.volume} onLocal={(value) => localTrack(track.id, (draft) => { draft.mixer.volume = value; })} onCommit={(volume) => void run("set_mixer", { target: track.id, volume })} />
            <Knob label="PAN" min={-1} max={1} value={track.mixer.pan} onLocal={(value) => localTrack(track.id, (draft) => { draft.mixer.pan = value; })} onCommit={(pan) => void run("set_mixer", { target: track.id, pan })} />
            {track.type === "audio" ? <div className="rack-audio-lane">{track.clips.length === 0 && <small>Drop or import audio</small>}{track.clips.map((clip) => <span key={clip.id} style={{ left: `${clip.startStep / steps.length * 100}%`, width: `${Math.min(clip.lengthSteps, steps.length - clip.startStep) / steps.length * 100}%`, color: track.color }}><Waveform clip={clip}/></span>)}</div> : <div className="steps">{steps.slice(0, track.steps.length).map((index) => <button key={index} aria-label={`${track.name} step ${index + 1}`} className={`${track.steps[index]?.enabled ? "on" : ""} ${playhead === index ? "playing" : ""} ${index % 4 === 0 ? "beat" : ""}`} style={track.steps[index]?.enabled ? { background: track.color } : undefined} onClick={(event) => { event.stopPropagation(); void setStep(track, index); }}><span/></button>)}</div>}
            <div className="channel-actions"><button className={track.mixer.mute ? "active" : ""} onClick={(event) => { event.stopPropagation(); void run("set_mixer", { target: track.id, mute: !track.mixer.mute }); }}>M</button><button className={track.mixer.solo ? "active" : ""} onClick={(event) => { event.stopPropagation(); void run("set_mixer", { target: track.id, solo: !track.mixer.solo }); }}>S</button></div>
          </div>)}
        </section>}

        {view === "playlist" && <section className="playlist-view">
          <div className="playlist-ruler" style={{ gridTemplateColumns: `145px repeat(${steps.length}, minmax(22px, 1fr))` }}><span>TRACK · double-click to add</span>{steps.map((step) => <i key={step}>{step % 4 === 0 ? step / 4 + 1 : ""}</i>)}</div>
          {project.tracks.map((track) => <div className={selected?.id === track.id ? "playlist-row selected" : "playlist-row"} key={track.id} onClick={() => setSelectedId(track.id)}><div><b style={{ color: track.color }}>●</b><span>{track.name}</span><button title={track.type === "audio" ? `Add audio to ${track.name}` : `Add pattern to ${track.name}`} onClick={(event) => { event.stopPropagation(); if (track.type === "audio") requestAudioForTrack(track.id); else void addPatternAt(track, Math.max(playhead, ...track.patterns.map((pattern) => pattern.startStep + pattern.lengthSteps), 0)); }}>＋</button></div><div className="playlist-grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(22px, 1fr))` }} onDoubleClick={(event) => { if (track.type !== "instrument" || (event.target as HTMLElement).closest(".playlist-block")) return; const rect = event.currentTarget.getBoundingClientRect(); const at = Math.min(steps.length - 1, Math.floor((event.clientX - rect.left) / rect.width * steps.length)); void addPatternAt(track, at); }}>
            {steps.map((step) => <i key={step} className={playhead === step ? "playhead" : ""}/>)}
            {track.patterns.map((pattern) => <PlaylistBlock key={pattern.id} kind="pattern" name={pattern.name} color={track.color} startStep={pattern.startStep} lengthSteps={pattern.lengthSteps} totalSteps={steps.length} onPreview={(startStep, lengthSteps) => localTrack(track.id, (draft) => { const item = draft.patterns.find((entry) => entry.id === pattern.id); if (item) Object.assign(item, { startStep, lengthSteps }); })} onCommit={(startStep, lengthSteps) => void run("update_pattern_clip", { trackId: track.id, patternId: pattern.id, startStep, lengthSteps })} onRemove={() => void run("remove_pattern_clip", { trackId: track.id, patternId: pattern.id })}><PatternPreview track={track} length={pattern.lengthSteps}/></PlaylistBlock>)}
            {track.clips.map((clip) => <PlaylistBlock key={clip.id} kind="audio" name={clip.name} color={track.color} startStep={clip.startStep} lengthSteps={clip.lengthSteps} totalSteps={steps.length} onPreview={(startStep, lengthSteps) => localTrack(track.id, (draft) => { const item = draft.clips.find((entry) => entry.id === clip.id); if (item) Object.assign(item, { startStep, lengthSteps }); })} onCommit={(startStep, lengthSteps) => void run("update_audio_clip", { trackId: track.id, clipId: clip.id, startStep, lengthSteps })} onRemove={() => void run("remove_audio_clip", { trackId: track.id, clipId: clip.id })}><Waveform clip={clip}/></PlaylistBlock>)}
          </div></div>)}
        </section>}

        {view === "piano" && selected && <section className="piano-view">
          <header><div><strong>{selected.name}</strong><small>PIANO ROLL · scroll all 128 notes · click to paint</small></div><label>Velocity<input type="range" min="0" max="1" step=".01" defaultValue=".82"/></label></header>
          <div className="piano-scroll" ref={pianoScrollRef}><div className="piano-grid" style={{ gridTemplateColumns: `56px minmax(${selected.steps.length * 24}px, 1fr)` }}>{pianoNotes.map((note) => <React.Fragment key={note}><button className={NOTE_NAMES[note % 12].includes("#") ? "piano-key black" : "piano-key"}>{noteName(note)}</button><div className="piano-note-row" style={{ gridTemplateColumns: `repeat(${selected.steps.length}, minmax(24px, 1fr))` }}>{steps.slice(0, selected.steps.length).map((step) => <button key={step} aria-label={`${selected.name} ${noteName(note)} step ${step + 1}`} className={`${selected.steps[step]?.enabled && selected.steps[step].note === note ? "on" : ""} ${playhead === step ? "playing" : ""}`} style={selected.steps[step]?.enabled && selected.steps[step].note === note ? { background: selected.color } : undefined} onClick={() => void setStep(selected, step, note)}/>)}</div></React.Fragment>)}</div></div>
        </section>}

        {view === "automation" && <section className="automation-view">
          <header><div><strong>AUTOMATION TRACKS</strong><small>Click a graph to add or replace a control point</small></div><button onClick={addAutomation}>＋ NEW LANE</button></header>
          {project.automation.length === 0 ? <div className="empty-state"><span>⌁</span><h2>No automation yet</h2><p>Create a lane for the selected track’s volume.</p><button onClick={addAutomation}>CREATE AUTOMATION</button></div> : project.automation.map((lane) => <article key={lane.id}><div><i style={{ background: lane.color }}/><strong>{lane.name}</strong><small>{lane.target}</small><button onClick={() => void run("remove_automation", { laneId: lane.id })}>×</button></div><AutomationGraph lane={lane} loopEnd={project.transport.loopEnd} onChange={saveAutomation}/></article>)}
        </section>}
      </main>

      <aside className="inspector-panel">
        <div className="panel-heading"><span>CHANNEL INSPECTOR</span><button onClick={() => selected && void run("remove_track", { trackId: selected.id })}>×</button></div>
        {selected ? <>
          <section className="instrument-card"><div className="instrument-art" style={{ "--accent": selected.color } as React.CSSProperties}><span>{selected.instrument.kind === "drum" ? "◉" : selected.type === "audio" ? "♫" : "≋"}</span></div><div><small>INSTRUMENT</small><input value={selected.name} onChange={(event) => localTrack(selected.id, (track) => { track.name = event.target.value; })} onBlur={(event) => void run("update_track", { trackId: selected.id, name: event.target.value })}/><select value={selected.instrument.kind} onChange={(event) => void run("update_track", { trackId: selected.id, instrumentKind: event.target.value })}><option value="synth">Synth</option><option value="drum">Drum</option><option value="sampler">Sampler</option><option value="wam">WAM</option><option value="vst3">VST3 slot</option></select></div></section>
          <section className="inspector-section"><h3>SOUND</h3><div className="sound-controls"><label>WAVE<select value={selected.instrument.waveform} onChange={(event) => void run("update_track", { trackId: selected.id, waveform: event.target.value })}><option>sine</option><option>triangle</option><option>square</option><option>sawtooth</option></select></label><label>OCT<input type="number" min="-4" max="4" value={selected.instrument.octave} onChange={(event) => void run("update_track", { trackId: selected.id, octave: Number(event.target.value) })}/></label></div></section>
          <section className="inspector-section"><h3>EQUALIZER <small>dB</small></h3><div className="eq-display"><svg viewBox="0 0 240 90"><defs><linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1"><stop stopColor={selected.color} stopOpacity=".35"/><stop offset="1" stopColor={selected.color} stopOpacity="0"/></linearGradient></defs><path d={`M0 ${45-selected.eq.low*1.5} C40 ${45-selected.eq.low*1.5}, 50 ${45-selected.eq.lowMid*1.5}, 80 ${45-selected.eq.lowMid*1.5} S130 ${45-selected.eq.highMid*1.5}, 160 ${45-selected.eq.highMid*1.5} S210 ${45-selected.eq.high*1.5}, 240 ${45-selected.eq.high*1.5} L240 90 L0 90Z`} fill="url(#eqfill)" stroke={selected.color} strokeWidth="2"/></svg></div><div className="eq-sliders">{(["low", "lowMid", "highMid", "high"] as const).map((band) => <label key={band}><input type="range" min="-24" max="24" step=".5" value={selected.eq[band]} onChange={(event) => localTrack(selected.id, (track) => { track.eq[band] = Number(event.target.value); })} onPointerUp={() => void run("set_equalizer", { trackId: selected.id, ...selected.eq })}/><small>{band.toUpperCase()}</small></label>)}</div></section>
          <section className="inspector-section"><h3>EFFECTS <button onClick={() => void run("add_effect", { trackId: selected.id, type: "delay" })}>＋</button></h3><div className="slot-list">{selected.effects.map((effect) => <EffectEditor key={effect.id} effect={effect} onLocal={(changes) => localTrack(selected.id, (track) => { const item = track.effects.find((entry) => entry.id === effect.id); if (!item) return; if (typeof changes.mix === "number") item.mix = changes.mix; if (changes.parameter) item.parameters[changes.parameter.key] = changes.parameter.value; })} onCommit={(changes) => void run("update_effect", { trackId: selected.id, effectId: effect.id, ...changes })} onToggle={() => { localTrack(selected.id, (track) => { const item = track.effects.find((entry) => entry.id === effect.id); if (item) item.enabled = !item.enabled; }); void run("update_effect", { trackId: selected.id, effectId: effect.id, enabled: !effect.enabled }); }} onRemove={() => void run("remove_effect", { trackId: selected.id, effectId: effect.id })}/>)}<select className="add-slot" defaultValue="" onChange={(event) => { if (event.target.value) void run("add_effect", { trackId: selected.id, type: event.target.value }); event.target.value = ""; }}><option value="" disabled>＋ Add effect…</option>{EFFECTS.map((effect) => <option key={effect}>{effect}</option>)}</select></div></section>
          <section className="inspector-section"><h3>PLUGIN RACK <small>WAM / VST3</small></h3><div className="slot-list">{selected.plugins.map((plugin) => <div className={plugin.enabled ? "slot plugin" : "slot plugin bypassed"} key={plugin.id}><button className="power" onClick={() => void run("update_plugin", { trackId: selected.id, pluginId: plugin.id, enabled: !plugin.enabled })}>●</button><span><b>{plugin.name}</b><small>{plugin.format.toUpperCase()} · {plugin.vendor}</small></span><button onClick={() => void run("remove_plugin", { trackId: selected.id, pluginId: plugin.id })}>×</button></div>)}{selected.plugins.length === 0 && <p className="hint">Drop a browser-safe WAM here, or create a VST3 control/state slot for a native bridge.</p>}</div></section>
        </> : <div className="empty-state">Select a track</div>}
      </aside>
    </div>

    <footer className="mixer-console">
      <div className="mixer-title"><strong>MIXER</strong><small>{project.tracks.length + 1} channels</small></div>
      <div className="mixer-scroll">{project.tracks.map((track, index) => <div className={selected?.id === track.id ? "mixer-strip selected" : "mixer-strip"} key={track.id} onClick={() => setSelectedId(track.id)}><div className="strip-number">{String(index + 1).padStart(2, "0")}</div><div className="strip-meter"><i style={{ height: `${Math.min(95, track.mixer.volume * 70 + (engineRef.current?.playing ? Math.random()*15 : 0))}%`, background: track.color }}/></div><input className="fader" aria-label={`${track.name} volume`} type="range" min="0" max="1.5" step=".01" value={track.mixer.volume} onChange={(event) => localTrack(track.id, (draft) => { draft.mixer.volume = Number(event.target.value); })} onPointerUp={(event) => void run("set_mixer", { target: track.id, volume: Number(event.currentTarget.value) })} onKeyUp={(event) => void run("set_mixer", { target: track.id, volume: Number(event.currentTarget.value) })}/><div className="strip-buttons"><button className={track.mixer.mute ? "active" : ""} onClick={() => void run("set_mixer", { target: track.id, mute: !track.mixer.mute })}>M</button><button className={track.mixer.solo ? "active" : ""} onClick={() => void run("set_mixer", { target: track.id, solo: !track.mixer.solo })}>S</button></div><b title={track.name}>{track.name}</b></div>)}<div className="mixer-strip master"><div className="strip-number">M</div><div className="strip-meter stereo"><i style={{ height: `${meter*100}%` }}/><i style={{ height: `${meter*92}%` }}/></div><input className="fader" type="range" min="0" max="1.5" step=".01" value={project.master.volume} onChange={(event) => setProject({ ...project, master: { ...project.master, volume: Number(event.target.value) } })} onPointerUp={(event) => void run("set_mixer", { target: "master", volume: Number(event.currentTarget.value) })} onKeyUp={(event) => void run("set_mixer", { target: "master", volume: Number(event.currentTarget.value) })}/><div className="strip-buttons"><button className={project.master.mute ? "active" : ""} onClick={() => void run("set_mixer", { target: "master", mute: !project.master.mute })}>M</button></div><b>MASTER</b></div></div>
    </footer>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Studio />);
