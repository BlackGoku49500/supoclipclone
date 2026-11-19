import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { NextRequest } from "next/server";
import type { Cue, Clip, Source } from "../lib/types";
import { DEFAULT_CLIP_MODEL } from "./brain";
import { guard, json, response, session } from "./http";
import { demoRoot, HttpError, readJson, worker } from "./runtime";
import {
  createSource,
  getSource,
  saveClips,
  sourceDir,
} from "./storage";
import { receiveUpload } from "./upload";
import { cancel, enqueue, readJob, readyFile, resultPath } from "./jobs";
import { sendFile } from "./files";
import { analysisState, startAnalysis } from "./analysis";

export const analyze = (req: NextRequest) =>
  guard(req, async () => {
    const s = session(req, true),
      body = await json(req, 16000);
    if (typeof body.url !== "string" || body.url.length > 8192)
      throw new HttpError(400, "Enter a YouTube, Twitch or Kick VOD URL.");
    const url = body.url;
    let transcript: Cue[] = [];
    const source = await createSource(s.owner, async (id, dir) => {
      type Metadata = Omit<Source, "id" | "cueCount"> & {
        url: string;
        cues: Cue[];
      };
      const m: Metadata = JSON.parse(
        await worker(
          "ingest",
          ["analyze", "--url", url, "--dir", dir],
          req.signal,
          180000,
        ),
      );
      transcript = m.cues;
      return {
        info: {
          id,
          title: m.title,
          duration: m.duration,
          width: m.width,
          height: m.height,
          provider: m.provider,
          thumbnail: m.thumbnail || null,
          cueCount: m.cues.length,
        },
        remoteUrl: m.url,
        cues: m.cues,
      };
    });
    return response(req, { source, transcript }, s);
  });
export const upload = (req: NextRequest) =>
  guard(req, async () => {
    const s = session(req, true);
    const source = await createSource(s.owner, (id, dir) =>
      receiveUpload(req, id, dir),
    );
    return response(req, { source }, s, 201);
  });
export const demo = (req: NextRequest) =>
  guard(req, async () => {
    const s = session(req, true);
    const data = await readJson<{ clips: Clip[]; cues: Cue[] }>(
      path.join(demoRoot, "study.json"),
    );
    const source = await createSource(s.owner, async (id) => {
      await saveClips(s.owner, id, data.clips);
      return {
        info: {
          id,
          title: "The Art of the Cut",
          duration: 72,
          width: 768,
          height: 432,
          thumbnail: "/demo/study.jpg",
          provider: "Demo",
          cueCount: data.cues.length,
        },
        cues: data.cues,
      };
    });
    return response(req, { source, clips: data.clips }, s, 201);
  });
export const generate = (req: NextRequest) =>
  guard(req, async () => {
    const s = session(req),
      body = await json(req);
    const key = req.headers
      .get("authorization")
      ?.match(/^Bearer (\S{1,1024})$/i)?.[1];
    if (!key)
      throw new HttpError(
        401,
        "Enter your OpenRouter API key to generate clips.",
      );
    const src = await getSource(s.owner, body.sourceId);
    const model =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : DEFAULT_CLIP_MODEL;
    if (!/^[a-zA-Z0-9_:.\/-]{1,180}$/.test(model))
      throw new HttpError(400, "Choose a valid OpenRouter model.");
    const task = await startAnalysis({
      owner: s.owner, source: src, key, model, referer: req.nextUrl.origin,
      transcript: typeof body.transcript === "string" ? body.transcript : undefined,
    });
    if (req.headers.get("prefer")?.includes("respond-async"))
      return response(req, task, undefined, 202);
    // Existing API clients can still request the finished clips in one response.
    try {
      for (;;) {
        req.signal.throwIfAborted();
        const state = await analysisState(s.owner, task.jobId);
        if (state.status === "done") return response(req, { clips: state.clips });
        if (state.status === "failed") throw new HttpError(422, state.error || "Analysis failed.");
        await delay(250, undefined, { signal: req.signal });
      }
    } finally {
      if (req.signal.aborted) await analysisState(s.owner, task.jobId, true);
    }
  });
export function analysisJob(req: NextRequest, ctx: ItemContext) {
  return guard(req, async () => {
    const { id } = await ctx.params;
    return response(req, await analysisState(session(req).owner, id, req.method === "DELETE"));
  });
}
export function render(req: NextRequest, preview: boolean) {
  return guard(req, async () =>
    response(
      req,
      await enqueue(session(req).owner, await json(req), preview),
      undefined,
      202,
    ),
  );
}
export type ItemContext = { params: Promise<{ id: string }> };
export function job(req: NextRequest, ctx: ItemContext) {
  return guard(req, async () => {
    const owner = session(req).owner,
      { id } = await ctx.params;
    if (req.method === "DELETE") await cancel(owner, id);
    return response(req, await readJob(owner, id));
  });
}
export function media(req: NextRequest, ctx: ItemContext) {
  return guard(req, async () => {
    const owner = session(req).owner,
      { id } = await ctx.params;
    const f = await readyFile(owner, id);
    return sendFile(req, resultPath(owner, id), "video/mp4", f.title);
  });
}
export function thumbnail(req: NextRequest, ctx: ItemContext) {
  return guard(req, async () => {
    const owner = session(req).owner,
      { id } = await ctx.params;
    await getSource(owner, id);
    return sendFile(
      req,
      path.join(sourceDir(owner, id), "thumbnail.jpg"),
      "image/jpeg",
    );
  });
}
