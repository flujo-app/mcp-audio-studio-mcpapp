import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AutomationLane, EffectType, StudioProject, Track } from "../shared/types.js";
import { AudioEngine } from "./audio-engine.js";
import { callTool, downloadBase64File, downloadTextFile, onHostResult, updateModelContext, type StudioToolResult } from "./bridge.js";
import "./studio.css";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const EFFECTS: EffectType[] = ["filter", "delay", "reverb", "distortion", "compressor", "chorus", "limiter"];
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

  const addFile = async (file: File): Promise<void> => {
    if (!project) return;
    let target = selected;
    if (!target || target.type !== "audio") {
      const result = await run("add_track", { name: file.name.replace(/\.[^.]+$/, ""), type: "audio", instrumentKind: "sampler", color: "#b983ff" });
      const next = projectFromResult(result!);
      target = next?.tracks.find((track) => track.id === result?.structuredContent?.trackId);
      if (target) setSelectedId(target.id);
    }
    if (!target) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    await run("add_audio_clip", { trackId: target.id, name: file.name, startStep: 0, lengthSteps: project.transport.loopEnd, gain: 1, mimeType: file.type || "audio/wav", dataUrl });
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

  if (!project) return <main className="loading-screen"><div className="brand-mark">A</div><h1>Audio Studio</h1><p>{status}</p></main>;

  const steps = Array.from({ length: Math.max(16, project.transport.loopEnd) }, (_, index) => index);
  const baseNote = selected?.steps.find((step) => step.enabled)?.note ?? 60;
  const pianoNotes = Array.from({ length: 12 }, (_, index) => baseNote + 6 - index);

  return <div className="studio-shell">
    <header className="titlebar">
      <div className="logo"><span>AS</span><strong>AUDIO STUDIO</strong><em>MCP</em></div>
      <nav><button onClick={() => void run("new_project", { name: "Untitled Session" })}>FILE</button><button onClick={exportProject}>EXPORT</button><button onClick={() => fileInputRef.current?.click()}>ADD AUDIO</button><button onClick={addAutomation}>AUTOMATE</button></nav>
      <div className="status"><span className={busy ? "sync-dot active" : "sync-dot"}/>{status}</div>
      <input ref={fileInputRef} hidden type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void addFile(file); event.target.value = ""; }} />
    </header>

    <section className="transport-bar">
      <div className="transport-buttons">
        <button className="transport-button stop" onClick={stopPlayback} title="Stop">■</button>
        <button className={engineRef.current.playing ? "transport-button play active" : "transport-button play"} onClick={togglePlayback} title="Play / pause">▶</button>
        <button className={recording ? "transport-button record active" : "transport-button record"} onClick={toggleRecording} title="Record microphone">●</button>
      </div>
      <div className="tempo-box"><small>TEMPO</small><input type="number" min="30" max="300" value={project.transport.tempo} onChange={(event) => setProject({ ...project, transport: { ...project.transport, tempo: Number(event.target.value) } })} onBlur={(event) => void run("set_transport", { tempo: Number(event.target.value) })}/><b>BPM</b></div>
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
        <section><h3>AUDIO</h3><button className="browser-item" onClick={() => fileInputRef.current?.click()}><i>♫</i><span>Import sample</span><b>＋</b></button><button className="browser-item" onClick={() => void run("add_track", { name: "Audio Track", type: "audio", instrumentKind: "sampler" })}><i>▰</i><span>Blank audio track</span><b>＋</b></button></section>
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
            <div className="steps">{steps.slice(0, track.steps.length).map((index) => <button key={index} aria-label={`${track.name} step ${index + 1}`} className={`${track.steps[index]?.enabled ? "on" : ""} ${playhead === index ? "playing" : ""} ${index % 4 === 0 ? "beat" : ""}`} style={track.steps[index]?.enabled ? { background: track.color } : undefined} onClick={(event) => { event.stopPropagation(); void setStep(track, index); }}><span/></button>)}</div>
            <div className="channel-actions"><button className={track.mixer.mute ? "active" : ""} onClick={(event) => { event.stopPropagation(); void run("set_mixer", { target: track.id, mute: !track.mixer.mute }); }}>M</button><button className={track.mixer.solo ? "active" : ""} onClick={(event) => { event.stopPropagation(); void run("set_mixer", { target: track.id, solo: !track.mixer.solo }); }}>S</button></div>
          </div>)}
        </section>}

        {view === "playlist" && <section className="playlist-view">
          <div className="playlist-ruler"><span>TRACK</span>{steps.map((step) => <i key={step}>{step % 4 === 0 ? step / 4 + 1 : ""}</i>)}</div>
          {project.tracks.map((track) => <div className="playlist-row" key={track.id} onClick={() => setSelectedId(track.id)}><div><b style={{ color: track.color }}>●</b><span>{track.name}</span></div><div className="playlist-grid">{steps.map((step) => <i key={step} className={playhead === step ? "playhead" : ""}>{track.type === "instrument" && step % track.steps.length === 0 && <span className="pattern-block" style={{ background: `${track.color}88`, width: `${Math.min(track.steps.length, steps.length) * 100}%` }}>Pattern</span>}{track.clips.filter((clip) => clip.startStep === step).map((clip) => <span className="clip-block" key={clip.id} style={{ background: `${track.color}bb`, width: `${clip.lengthSteps * 100}%` }}>{clip.name}<button onClick={(event) => { event.stopPropagation(); void run("remove_audio_clip", { trackId: track.id, clipId: clip.id }); }}>×</button></span>)}</i>)}</div></div>)}
        </section>}

        {view === "piano" && selected && <section className="piano-view">
          <header><div><strong>{selected.name}</strong><small>PIANO ROLL · click notes to paint</small></div><label>Velocity<input type="range" min="0" max="1" step=".01" defaultValue=".82"/></label></header>
          <div className="piano-grid">{pianoNotes.map((note) => <React.Fragment key={note}><button className={NOTE_NAMES[note % 12].includes("#") ? "piano-key black" : "piano-key"}>{noteName(note)}</button><div className="piano-note-row">{steps.slice(0, selected.steps.length).map((step) => <button key={step} className={`${selected.steps[step]?.enabled && selected.steps[step].note === note ? "on" : ""} ${playhead === step ? "playing" : ""}`} style={selected.steps[step]?.enabled && selected.steps[step].note === note ? { background: selected.color } : undefined} onClick={() => void setStep(selected, step, note)}/>)}</div></React.Fragment>)}</div>
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
          <section className="inspector-section"><h3>EFFECTS <button onClick={() => void run("add_effect", { trackId: selected.id, type: "delay" })}>＋</button></h3><div className="slot-list">{selected.effects.map((effect) => <div className={effect.enabled ? "slot" : "slot bypassed"} key={effect.id}><button className="power" onClick={() => void run("update_effect", { trackId: selected.id, effectId: effect.id, enabled: !effect.enabled })}>●</button><span><b>{effect.name}</b><small>{effect.type} · {Math.round(effect.mix*100)}% wet</small></span><input type="range" min="0" max="1" step=".01" value={effect.mix} onChange={(event) => localTrack(selected.id, (track) => { const item = track.effects.find((entry) => entry.id === effect.id); if (item) item.mix = Number(event.target.value); })} onPointerUp={() => void run("update_effect", { trackId: selected.id, effectId: effect.id, mix: effect.mix })}/><button onClick={() => void run("remove_effect", { trackId: selected.id, effectId: effect.id })}>×</button></div>)}<select className="add-slot" defaultValue="" onChange={(event) => { if (event.target.value) void run("add_effect", { trackId: selected.id, type: event.target.value }); event.target.value = ""; }}><option value="" disabled>＋ Add effect…</option>{EFFECTS.map((effect) => <option key={effect}>{effect}</option>)}</select></div></section>
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
