// A recorded platform metadata response plus a real, seekable HTTPS HLS server.
import { LONG_ID, longMetadata, sendRange } from "./long-recording.mjs";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function recordingFixture(dir, video, transcript) {
  const options = { cwd: dir, timeout: 60000 };
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "test.key",
      "-out",
      "test.crt",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    options,
  );
  await run(
    "ffmpeg",
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      video,
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      "part%03d.ts",
      "index.m3u8",
    ],
    options,
  );
  await writeFile(path.join(dir, "captions.srt"), transcript);
  const requests = [], ranges = [];
  const server = createServer(
    {
      key: await readFile(path.join(dir, "test.key")),
      cert: await readFile(path.join(dir, "test.crt")),
    },
    async (req, res) => {
      const filename = (req.url || "").slice(1);
      if (["long-audio.m4a", "long-video.mp4"].includes(filename)) {
        try { await sendRange(req, res, path.join(dir, filename), ranges); }
        catch { res.writeHead(404).end(); }
        return;
      }
      if (!/^(?:part\d+\.ts|index\.m3u8|captions\.srt)$/.test(filename)) {
        res.writeHead(404).end();
        return;
      }
      try {
        requests.push(filename);
        const bytes = await readFile(path.join(dir, filename));
        res.writeHead(200, { "Content-Length": bytes.length }).end(bytes);
      } catch {
        res.writeHead(404).end();
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "https://127.0.0.1:" + server.address().port;
  const info = path.join(dir, "fixture.info.json");
  const longInfo = path.join(dir, "long.info.json");
  await writeFile(longInfo, JSON.stringify(longMetadata(origin)));
  await writeFile(
    info,
    JSON.stringify({
      id: "aqz-KE-bpKQ",
      extractor: "youtube",
      extractor_key: "Youtube",
      title: "Fixture VOD",
      duration: 102,
      width: 320,
      height: 180,
      formats: [
        {
          format_id: "test",
          vcodec: "h264",
          acodec: "aac",
          protocol: "m3u8_native",
          height: 180,
          width: 320,
          url: origin + "/index.m3u8",
          ext: "mp4",
        },
      ],
      subtitles: { en: [{ url: origin + "/captions.srt", ext: "srt" }] },
    }),
  );
  // Replace the external platform discovery step with yt-dlp's supported info
  // snapshot input. Worker parsing, subtitle retrieval, section downloads and
  // FFmpeg still run unchanged. These substitutions exist only in this child.
  const python = path.join(dir, "python-test-worker");
  await writeFile(
    python,
    `#!/usr/bin/env python3
import os, sys
from pathlib import Path
script = Path(sys.argv[1])
is_long = any(os.environ["LONG_FIXTURE_ID"] in arg for arg in sys.argv)
if script.name not in ("ingest.py", "transcribe.py") or not (is_long or os.environ["FIXTURE_INPUT"] in sys.argv):
    os.execvp(sys.executable, [sys.executable, *sys.argv[1:]])
sys.path.insert(0, str(script.parent))
import ingest
from youtube_transcript_api import YouTubeTranscriptApi
YouTubeTranscriptApi.list = lambda self, video_id: []
allowed = ingest.allowed_asset
ingest.allowed_asset = lambda value, provider: (isinstance(value, str) and value.startswith(os.environ["FIXTURE_ORIGIN"] + "/")) or allowed(value, provider)
real_run = ingest.run
def run(args, *a, **kw):
    if "-J" in args and "--" in args:
        args = args[:args.index("--")] + ["--load-info-json", os.environ["LONG_FIXTURE_INFO" if is_long else "FIXTURE_INFO"]]
    return real_run(args, *a, **kw)
ingest.run = run
sys.argv = sys.argv[1:]
if script.name == "transcribe.py":
    import transcribe
    transcribe.main()
else:
    raise SystemExit(ingest.main())
`,
    { mode: 0o700 },
  );
  const input = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
  return {
    input,
    requests, ranges,
    env: {
      PYTHON_BIN: python,
      FIXTURE_INPUT: input,
      LONG_FIXTURE_ID: LONG_ID, LONG_FIXTURE_INFO: longInfo,
      FIXTURE_INFO: info,
      FIXTURE_ORIGIN: origin,
      SSL_CERT_FILE: path.join(dir, "test.crt"),
    },
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
