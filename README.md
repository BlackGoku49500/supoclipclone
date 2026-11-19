---
title: SupoClip Lite
emoji: 🎬
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
---

# SupoClip Lite

Turn a public YouTube video or completed YouTube Live, Twitch, or Kick VOD into edited vertical MP4s. The studio, job queues, CPU speech model and encoder run in one container. OpenRouter is the only API key. **Load sample demo** opens the editor and exercises the real encoder without a key.

## Run locally

```sh
docker compose up --build -d
```

Open **http://localhost:7860**. The first build downloads the speech model and media dependencies. Compose saves jobs, transcripts and clips in the local `studio-data` volume. `docker compose down` stops the studio and preserves the volume. The published port binds to loopback by default. [Deployment options](docs/DEPLOY.md)

## Studio workflow

1. Paste a URL into **Source video**, or upload a local MP4, MOV, MKV or WebM. Analyze reads recording metadata and available subtitles. YouTube English and Hindi tracks take priority, with a second transcript lookup through `youtube-transcript-api`.
2. Enter your OpenRouter key and select **Generate viral clips**. If subtitles are missing, the bundled multilingual Whisper base model transcribes the entire audio timeline in overlapping five-minute chunks on CPU. Each finished chunk is saved. You can also paste text or import SRT/VTT subtitles.
3. The hook finder considers every timed passage in bounded OpenRouter requests. Its default is `nvidia/nemotron-3.5-super-vl:free`, with one retry through `openrouter/free` on a failed passage. It ranks up to six distinct hooks, grounded in source cue IDs. Short or sparse sources can yield fewer than three. Completed passages are cached for a retry after a quota reset. Free-model availability and quotas come from OpenRouter.
4. Adjust the jump cuts, facecam rectangle, horizontal framing and caption style. **Streamer split** puts the selected facecam above gameplay at a 35/65 split. **Smart crop** uses your pan and punches in on hype moments. **Speaker** follows visible faces using mouth motion, with your pan position as the fallback. The optional hook banner covers the first three seconds.
5. Preview and download use the same FFmpeg edit. The export is a 1080 × 1920, 30 fps H.264/AAC MP4 with fast-start playback. ASR and timed YouTube JSON3 words retain their timestamps through cuts. Subtitles that provide only phrase times use interpolated word highlights.

For captioned VODs, discovery fetches metadata and subtitle text. The encoder requests each selected range with `yt-dlp --download-sections` and reuses it for subsequent edits. HLS may transfer neighboring fragments. A captionless VOD requires reading its complete audio once. The worker prefers audio-only renditions. On platforms that expose only muxed audio/video, it reads the lowest available rendition in bounded chunks and discards each chunk after transcription. It never assembles a full remote VOD file.

## Development and verification

Native development requires Node 22+, Python 3.11+, and an FFmpeg build with libass, libx264 and ffprobe. The HTTP test also uses FFmpeg's flite filter to synthesize its speech fixture. The Docker image includes these tools.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r worker/requirements.txt
make model
npm ci
npm run dev
```

```sh
make check
make test
make test-e2e
```

The production HTTP suite runs yt-dlp, local speech recognition, OpenCV and FFmpeg against a real HTTPS media fixture. It covers a two-hour, captionless recording and includes a hook at minute 119. Recorded platform metadata and deterministic OpenRouter responses keep the test repeatable. Unit tests check ten-hour transcript coverage, checkpoint recovery and word-aligned caption timing. [Repository audit and test coverage](docs/ARCHITECTURE.md)

## API

| Request | Result |
| --- | --- |
| `POST /api/analyze-url` | Source ID, title, thumbnail, duration and timeline cues for a public URL |
| `POST /api/upload` | Source metadata for a multipart video and optional transcript |
| `POST /api/generate-clips` | With `Prefer: respond-async`, returns HTTP 202 and a job ID. The synchronous form returns `{clips}`. Pass the OpenRouter key as a bearer token. |
| `GET /api/analysis-jobs/{id}` | Analysis stage, progress and, on completion, the source and ranked clips |
| `DELETE /api/analysis-jobs/{id}` | Cancel analysis and keep finished transcription and model checkpoints |
| `POST /api/preview` or `POST /api/render-clip` | Job ID for a 540 × 960 preview or 1080 × 1920 export |
| `GET /api/jobs/{id}` or `DELETE /api/jobs/{id}` | Render status or cancellation |
| `GET /api/media/{id}?download=1` | Session-scoped MP4 download with byte-range support |
| `GET /api/health` | HTTP process readiness |

Render requests contain `{sourceId, clip, settings}`. All job and media requests use the browser session cookie issued when a source is created. The API key stays in browser storage and in server memory during analysis. Jobs do not write it to disk. Inactive workspaces are eligible for removal after 24 hours.
