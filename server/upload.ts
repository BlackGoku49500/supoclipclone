import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import path from "node:path";
import type { NextRequest } from "next/server";
import { parseTranscript } from "../lib/transcript";
import { diskAvailable, type StoredSource } from "./storage";
import { HttpError, run } from "./runtime";

const maxVideo = 512 * 1024 * 1024;
const maxText = 4 * 1024 * 1024;

export async function receiveUpload(
  req: NextRequest,
  id: string,
  dir: string,
): Promise<StoredSource> {
  const size = Number(req.headers.get("content-length")) || 0;
  const maxBody = maxVideo + maxText + 65536;
  if (size > maxBody)
    throw new HttpError(413, "Choose a video smaller than 512 MiB.");
  if (
    !req.body ||
    !req.headers.get("content-type")?.startsWith("multipart/form-data")
  )
    throw new HttpError(415, "Upload a video using multipart form data.");
  await diskAvailable(size || maxVideo);
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: Object.fromEntries(req.headers),
      limits: {
        files: 1,
        fields: 1,
        parts: 3,
        fileSize: maxVideo,
        fieldSize: maxText,
      },
    });
  } catch {
    throw new HttpError(400, "Invalid file upload.");
  }
  let name = "",
    text = "",
    total = 0;
  let issue: Error | undefined;
  const tasks: Promise<void>[] = [];
  const filename = path.join(dir, "input.video");
  parser.on("file", (field, stream, file) => {
    if (
      field !== "video" ||
      !file.filename ||
      !/\.(mp4|webm|mov|m4v|mkv)$/i.test(file.filename)
    ) {
      issue = new HttpError(415, "Choose an MP4, MOV, WebM or MKV video.");
      stream.resume();
      return;
    }
    name = path.basename(file.filename).slice(0, 240);
    stream.on("limit", () => {
      issue = new HttpError(413, "Choose a video smaller than 512 MiB.");
    });
    tasks.push(
      pipeline(
        stream,
        createWriteStream(filename, { flags: "wx", mode: 0o600 }),
        { signal: req.signal },
      ).catch(() => {
        issue = new HttpError(400, "The upload was interrupted.");
      }),
    );
  });
  parser.on("field", (field, value, info) => {
    if (field === "transcript") text = value;
    if (info.valueTruncated)
      issue = new HttpError(413, "The transcript exceeds 4 MiB.");
  });
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
    parser.on(event, () => {
      issue = new HttpError(400, "Send one video and an optional transcript.");
    });
  const limiter = new Transform({
    transform(chunk, _, cb) {
      total += chunk.length;
      cb(
        total > maxBody
          ? new HttpError(413, "Upload exceeds the request limit.")
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(req.body as unknown as NodeReadableStream),
      limiter,
      parser,
      { signal: req.signal },
    );
  } catch (e) {
    throw e instanceof HttpError
      ? e
      : new HttpError(400, "Invalid or incomplete upload.");
  } finally {
    await Promise.all(tasks);
  }
  if (issue) throw issue;
  if (!name) throw new HttpError(400, "Choose a video to upload.");
  const opts = [
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,matroska,webm",
  ];
  const data = JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        ...opts,
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        filename,
      ],
      { signal: req.signal, timeout: 40000 },
    ),
  );
  const duration = Number(data.format?.duration),
    video = data.streams?.[0];
  if (!(
    duration > 0 &&
    Number.isFinite(duration) &&
    video?.width > 0 &&
    video?.height > 0
  ))
    throw new HttpError(
      422,
      "This upload needs a readable video stream and a known duration.",
    );
  await run(
    "ffmpeg",
    [
      "-nostdin",
      "-loglevel",
      "error",
      ...opts,
      "-i",
      filename,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(iw,960)':-2",
      "-threads",
      "1",
      "-y",
      path.join(dir, "thumbnail.jpg"),
    ],
    { signal: req.signal, timeout: 50000 },
  );
  const cues = parseTranscript(text, duration);
  return {
    info: {
      id,
      title: name,
      width: video.width,
      height: video.height,
      duration,
      provider: "Local",
      thumbnail: "/api/thumbnail/" + id,
      cueCount: cues.length,
    },
    cues,
  };
}
