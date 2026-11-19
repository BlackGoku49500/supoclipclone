import path from "node:path";
import type { Clip, JobState, Source } from "../lib/types";
import { parseTranscript } from "../lib/transcript";
import { generateClips } from "./brain";
import { transcribeSource } from "./listen";
import { checkId, HttpError, readJson, uniqueId, writeJson } from "./runtime";
import { jobDir, saveClips, sourceDir, touchSession, type StoredSource } from "./storage";

type AnalysisState = JobState & { source: Source; clips?: Clip[] };
type Parameters = { owner: string; source: StoredSource; key: string; model: string; referer: string; transcript?: string };
type Update = (stage: string, progress: number) => void;
type Task = { id: string; args: Parameters; state: AnalysisState; controller: AbortController };
type Pool = { active: Map<string, Task>; queue: Task[]; busy: boolean };
const host = globalThis as typeof globalThis & { supoAnalysis?: Pool };
const pool: Pool = host.supoAnalysis ??= { active: new Map(), queue: [], busy: false };
const statePath = (owner: string, id: string) => path.join(jobDir(owner, id), "analysis.json");

async function compute(args: Parameters, signal: AbortSignal, update: Update) {
  const { owner, source, key, model, referer, transcript } = args;
  let cues = source.cues;
  if (transcript?.trim()) {
    cues = parseTranscript(transcript, source.info.duration);
    if (!cues.length) throw new HttpError(422, "The transcript has no cues inside this recording.");
  }
  if (!cues.length) {
    update("Transcribing audio", 1);
    cues = await transcribeSource(owner, source, signal);
  }
  signal.throwIfAborted();
  const clips = await generateClips({ cues, duration: source.info.duration, key, model, referer, signal,
    cacheDir: path.join(sourceDir(owner, source.info.id), "hook-windows"),
    progress(done, total, fallback) {
      update(`Finding hooks · ${done}/${total} passages${fallback ? " · OpenRouter free fallback" : ""}`,
        70 + Math.floor(29 * done / total));
    },
  });
  await saveClips(owner, source.info.id, clips);
  return clips;
}

async function drain() {
  if (pool.busy) return;
  pool.busy = true;
  try {
    let task;
    while ((task = pool.queue.shift())) {
      const { owner, source } = task.args;
      try {
        task.controller.signal.throwIfAborted();
        task.state.status = "running";
        const current = task;
        const clips = await compute(task.args, task.controller.signal, (stage, progress) => {
          Object.assign(current.state, { stage, progress });
        });
        task.state = { source: source.info, clips, status: "done", stage: "Highlights ready", progress: 100 };
      } catch (error) {
        const message = task.controller.signal.aborted ? "Analysis cancelled." :
          error instanceof Error ? error.message : "Could not analyze this recording.";
        task.state = { source: source.info, status: "failed", stage: "Analysis stopped", progress: task.state.progress, error: message };
      }
      try {
        await writeJson(statePath(owner, task.id), task.state);
      } finally {
        pool.active.delete(task.id);
      }
    }
  } finally {
    pool.busy = false;
    if (pool.queue.length) void drain().catch(() => {});
  }
}

export async function startAnalysis(args: Parameters) {
  if (pool.active.size >= 8 || [...pool.active.values()].some(t => t.args.owner === args.owner))
    throw new HttpError(429, "An analysis is already in progress. Wait for it to finish and retry.");
  const id = uniqueId();
  const state: AnalysisState = { source: args.source.info, status: "queued", stage: "Queued for analysis", progress: 0 };
  const task = { id, args, state, controller: new AbortController() };
  pool.active.set(id, task);
  try {
    await touchSession(args.owner);
    await writeJson(statePath(args.owner, id), state);
  } catch (error) {
    pool.active.delete(id);
    throw error;
  }
  pool.queue.push(task);
  void drain().catch(() => {});
  return { jobId: id };
}

export async function analysisState(owner: string, id: string, cancel = false): Promise<AnalysisState> {
  checkId(id);
  const task = pool.active.get(id);
  if (task?.args.owner === owner) {
    if (cancel) task.controller.abort();
    const state = { ...task.state };
    if (state.stage === "Transcribing audio") {
      const progress = await readJson<{ seconds: number; duration: number }>(
        path.join(sourceDir(owner, state.source.id), "asr", "progress.json")).catch(() => null);
      if (progress) {
        state.stage += ` · ${Math.floor(progress.seconds / 60)} / ${Math.ceil(progress.duration / 60)} min`;
        state.progress = Math.max(1, Math.round(69 * progress.seconds / progress.duration));
      }
    }
    return state;
  }
  const state = await readJson<AnalysisState>(statePath(owner, id));
  if (state.status === "queued" || state.status === "running") {
    return { ...state, status: "failed", stage: "Worker restarted", error: "The worker restarted. Generate again to resume from the saved audio chunks." };
  }
  return state;
}
