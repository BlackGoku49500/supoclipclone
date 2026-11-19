import { mkdir, readdir, rm, stat, statfs, utimes } from "node:fs/promises";
import path from "node:path";
import type { Source, Cue, Clip } from "../lib/types";
import {
  checkId,
  dataRoot,
  demoRoot,
  HttpError,
  readJson,
  ttlMs,
  uniqueId,
  writeJson,
} from "./runtime";

export interface StoredSource {
  info: Source;
  remoteUrl?: string;
  cues: Cue[];
}
type Pool = { operations: Set<string>; lastSweep: number };
const runtime = globalThis as typeof globalThis & { supoPool?: Pool };
const pool = (runtime.supoPool ??= { operations: new Set(), lastSweep: 0 });
const base = path.join(dataRoot, "sessions");
export function sessionDir(owner: string) {
  return path.join(base, owner);
}
export function sourceDir(owner: string, id: string) {
  return path.join(sessionDir(owner), "sources", checkId(id));
}
export function jobDir(owner: string, id: string) {
  return path.join(sessionDir(owner), "jobs", checkId(id));
}
export function mediaPath(owner: string, s: StoredSource) {
  return s.info.provider === "Demo"
    ? path.join(demoRoot, "study.mp4")
    : path.join(sourceDir(owner, s.info.id), "input.video");
}
export function getSource(owner: string, id: unknown) {
  return readJson<StoredSource>(
    path.join(sourceDir(owner, checkId(id)), "source.json"),
  );
}
export function getClips(owner: string, id: string) {
  return readJson<Clip[]>(path.join(sourceDir(owner, id), "clips.json"));
}
export function saveClips(owner: string, id: string, clips: Clip[]) {
  return writeJson(path.join(sourceDir(owner, id), "clips.json"), clips);
}
async function sweep() {
  for (const e of await readdir(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^[a-f0-9]{64}$/.test(e.name)) continue;
    const dir = sessionDir(e.name);
    const info = await stat(dir).catch(() => null);
    if (info && Date.now() - info.mtimeMs > ttlMs)
      await rm(dir, { recursive: true, force: true });
  }
}
export async function touchSession(owner: string) {
  const dir = sessionDir(owner);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  await utimes(dir, now, now);
  if (Date.now() - pool.lastSweep > 3600000) {
    pool.lastSweep = Date.now();
    void sweep().catch(() => {
      /* A later sweep can retry if storage is temporarily busy. */
    });
  }
}
export async function diskAvailable(minBytes: number) {
  const info = await statfs(dataRoot);
  if (info.bavail * info.bsize < minBytes + 96 * 1024 * 1024)
    throw new HttpError(
      507,
      "The worker is low on disk space. Free storage or try again later.",
    );
}
export async function operation<T>(
  owner: string,
  kind: string,
  fn: () => Promise<T>,
) {
  const slot = owner + "/" + kind;
  if (pool.operations.has(slot) || pool.operations.size >= 6)
    throw new HttpError(
      429,
      "The studio is busy. Retry when the current task finishes.",
    );
  pool.operations.add(slot);
  try {
    await touchSession(owner);
    return await fn();
  } finally {
    pool.operations.delete(slot);
  }
}
export async function createSource(
  owner: string,
  write: (id: string, dir: string) => Promise<StoredSource>,
) {
  return operation(owner, "source", async () => {
    const id = uniqueId(),
      dir = sourceDir(owner, id);
    await diskAvailable(4 * 1024 * 1024);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const s = await write(id, dir);
      await writeJson(path.join(dir, "source.json"), s);
      return s.info;
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  });
}
