import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const LONG_URL = "https://www.youtube.com/live/LiteLong001";
export const LONG_ID = "LiteLong001";
export const LONG_DURATION = 7200;

export async function makeLongRecording(dir) {
  // Actual two-hour MP4 with spoken passages at 0, 3600 and 7140 seconds.
  const speech = "We never expected to find this treasure under the old castle. My brother said the door was locked forever. " +
    "Then we noticed something strange about the shape of the silver key. I picked it up and turned it slowly to the left. " +
    "You could hear the whole room go quiet. For just a second the only sound was the clock above the door. " +
    "When the door finally opened there was a second room full of paintings. That is how we found the missing picture.";
  const filter = "[0:a]aresample=16000,asplit=3[a][b][c];" +
    "[a]apad,atrim=duration=3600[x];[b]apad,atrim=duration=3540[y];[c]apad,atrim=duration=60[z];" +
    "[x][y][z]concat=n=3:v=0:a=1[recording]";
  const options = { cwd: dir, timeout: 180000 };
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "flite=voice=slt:text='" + speech + "'",
    "-filter_complex", filter, "-map", "[recording]", "-c:a", "aac", "-b:a", "32k",
    "-movflags", "+faststart", "long-audio.m4a"], options);
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=2",
    "-i", "long-audio.m4a", "-t", String(LONG_DURATION), "-map", "0:v", "-map", "1:a", "-c:v", "libx264",
    "-threads", "1", "-preset", "ultrafast", "-g", "4", "-c:a", "copy", "-movflags", "+faststart", "long-video.mp4"], options);
}

export function longMetadata(origin) {
  return {id: LONG_ID, title: "Two hour captionless archive", extractor: "youtube", extractor_key: "Youtube",
    duration: LONG_DURATION, live_status: "was_live", formats: [
      { format_id: "audio", ext: "m4a", protocol: "https", acodec: "aac", vcodec: "none", abr: 32, url: origin + "/long-audio.m4a" },
      { format_id: "video", ext: "mp4", protocol: "https", acodec: "aac", vcodec: "h264", width: 160, height: 90, url: origin + "/long-video.mp4" },
    ]};
}

export async function sendRange(req, res, file, reads) {
  const { size } = await stat(file);
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  const first = match ? Number(match[1]) : 0;
  const last = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  reads.push({ file: path.basename(file), first, last });
  if (first > last) { res.writeHead(416).end(); return; }
  res.writeHead(match ? 206 : 200, { "Accept-Ranges": "bytes", "Content-Length": last-first+1,
    ...(match ? { "Content-Range": `bytes ${first}-${last}/${size}` } : {}) });
  if (req.method === "HEAD") { res.end(); return; }
  const stream = createReadStream(file, { start: first, end: last });
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
