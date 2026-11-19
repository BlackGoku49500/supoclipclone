import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Clip, JobState, Segment, Settings } from "../lib/types";
import {
  checkId,
  HttpError,
  readJson,
  uniqueId,
  worker,
  writeJson,
} from "./runtime";
import {
  diskAvailable,
  getClips,
  getSource,
  jobDir,
  mediaPath,
  sourceDir,
  touchSession,
  type StoredSource,
} from "./storage";

type Task = {
  id: string;
  owner: string;
  source: StoredSource;
  clip: Clip;
  settings: Settings;
  preview: boolean;
  controller: AbortController;
  state: JobState;
  created: number;
};
type Scheduler = { jobs: Map<string, Task>; queue: Task[]; running: boolean };
const host = globalThis as typeof globalThis & { supoScheduler?: Scheduler };
const scheduler: Scheduler = (host.supoScheduler ??= {
  jobs: new Map(),
  queue: [],
  running: false,
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Invalid edit settings.");
  return value as Record<string, unknown>;
}
function bounded(n: unknown, min: number, max: number) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    throw new HttpError(400, "Framing or trim values fall outside the video.");
  return n;
}
function readSettings(raw: unknown): Settings {
  const s = object(raw),
    box = object(s.facecam);
  if (
    (s.mode !== "smart" && s.mode !== "split" && s.mode !== "speaker") ||
    !["neon", "yellow", "white", "box"].includes(String(s.captionStyle)) ||
    typeof s.hook !== "boolean"
  )
    throw new HttpError(400, "Select a supported edit mode and caption style.");
  const x = bounded(box.x, 0, 1),
    y = bounded(box.y, 0, 1),
    w = bounded(box.w, 0.005, 1),
    h = bounded(box.h, 0.005, 1);
  if (x + w > 1.000001 || y + h > 1.000001)
    throw new HttpError(400, "Keep the facecam box inside the frame.");
  return {
    mode: s.mode,
    facecam: { x, y, w, h },
    pan: bounded(s.pan, 0, 1),
    captionStyle: s.captionStyle as Settings["captionStyle"],
    hook: s.hook,
  };
}
function editedClip(raw: unknown, originals: Clip[], duration: number): Clip {
  const asked = object(raw),
    clip = originals.find((c) => c.id === asked.id);
  if (!clip)
    throw new HttpError(400, "Select a generated clip from this source.");
  if (
    !Array.isArray(asked.segments) ||
    !asked.segments.length ||
    asked.segments.length > 120
  )
    throw new HttpError(400, "Select at least one valid edit segment.");
  const segments: Segment[] = [];
  let length = 0;
  for (const item of asked.segments) {
    const entry = object(item);
    const start = bounded(entry.start, 0, duration),
      end = bounded(entry.end, 0, duration);
    if (
      end - start < 1 / 30 ||
      (segments.length && start < segments[segments.length - 1].end)
    )
      throw new HttpError(
        400,
        "Segments must be in order and have a positive duration.",
      );
    segments.push({ start, end });
    length += end - start;
  }
  if (
    length < 0.5 ||
    length > 60.00001 ||
    segments.at(-1)!.end - segments[0].start > 120.00001
  )
    throw new HttpError(
      400,
      "Keep 0.5–60 seconds within a two-minute passage.",
    );
  return { ...clip, segments };
}
function finishedPath(owner: string, id: string) {
  return path.join(jobDir(owner, id), "finished.json");
}
export function resultPath(owner: string, id: string) {
  return path.join(jobDir(owner, id), "output.mp4");
}
async function execute(t: Task) {
  const { source, owner, id, clip, settings, preview } = t,
    signal = t.controller.signal;
  const dir = jobDir(owner, id),
    request = path.join(dir, "request.json");
  try {
    signal.throwIfAborted();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await diskAvailable(192 * 1024 * 1024);
    t.state = { status: "running", stage: "Preparing edit", progress: 5 };
    const inputs = [];
    for (const [index, seg] of clip.segments.entries()) {
      signal.throwIfAborted();
      if (source.remoteUrl) {
        t.state.stage = `Fetching section ${index + 1} of ${clip.segments.length}`;
        t.state.progress = 8 + Math.floor((45 * index) / clip.segments.length);
        const hash = createHash("sha256")
          .update(seg.start + "/" + seg.end)
          .digest("hex");
        const slice = path.join(
          sourceDir(owner, source.info.id),
          "sections",
          hash + ".mp4",
        );
        if (!(await stat(slice).catch(() => null))?.isFile()) {
          await worker(
            "ingest",
            [
              "section",
              "--url",
              source.remoteUrl,
              "--start",
              String(seg.start),
              "--end",
              String(seg.end),
              "--out",
              slice,
            ],
            signal,
            420000,
          );
        }
        inputs.push({ path: slice, start: 0, end: seg.end - seg.start });
      } else
        inputs.push({
          path: mediaPath(owner, source),
          start: seg.start,
          end: seg.end,
        });
    }
    t.state = {
      status: "running",
      stage: preview ? "Encoding preview" : "Burning captions and encoding MP4",
      progress: 60,
    };
    await writeJson(request, { inputs, clip, settings, preview });
    await worker(
      "render",
      ["--request", request, "--output", resultPath(owner, id)],
      signal,
      960000,
    );
    signal.throwIfAborted();
    const done: JobState = {
      status: "done",
      stage: "Ready",
      progress: 100,
      url: "/api/media/" + id,
    };
    await writeJson(finishedPath(owner, id), {
      state: done,
      title: clip.title,
    });
    t.state = done;
  } catch (e) {
    t.state = {
      status: "failed",
      stage: signal.aborted ? "Cancelled" : "Failed",
      progress: 0,
      error: signal.aborted
        ? "Render cancelled."
        : e instanceof HttpError
          ? e.message
          : "The encoder could not finish this clip.",
    };
    await rm(resultPath(owner, id), { force: true }).catch(() => {});
    await writeJson(finishedPath(owner, id), {
      state: t.state,
      title: clip.title,
    }).catch(() => {});
  } finally {
    scheduler.jobs.delete(id);
    await rm(request, { force: true }).catch(() => {});
  }
}
async function drain() {
  if (scheduler.running) return;
  scheduler.running = true;
  try {
    let task;
    while ((task = scheduler.queue.shift())) await execute(task);
  } finally {
    scheduler.running = false;
  }
}
export async function enqueue(
  owner: string,
  body: Record<string, unknown>,
  preview: boolean,
) {
  await touchSession(owner);
  const source = await getSource(owner, body.sourceId);
  const clip = editedClip(
    body.clip,
    await getClips(owner, source.info.id),
    source.info.duration,
  );
  const settings = readSettings(body.settings);
  const pending = [...scheduler.jobs.values()].filter(
    (t) => t.state.status === "running" || t.state.status === "queued",
  );
  if (
    pending.length >= 12 ||
    pending.filter((t) => t.owner === owner).length >= 3
  )
    throw new HttpError(
      429,
      "The render queue is full. Wait for the current edit to finish.",
    );
  const t: Task = {
    id: uniqueId(),
    owner,
    source,
    clip,
    settings,
    preview,
    controller: new AbortController(),
    state: { status: "queued", stage: "Queued", progress: 0 },
    created: Date.now(),
  };
  scheduler.jobs.set(t.id, t);
  scheduler.queue.push(t);
  void drain();
  return { jobId: t.id };
}
export async function readJob(owner: string, id: string) {
  checkId(id);
  const t = scheduler.jobs.get(id);
  if (t && t.owner === owner) return t.state;
  return (await readJson<{ state: JobState }>(finishedPath(owner, id))).state;
}
export async function cancel(owner: string, id: string) {
  const state = await readJob(owner, id);
  if (state.status === "queued" || state.status === "running") {
    const t = scheduler.jobs.get(id);
    if (t?.owner === owner) t.controller.abort();
  }
}
export async function readyFile(owner: string, id: string) {
  return readJson<{ title: string }>(finishedPath(owner, checkId(id)));
}
