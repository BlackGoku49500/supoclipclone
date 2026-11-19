"use client";
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Captions,
  Check,
  ChevronDown,
  CircleAlert,
  Clapperboard,
  Download,
  FileText,
  FileUp,
  Film,
  Frame,
  KeyRound,
  Layers2,
  Link2,
  LoaderCircle,
  Maximize,
  Minus,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Scissors,
  ShieldCheck,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import type { Clip, Settings, Source } from "../lib/types";
import { DEFAULT_SETTINGS, FramingEditor, FramingPreview } from "./Framing";
import StudioArtwork from "./StudioArtwork";
import "./studio.css";

const MODELS = [
  { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL" },
  { id: "openrouter/free", label: "Free auto-router" },
  { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash Exp" },
];
type Job = {
  status: "queued" | "running" | "done" | "failed";
  stage: string;
  progress: number;
  url?: string;
  error?: string;
};
type RenderPayload = { sourceId: string; clip: Clip; settings: Settings };
type PrepareTask = "analyze" | "upload" | "generate" | "demo";
const idle: Job = { status: "queued", stage: "Preparing", progress: 0 };

function readSaved(key: string, fallback = "") {
  try {
    return window.localStorage.getItem("supoclip." + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveSetting(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem("supoclip." + key, value);
    else window.localStorage.removeItem("supoclip." + key);
  } catch {
    /* Session state remains usable with storage disabled. */
  }
}
function clock(value: number, decimal = false) {
  const time = Math.max(0, Number.isFinite(value) ? value : 0),
    h = Math.floor(time / 3600),
    m = Math.floor(time / 60) % 60,
    s = Math.floor(time) % 60;
  return (
    (h ? h + ":" : "") +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    (decimal ? "." + Math.floor((time % 1) * 10 + 0.0001) : "")
  );
}
function durationOf(clip: Clip) {
  return clip.segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
}
function errText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request failed. Please try again.";
}
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  let data: T & { error?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error(
      res.status === 413
        ? "The upload is too large for this server."
        : "The studio service could not return a response. Try again shortly.",
    );
  }
  if (!res.ok)
    throw new Error(
      String(data.error || "Request failed (" + res.status + ").").replace(
        /sk-or-[a-zA-Z0-9_-]+/g,
        "[redacted]",
      ),
    );
  return data;
}
function post(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

// A stale, queued encoder is cancelled even if the user edits before POST returns its job ID.
function useRenderJob(
  kind: "preview" | "render",
  payload: RenderPayload | null,
  revision: number,
) {
  const serialized = payload ? JSON.stringify(payload) : "";
  const token = serialized ? kind + "|" + revision + "|" + serialized : "";
  const [entry, setEntry] = React.useState<{ key: string; job: Job } | null>(
    null,
  );
  React.useEffect(() => {
    if (!serialized) return;
    const controller = new AbortController();
    let active = true,
      jobId = "",
      terminal = false,
      poll: ReturnType<typeof setTimeout> | undefined;
    const display = (job: Job) => {
      if (active) setEntry({ key: token, job });
    };
    const stopRemote = () => {
      if (jobId && !terminal)
        void fetch("/api/jobs/" + encodeURIComponent(jobId), {
          method: "DELETE",
        }).catch(() => {});
    };
    const fail = (e: unknown) => {
      if (active)
        display({
          status: "failed",
          progress: 0,
          stage: "Failed",
          error: errText(e),
        });
    };
    const check = async () => {
      try {
        const j = await request<Job>("/api/jobs/" + encodeURIComponent(jobId), {
          signal: controller.signal,
        });
        terminal = j.status === "done" || j.status === "failed";
        if (j.status === "done" && !j.url)
          throw new Error("The encoder finished without a video file.");
        display(j);
        if (active && !terminal) poll = setTimeout(() => void check(), 900);
      } catch (e) {
        fail(e);
        stopRemote();
      }
    };
    const start = setTimeout(
      async () => {
        try {
          const r = await request<{ jobId: string }>(kind === "render" ? "/api/render-clip" : "/api/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: serialized,
          });
          if (!r.jobId) throw new Error("The encoder returned an invalid job.");
          jobId = r.jobId;
          if (!active) {
            stopRemote();
            return;
          }
          await check();
        } catch (e) {
          fail(e);
        }
      },
      kind === "preview" ? 850 : 0,
    );
    return () => {
      active = false;
      clearTimeout(start);
      clearTimeout(poll);
      controller.abort();
      stopRemote();
    };
  }, [serialized, token, kind]);
  return token ? (entry?.key === token ? entry.job : idle) : null;
}
function fileUrl(url: string, download = false) {
  let safe: URL;
  try {
    safe = new URL(url, window.location.origin);
  } catch {
    return "";
  }
  if (
    safe.origin !== window.location.origin ||
    !/^https?:$/.test(safe.protocol)
  )
    return "";
  if (download) safe.searchParams.set("download", "1");
  return safe.href;
}
function BrandMark() {
  return (
    <svg
      className="brandmark"
      width="36"
      height="34"
      viewBox="0 0 38 34"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7 3.2 21.9 14a3.5 3.5 0 0 1 0 5.8L3 32.2l3.3-11.7L14 15.9 4.5 9.1z" />
      <path d="m21.5 2.2 14.7 11.1a3.7 3.7 0 0 1 .1 6L17.4 31.6l3.2-11.5 7.3-4.5-9.2-6.9z" />
    </svg>
  );
}
function Heading({
  step,
  children,
  meta,
}: {
  step?: string;
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="panel-head">
      {step && <span className="step">{step}</span>}
      <h2>{children}</h2>
      {meta && <span className="section-meta">{meta}</span>}
    </div>
  );
}
function Standby() {
  return (
    <div className="poster">
      <div className="poster-art">
        <StudioArtwork />
      </div>
      <div className="poster-top">
        <span className="poster-signal" />
        PREVIEW MONITOR<span className="poster-cross">+</span>
      </div>
      <div className="poster-bottom">
        <span className="standby-kicker">
          <i />
          NO SOURCE
        </span>
        <strong>STANDBY</strong>
        <div className="poster-rule" />
      </div>
    </div>
  );
}
function Progress({ job, label }: { job: Job; label: string }) {
  return (
    <div className="job-progress" role="status">
      <div>
        <LoaderCircle className="spin" size={13} />
        <span>
          {label} · {job.stage}
        </span>
        <output>{Math.round(job.progress)}%</output>
      </div>
      <progress
        max={100}
        value={job.progress}
        aria-label={label + " progress"}
      />
    </div>
  );
}
function TrimEditor({
  clip,
  duration,
  onChange,
}: {
  clip: Clip;
  duration: number;
  onChange: (clip: Clip) => void;
}) {
  const segments = clip.segments;
  const extra = Math.max(0, 60 - durationOf(clip));
  const change = (i: number, field: "start" | "end", delta: number) => {
    const current = segments[i],
      lo =
        field === "start"
          ? Math.max(segments[i - 1]?.end ?? 0, current.start - extra)
          : current.start + 0.5;
    const hi =
      field === "end"
        ? Math.min(segments[i + 1]?.start ?? duration, current.end + extra)
        : current.end - 0.5;
    const value =
      Math.round(Math.max(lo, Math.min(hi, current[field] + delta)) * 100) /
      100;
    if (hi < lo || value === current[field]) return;
    onChange({
      ...clip,
      segments: segments.map((s, n) =>
        n === i ? { ...s, [field]: value } : s,
      ),
    });
  };
  return (
    <details className="panel segment-edit">
      <summary>
        <Scissors size={16} />
        <strong>Kept segments</strong>
        <span>
          {segments.length} · {durationOf(clip).toFixed(1)}s
        </span>
        <ChevronDown size={14} />
      </summary>
      <div className="panel-body">
        {segments.map((s, i) => (
          <div className="segment-row" key={i}>
            <span className="segment-label">Segment {i + 1}</span>
            <div className="segment-inputs">
              {(["start", "end"] as const).map((f) => (
                <div key={f} className="trim-group">
                  <label>{f === "start" ? "Start" : "End"}</label>
                  <div className="trim-control">
                    <button
                      type="button"
                      className="trim-button"
                      title="−0.5s"
                      aria-label={
                        "Reduce segment " +
                        (i + 1) +
                        " " +
                        f +
                        " by half a second"
                      }
                      onClick={() => change(i, f, -0.5)}
                    >
                      <Minus size={12} />
                    </button>
                    <output>{clock(s[f], true)}</output>
                    <button
                      type="button"
                      className="trim-button"
                      title="+0.5s"
                      aria-label={
                        "Increase segment " +
                        (i + 1) +
                        " " +
                        f +
                        " by half a second"
                      }
                      onClick={() => change(i, f, 0.5)}
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {segments.length > 1 && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  onChange({
                    ...clip,
                    segments: segments.filter((_, n) => i !== n),
                  })
                }
              >
                Remove segment
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function clearSavedAnalysis() {
  try { sessionStorage.removeItem("supoclip.analysis"); } catch {}
}

export default function Studio() {
  const [key, setKey] = React.useState(""),
    [model, setModel] = React.useState(MODELS[0].id);
  const [mode, setMode] = React.useState<"url" | "upload">("url"),
    [url, setUrl] = React.useState("");
  const [source, setSource] = React.useState<Source | null>(null),
    [localMedia, setLocalMedia] = React.useState("");
  const [text, setText] = React.useState(""),
    [manual, setManual] = React.useState(false);
  const [clips, setClips] = React.useState<Clip[]>([]),
    [chosen, setChosen] = React.useState(""),
    [editing, setEditing] = React.useState(false);
  const [settingsById, setSettingsById] = React.useState<
    Record<string, Settings>
  >({});
  const [analysisId, setAnalysisId] = React.useState("");
  const [analysisStage, setAnalysisStage] = React.useState("Queued for analysis");
  const [prepTask, setTask] = React.useState<PrepareTask | null>(null),
    [alert, setAlert] = React.useState("");
  const task = analysisId ? "generate" : prepTask;
  const [dragging, setDragging] = React.useState(false),
    [draggingFrame, setDraggingFrame] = React.useState(false);
  const [previewRevision, setPreviewRevision] = React.useState(0),
    [exportRevision, setExportRevision] = React.useState(0);
  const [exportPayload, setExportPayload] =
    React.useState<RenderPayload | null>(null);
  const upload = React.useRef<HTMLInputElement>(null),
    subtitles = React.useRef<HTMLInputElement>(null),
    keyRef = React.useRef<HTMLInputElement>(null),
    linkRef = React.useRef<HTMLInputElement>(null);
  const latest = React.useRef<AbortController | null>(null),
    sourceSignature = React.useRef("");
  const sourceMedia =
    localMedia || (source?.provider === "Demo" ? "/demo/study.mp4" : "");
  const chosenClip = clips.find((c) => c.id === chosen) ?? null,
    settings = settingsById[chosen] ?? DEFAULT_SETTINGS;
  const payload =
    editing && source && chosenClip
      ? { sourceId: source.id, clip: chosenClip, settings }
      : null;
  const preview = useRenderJob(
    "preview",
    draggingFrame ? null : payload,
    previewRevision,
  );
  const output = useRenderJob("render", exportPayload, exportRevision);
  const exporting =
      !!output && (output.status === "running" || output.status === "queued"),
    locked = !!task || exporting;
  const video = React.useRef<HTMLVideoElement>(null),
    monitor = React.useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = React.useState(false),
    [time, setTime] = React.useState(0),
    [playLength, setPlayLength] = React.useState(0),
    [playing, setPlaying] = React.useState(false),
    [muted, setMuted] = React.useState(false);
  const [playerError, setPlayerError] = React.useState(false);
  const playback =
    preview?.status === "done" && preview.url ? fileUrl(preview.url) : "";
  const goodPlayback = !!playback && !playerError;
  const length =
    playLength || (editing && chosenClip ? durationOf(chosenClip) : 0);
  const downloadUrl =
    output?.status === "done" && output.url ? fileUrl(output.url, true) : "";
  const downloaded = React.useRef("");
  React.useEffect(() => {
    setKey(readSaved("key"));
    try { setAnalysisId(sessionStorage.getItem("supoclip.analysis") || ""); } catch {}
    const saved = readSaved("model");
    if (MODELS.some((m) => m.id === saved)) setModel(saved);
    return () => latest.current?.abort();
  }, []);
  React.useEffect(() => {
    if (!analysisId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const state = await request<Job & { source: Source; clips?: Clip[] }>(
          "/api/analysis-jobs/" + encodeURIComponent(analysisId), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSource(state.source);
        setMode(state.source.provider === "Local" ? "upload" : "url");
        setAnalysisStage(state.stage + " · " + Math.round(state.progress) + "%");
        if (state.status === "done" || state.status === "failed") {
          if (state.clips?.length) {
            setClips(state.clips);
            setChosen(state.clips[0].id);
            setSettingsById({});
            setExportPayload(null);
            setEditing(true);
          }
          if (state.error) setAlert(state.error);
          setAnalysisId("");
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof TypeError) {
          setAnalysisStage("Reconnecting to the worker…");
          timer = setTimeout(poll, 4000);
        } else {
          setAlert(errText(error));
          clearSavedAnalysis();
          setAnalysisId("");
        }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [analysisId]);
  React.useEffect(() => {
    return () => {
      if (localMedia) URL.revokeObjectURL(localMedia);
    };
  }, [localMedia]);
  React.useEffect(() => {
    setTime(0);
    setPlayLength(0);
    setPlaying(false);
    setPlayerError(false);
  }, [playback]);
  React.useEffect(() => {
    if (!downloadUrl || downloaded.current === downloadUrl) return;
    downloaded.current = downloadUrl;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = (exportPayload?.clip.title || "SupoClip") + ".mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [downloadUrl, exportPayload]);
  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  async function run(
    which: PrepareTask,
    action: (signal: AbortSignal) => Promise<void>,
  ) {
    if (latest.current || exporting) return;
    const controller = new AbortController();
    latest.current = controller;
    setTask(which);
    setAlert("");
    try {
      await action(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setAlert(errText(e));
    } finally {
      if (latest.current === controller) {
        latest.current = null;
        setTask(null);
      }
    }
  }
  function received(
    s: Source,
    signature: string,
    file?: File,
    seed: Clip[] = [],
  ) {
    clearSavedAnalysis();
    setSource(s);
    sourceSignature.current = signature;
    setLocalMedia(file ? URL.createObjectURL(file) : "");
    setClips(seed);
    setChosen(seed[0]?.id ?? "");
    setSettingsById({});
    setEditing(seed.length > 0);
    setExportPayload(null);
    setManual(false);
    setDraggingFrame(false);
  }
  function resetSource() {
    clearSavedAnalysis();
    setSource(null);
    sourceSignature.current = "";
    setLocalMedia("");
    setClips([]);
    setChosen("");
    setEditing(false);
    setSettingsById({});
    setExportPayload(null);
    setAlert("");
  }
  function analyze(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) {
      setAlert("Paste a stream URL to analyze.");
      linkRef.current?.focus();
      return;
    }
    let link: URL;
    try {
      link = new URL(url.trim());
      if (!["https:", "http:"].includes(link.protocol)) throw new Error();
    } catch {
      setAlert("Use a complete YouTube, Twitch or Kick URL.");
      return;
    }
    if (source && sourceSignature.current === link.href) {
      setAlert("");
      return;
    }
    void run("analyze", async (signal) => {
      const result = await request<{ source: Source }>(
        "/api/analyze-url",
        post({ url: link.href }, signal),
      );
      if (!signal.aborted) received(result.source, link.href);
    });
  }
  function sendFile(file?: File) {
    if (!file || locked) return;
    if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
      setAlert("Choose an MP4, MOV, WebM or MKV video.");
      return;
    }
    const signature = ["file", file.name, file.size, file.lastModified].join(
      "|",
    );
    if (source && sourceSignature.current === signature) {
      setAlert("");
      return;
    }
    void run("upload", async (signal) => {
      const form = new FormData();
      form.append("video", file, file.name);
      if (!source && text.trim()) form.append("transcript", text.trim());
      const r = await request<{ source: Source }>("/api/upload", {
        method: "POST",
        body: form,
        signal,
      });
      if (!signal.aborted) {
        if (source) setText("");
        received(r.source, signature, file);
      }
    });
  }
  function demo() {
    void run("demo", async (signal) => {
      const r = await request<{ source: Source; clips: Clip[] }>("/api/demo", {
        method: "POST",
        signal,
      });
      if (!signal.aborted) {
        received(r.source, "demo", undefined, r.clips);
        setText("");
      }
    });
  }
  function generate() {
    if (!source) {
      setAlert(
        mode === "url"
          ? "Analyze a stream URL first."
          : "Upload a video first.",
      );
      if (mode === "url") linkRef.current?.focus();
      else upload.current?.click();
      return;
    }
    if (!key.trim()) {
      setAlert(
        "Enter your OpenRouter API key in the top bar to generate clips.",
      );
      keyRef.current?.focus();
      return;
    }
    void run("generate", async (signal) => {
      const options = post(
        {
          sourceId: source.id,
          model,
          ...(text.trim() ? { transcript: text.trim() } : {}),
        },
        signal,
      );
      const result = await request<{ jobId: string }>("/api/generate-clips", {
        ...options,
        headers: { "Content-Type": "application/json", Prefer: "respond-async", Authorization: "Bearer " + key.trim() },
      });
      if (signal.aborted) return;
      try { sessionStorage.setItem("supoclip.analysis", result.jobId); } catch {}
      setAnalysisStage("Queued for analysis");
      setAnalysisId(result.jobId);
    });
  }
  async function importText(file?: File) {
    if (!file) return;
    if (!/\.(srt|vtt|txt)$/i.test(file.name)) {
      setAlert("Choose an SRT, VTT or TXT transcript.");
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setAlert("Choose a transcript smaller than 3 MB.");
      return;
    }
    try {
      const value = (await file.text()).trim();
      if (!value) throw new Error("This transcript file is empty.");
      setText(value);
      setManual(true);
      setAlert("");
    } catch (e) {
      setAlert(errText(e));
    }
  }
  function setLook(s: Settings) {
    setSettingsById((prev) => ({ ...prev, [chosen]: s }));
    setExportPayload(null);
  }
  function choose(id: string) {
    setChosen(id);
    setExportPayload(null);
    setAlert("");
  }
  function switchMode(value: "url" | "upload") {
    if (mode === value) return;
    setMode(value);
    resetSource();
    setText("");
    setManual(false);
  }
  function setView(value: boolean) {
    setEditing(value);
    setAlert("");
    setExportPayload(null);
    video.current?.pause();
  }
  const sourceCaption = source
    ? Math.round(source.width) + " × " + Math.round(source.height)
    : "";
  const transcriptField = (
    <div className="transcript-entry">
      <div className="field-row">
        <label htmlFor="transcript">Video transcript</label>
        <button
          type="button"
          className="text-button"
          disabled={locked}
          onClick={() => subtitles.current?.click()}
        >
          <FileUp size={13} />
          Import subtitles
        </button>
      </div>
      <textarea
        className="transcript-input"
        id="transcript"
        disabled={locked}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Paste your transcript here…\nTimestamps are optional."}
      />
    </div>
  );

  return (
    <div className="supo">
      <header className="topbar">
        <div className="shell topinner">
          <div className="brand">
            <BrandMark />
            <span>SupoClip</span>
            <span className="lite">Lite</span>
          </div>
          <div className="connections">
            <label className="connection keyfield">
              <KeyRound size={15} />
              <span className="conn-label">OpenRouter key</span>
              <input
                ref={keyRef}
                aria-label="OpenRouter API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder="sk-or-…"
                onChange={(e) => {
                  setKey(e.target.value);
                  saveSetting("key", e.target.value);
                }}
              />
            </label>
            <label className="connection modelfield">
              <Layers2 size={15} />
              <span className="sr-only">OpenRouter model</span>
              <select
                className="model-select"
                value={model}
                title={model}
                disabled={!!task}
                onChange={(e) => {
                  setModel(e.target.value);
                  saveSetting("model", e.target.value);
                }}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="select-chevron" size={13} />
            </label>
          </div>
        </div>
      </header>
      <main className="shell main">
        <div className="intro">
          <div className="intro-copy">
            <h1>
              Clip studio<span className="title-point">.</span>
            </h1>
            <p>Turn long streams into captioned, vertical highlights.</p>
          </div>
          {editing ? (
            <button
              type="button"
              className="demo-button"
              disabled={locked}
              onClick={() => setView(false)}
            >
              <ArrowLeft size={15} />
              Source settings
            </button>
          ) : clips.length ? (
            <button
              type="button"
              className="demo-button"
              disabled={locked}
              onClick={() => setView(true)}
            >
              <Clapperboard size={16} />
              Return to clips
            </button>
          ) : (
            <button
              type="button"
              className="demo-button"
              disabled={locked}
              onClick={demo}
            >
              {task === "demo" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Clapperboard size={16} />
              )}
              Load sample demo
            </button>
          )}
        </div>
        {alert && (
          <div className="notice error" role="alert">
            <CircleAlert size={16} />
            <span>{alert}</span>
            <button
              className="icon-button"
              type="button"
              aria-label="Dismiss message"
              onClick={() => setAlert("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <input
          type="file"
          accept=".mp4,.mov,.m4v,.webm,.mkv"
          hidden
          ref={upload}
          aria-label="Local video file"
          onChange={(e) => {
            sendFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          type="file"
          accept=".srt,.vtt,.txt"
          hidden
          ref={subtitles}
          aria-label="Subtitle file"
          onChange={(e) => {
            void importText(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div className={"workspace" + (editing ? " editing" : "")}>
          <div className="left-stack">
            {editing && source && chosenClip ? (
              <>
                <section className="panel">
                  <Heading step="01" meta={clips.length + " clips"}>
                    Viral clips
                  </Heading>
                  <div className="clip-list">
                    {clips.map((c, i) => (
                      <button
                        type="button"
                        className={
                          "clip-card" + (chosen === c.id ? " selected" : "")
                        }
                        disabled={locked}
                        key={c.id}
                        aria-pressed={chosen === c.id}
                        onClick={() => choose(c.id)}
                      >
                        <span className="clip-top">
                          <span className="clip-index">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <strong className="clip-title">{c.title}</strong>
                          <span
                            className="score"
                            title="Estimated virality score"
                          >
                            <Zap size={11} />
                            {c.viralityScore}
                          </span>
                        </span>
                        <span className="clip-timing">
                          {clock(c.segments[0]?.start ?? 0)} ·{" "}
                          {durationOf(c).toFixed(1)}s <i /> {c.segments.length}{" "}
                          {c.segments.length === 1 ? "segment" : "segments"}
                        </span>
                        <span className="clip-reason">{c.reason}</span>
                      </button>
                    ))}
                  </div>
                </section>
                <fieldset className="edit-fields" disabled={locked}>
                  <FramingEditor
                    source={source}
                    settings={settings}
                    mediaUrl={sourceMedia}
                    onChange={setLook}
                    onDrag={setDraggingFrame}
                  />
                  <TrimEditor
                    clip={chosenClip}
                    duration={source.duration}
                    onChange={(c) => {
                      setClips((all) =>
                        all.map((v) => (v.id === c.id ? c : v)),
                      );
                      setExportPayload(null);
                    }}
                  />
                </fieldset>
              </>
            ) : (
              <>
                <section className="panel source-panel">
                  <Heading step="01">Video source</Heading>
                  <div className="panel-body">
                    <div
                      className="tabs"
                      role="group"
                      aria-label="Video source type"
                    >
                      {(["url", "upload"] as const).map((m) => (
                        <button
                          type="button"
                          className={"tab" + (mode === m ? " active" : "")}
                          aria-pressed={mode === m}
                          key={m}
                          disabled={locked}
                          onClick={() => switchMode(m)}
                        >
                          {m === "url" ? (
                            <Link2 size={15} />
                          ) : (
                            <Upload size={15} />
                          )}{" "}
                          {m === "url" ? "Stream URL" : "Local upload"}
                        </button>
                      ))}
                    </div>
                    {mode === "url" ? (
                      <form onSubmit={analyze}>
                        <div className="field-row">
                          <label htmlFor="stream-url">Stream or VOD link</label>
                        </div>
                        <div className="url-controls">
                          <span className="link-field">
                            <Link2 size={16} />
                            <input
                              id="stream-url"
                              ref={linkRef}
                              type="url"
                              autoComplete="off"
                              disabled={locked}
                              value={url}
                              placeholder="Paste YouTube / Twitch / Kick URL"
                              onChange={(e) => {
                                setUrl(e.target.value);
                                if (source) {
                                  resetSource();
                                  setText("");
                                  setManual(false);
                                }
                              }}
                            />
                          </span>
                          <button
                            className="analyze-btn"
                            disabled={locked}
                            type="submit"
                          >
                            {task === "analyze" ? (
                              <LoaderCircle size={15} className="spin" />
                            ) : source ? (
                              <Check size={15} />
                            ) : (
                              <Frame size={14} />
                            )}
                            {source
                              ? "Analyzed"
                              : task === "analyze"
                                ? "Analyzing…"
                                : "Analyze"}
                          </button>
                        </div>
                        <div className="platform-list">
                          <span>YouTube</span>
                          <i />
                          <span>Twitch</span>
                          <i />
                          <span>Kick</span>
                        </div>
                      </form>
                    ) : (
                      <button
                        type="button"
                        disabled={locked}
                        className={"dropzone" + (dragging ? " dragging" : "")}
                        onClick={() => upload.current?.click()}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragging(false);
                          sendFile(e.dataTransfer.files[0]);
                        }}
                      >
                        <span className="upload-icon">
                          {task === "upload" ? (
                            <LoaderCircle className="spin" size={20} />
                          ) : (
                            <Upload size={20} />
                          )}
                        </span>
                        <span className="drop-title">
                          {task === "upload" ? (
                            "Uploading video…"
                          ) : (
                            <>
                              Drop your video here, or{" "}
                              <span className="browse">browse</span>
                            </>
                          )}
                        </span>
                        <span className="drop-types">
                          MP4 · WEBM · MOV · MKV
                        </span>
                      </button>
                    )}
                    {source && (
                      <div className="source-result">
                        {source.thumbnail ? (
                          <img src={source.thumbnail} alt="" />
                        ) : (
                          <Film size={22} />
                        )}
                        <div>
                          <strong>{source.title}</strong>
                          <span>
                            {source.provider} · {clock(source.duration)} ·{" "}
                            {sourceCaption}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
                <section className="panel input-panel">
                  <Heading step="02">Clip generation</Heading>
                  <div className="panel-body">
                    <div className="captions-source">
                      <div className="caption-icon">
                        <Captions size={20} />
                      </div>
                      <div>
                        <strong>
                          {source?.cueCount
                            ? "Source captions ready"
                            : source
                              ? "Local audio transcription"
                              : "Source captions"}
                        </strong>
                        <span>
                          {source?.cueCount
                            ? source.cueCount +
                              " timed cues available for analysis."
                            : source
                              ? "Generate to transcribe the full recording on this worker, or import subtitles."
                              : "Available captions are imported with your source."}
                        </span>
                      </div>
                    </div>
                    {manual || text ? (
                      transcriptField
                    ) : (
                      <div className="manual-actions">
                        <button
                          type="button"
                          disabled={locked}
                          className="text-button"
                          onClick={() => setManual(true)}
                        >
                          <FileText size={13} />
                          Paste transcript
                        </button>
                        <button
                          type="button"
                          disabled={locked}
                          className="text-button"
                          onClick={() => subtitles.current?.click()}
                        >
                          <FileUp size={13} />
                          Import subtitles
                        </button>
                      </div>
                    )}
                    <button
                      className="generate"
                      type="button"
                      disabled={locked}
                      onClick={generate}
                    >
                      {task === "generate" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}
                      <span>
                        {task === "generate"
                          ? "Finding highlights…"
                          : "Generate viral clips"}
                      </span>
                      <ArrowRight size={15} />
                    </button>
                    {task && (
                      <div className="status" role="status">
                        <span>
                          {task === "generate"
                            ? analysisStage
                            : task === "analyze"
                              ? "Reading metadata and captions…"
                              : task === "upload"
                                ? "Sending video to the renderer…"
                                : "Loading the demo…"}
                        </span>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            if (analysisId) void request("/api/analysis-jobs/" + encodeURIComponent(analysisId), { method: "DELETE" })
                              .catch((error) => setAlert(errText(error)));
                            else latest.current?.abort();
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
          <div className="right-stack">
            <section className="panel preview-panel">
              <div className="panel-head preview-head">
                <Frame size={18} />
                <h2>Clip preview</h2>
                <span className="preview-tag">
                  <span className="aspect-icon" />
                  9:16
                </span>
              </div>
              <div
                className={"monitor-body" + (expanded ? " is-expanded" : "")}
                ref={monitor}
                role={expanded ? "dialog" : undefined}
                aria-label={expanded ? "Expanded clip preview" : undefined}
              >
                <div className="view-stage">
                  <span className="stage-tick tl" />
                  <span className="stage-tick tr" />
                  <span className="stage-tick bl" />
                  <span className="stage-tick br" />
                  <div className="portrait">
                    {source ? (
                      <>
                        <FramingPreview
                          source={source}
                          settings={settings}
                          clip={editing ? chosenClip : null}
                          mediaUrl={sourceMedia}
                        />
                        {playback && (
                          <video
                            key={playback}
                            ref={video}
                            className="rendered-preview"
                            style={{
                              visibility: playerError ? "hidden" : undefined,
                            }}
                            src={playback}
                            preload="auto"
                            playsInline
                            loop
                            muted={muted}
                            onLoadedMetadata={(e) => {
                              setPlayLength(e.currentTarget.duration);
                              setTime(0);
                            }}
                            onTimeUpdate={(e) =>
                              setTime(e.currentTarget.currentTime)
                            }
                            onPlay={() => setPlaying(true)}
                            onPause={() => setPlaying(false)}
                            onError={() => {
                              setPlaying(false);
                              setPlayerError(true);
                            }}
                          />
                        )}
                      </>
                    ) : (
                      <Standby />
                    )}
                  </div>
                </div>
                <div className="player-controls">
                  <button
                    type="button"
                    className="icon-button play-toggle"
                    disabled={!goodPlayback}
                    aria-label={playing ? "Pause preview" : "Play preview"}
                    onClick={() => {
                      const v = video.current;
                      if (!v) return;
                      if (v.paused)
                        void v
                          .play()
                          .catch(() =>
                            setAlert(
                              "Playback could not start. Try playing the preview again.",
                            ),
                          );
                      else v.pause();
                    }}
                  >
                    {playing ? (
                      <Pause size={15} fill="currentColor" />
                    ) : (
                      <Play size={15} fill="currentColor" />
                    )}
                  </button>
                  <span className="timecode">
                    {clock(time)}
                    <span> / {clock(length)}</span>
                  </span>
                  <input
                    type="range"
                    className="trackbar"
                    aria-label="Preview position"
                    min={0}
                    max={length || 1}
                    step={0.05}
                    value={time}
                    disabled={!goodPlayback}
                    onChange={(e) => {
                      if (video.current) {
                        video.current.currentTime = Number(e.target.value);
                        setTime(video.current.currentTime);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    disabled={!goodPlayback}
                    aria-label={muted ? "Unmute preview" : "Mute preview"}
                    onClick={() => setMuted((m) => !m)}
                  >
                    {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={
                      expanded ? "Close expanded preview" : "Expand preview"
                    }
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? <X size={15} /> : <Maximize size={15} />}
                  </button>
                </div>
              </div>
              <div className="format-row">
                <span>
                  <Monitor size={13} />
                  Output 1080 × 1920
                </span>
                <i />
                <span>MP4</span>
                <span className="local-render">
                  <span className="status-dot" />
                  {editing
                    ? settings.mode === "split"
                      ? "Streamer split"
                      : settings.mode === "speaker" ? "Follow speaker" : "Smart crop"
                    : "Preview monitor"}
                </span>
              </div>
              {editing && (
                <div className="export-area">
                  {preview &&
                    (preview.status === "running" ||
                      preview.status === "queued") && (
                      <Progress job={preview} label="Preview" />
                    )}
                  {(preview?.status === "failed" || playerError) && (
                    <div className="job-error" role="alert">
                      {preview?.error || "This preview could not be played."}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setPreviewRevision((n) => n + 1)}
                      >
                        <RefreshCcw size={12} />
                        Retry preview
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="generate download"
                    disabled={locked || !payload}
                    onClick={() => {
                      downloaded.current = "";
                      setExportPayload(payload);
                      setExportRevision((n) => n + 1);
                      setAlert("");
                    }}
                  >
                    {exporting ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Download size={16} />
                    )}
                    <span>
                      {exporting ? "Rendering clip…" : "Download 9:16 clip"}
                    </span>
                    <ArrowRight size={15} />
                  </button>
                  {exporting && output && (
                    <>
                      <Progress job={output} label="Export" />
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setExportPayload(null)}
                      >
                        Cancel export
                      </button>
                    </>
                  )}
                  {output?.status === "failed" && (
                    <p className="job-error" role="alert">
                      {output.error || "Export failed. Try again."}
                    </p>
                  )}
                  {downloadUrl && (
                    <div className="status" role="status">
                      <Check size={13} />
                      Your MP4 is ready.
                      <a href={downloadUrl} download>
                        Save file
                      </a>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
        <footer className="footnote">
          <span>
            <ShieldCheck size={13} />
            Private workspace
          </span>
          <span className="engine-credit">
            <span className="router-symbol">⑂</span> Powered by OpenRouter
          </span>
        </footer>
      </main>
    </div>
  );
}
