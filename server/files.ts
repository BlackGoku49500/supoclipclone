import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { HttpError } from "./runtime";

export async function sendFile(
  req: NextRequest,
  filename: string,
  type: string,
  title?: string,
) {
  const f = await stat(filename).catch(() => null);
  if (!f?.isFile())
    throw new HttpError(404, "This media is unavailable or has expired.");
  const headers = new Headers({
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": String(f.size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (title && req.nextUrl.searchParams.get("download") === "1") {
    const safe =
      title.replace(/[^\p{L}\p{N} _.()-]/gu, "").slice(0, 96) || "SupoClip";
    headers.set(
      "Content-Disposition",
      "attachment; filename=\"SupoClip.mp4\"; filename*=UTF-8''" +
        encodeURIComponent(safe + ".mp4").replace(
          /['()]/g,
          (ch) => "%" + ch.charCodeAt(0).toString(16),
        ),
    );
  }
  let start = 0,
    end = f.size - 1;
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : Math.max(0, f.size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(f.size - 1, Number(m[2])) : f.size - 1;
    }
    if (
      !m ||
      (!m[1] && !m[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= f.size
    ) {
      headers.set("Content-Range", "bytes */" + f.size);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${f.size}`);
    headers.set("Content-Length", String(end - start + 1));
  }
  const body =
    req.method === "HEAD"
      ? null
      : (Readable.toWeb(
          createReadStream(filename, { start, end }),
        ) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}
