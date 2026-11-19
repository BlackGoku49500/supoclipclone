import path from "node:path";
import { type Cue } from "../lib/types";
import { HttpError, readJson, worker, writeJson } from "./runtime";
import { diskAvailable, mediaPath, sourceDir, type StoredSource } from "./storage";

export async function transcribeSource(owner: string, source: StoredSource, signal: AbortSignal) {
  const dir = sourceDir(owner, source.info.id);
  await diskAvailable(40 * 1024 * 1024);
  const input = source.remoteUrl ? ["--url", source.remoteUrl] : ["--input", mediaPath(owner, source)];
  await worker("transcribe", [...input, "--duration", String(source.info.duration), "--dir", path.join(dir, "asr")],
    signal, Math.min(48 * 3600000, Math.max(600000, source.info.duration * 6000)));
  const cues = await readJson<Cue[]>(path.join(dir, "asr", "transcript.json"));
  if (!cues.length) throw new HttpError(422, "No speech was detected in the recording. You can import a transcript.");
  source.cues = cues;
  source.info = { ...source.info, cueCount: cues.length };
  await writeJson(path.join(dir, "source.json"), source);
  return cues;
}
