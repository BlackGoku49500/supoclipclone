# Repository audit and Lite design

The linked fork at `1a36cd7` contains the Compose stack, database initialization, license and setup scripts. Its tree contains 17 tracked root files. The frontend, API, worker and Prisma implementation directories referenced by Compose are absent from that commit. The self-hosting guide links to the complete upstream project. The audit used upstream revision `0633c307` and the existing Lite studio revision `59cc0fb`. The Lite branch keeps the fork's license. The upstream implementation was consulted for behavior. [Fork tree](https://github.com/BlackGoku49500/supoclipclone/tree/1a36cd7099dc13096bb32c14aa30becd54602644) · [Self-hosting guide](https://www.supoclip.com/blog/self-host-supoclip-docker) · [Upstream tree](https://github.com/FujiwaraChoki/supoclip/tree/0633c307ffcd7b4854389473cc9802c6d13c5815)

| Original path or service | Behavior examined | Lite implementation |
| --- | --- | --- |
| Frontend, FastAPI, ARQ workers, Prisma/PostgreSQL, Redis and media storage | Task creation, progress, artifacts and ownership | Next.js route handlers, bounded in-process queues, atomic local JSON and private files |
| `backend/src/youtube_source.py` | VOD resolution, source format preferences and section seeking | `worker/ingest.py` canonicalizes YouTube live links, inspects metadata, validates media renditions and fetches the selected intervals |
| `backend/src/media/transcription.py` | Local and hosted transcription, word-level alignment | Native subtitles, a second YouTube transcript lookup, then CPU Faster-Whisper with VAD, word timestamps and resumable audio chunks |
| `backend/src/ai.py`, `clip_openings.py`, `services/video_service.py` | Hook strength, contextual openings, payoff and time grounding | `server/brain.ts` scans every overlapping passage, checks cue anchors, closes long speech gaps, ranks candidates and removes overlap |
| `backend/src/media/speaker_framing.py`, `face_detection.py`, `reframing.py` | Active speaker and dominant-face fallback, vertical layout | `worker/speaker.py` samples selected media at 3 fps and uses face size, relative lower-face motion and switching hysteresis. Manual split and pan remain available. Speaker identity is estimated visually. |
| `backend/src/media/timeline.py`, `captions.py` and FFmpeg helpers | Edit-time remapping, layouts and subtitle rendering | `worker/render.py` produces frame-counted video, sample-counted audio, ASS pop-in highlights and the optional hook banner for preview and MP4 |

The browser session is the ownership boundary for sources, files and jobs. Billing, account provisioning, cron, SQL schema migrations, external storage and separately deployed workers have been removed from the Lite runtime. The local volume is the complete job store. Existing multi-service databases and buckets are independent of the new local workspace.

## What the tests exercise

- A captioned HTTPS HLS recording verifies metadata-only discovery, jump cuts, selected fragments, slice-cache reuse, two isolated sessions and a real H.264/AAC export.
- A two-hour completed `/live/` fixture contains synthesized speech at the start, around 60 minutes and around 119 minutes. The test drives the production HTTP routes, verifies audio-only byte ranges during transcription, recognizes the final passage with the real model, and renders its late video range. The silent spans keep the test practical. It measures time coverage and alignment. Throughput on continuously spoken audio depends on the hardware.
- A ten-hour checkpoint test interrupts a chunk, resumes it and checks the complete time partition. A separate ten-hour transcript test verifies every cue reaches a bounded OpenRouter request. The fixture returns HTTP 429 for the primary model and valid cue anchors for the free fallback.
- Renderer tests inspect output pixels, audio samples, exact frame counts, word timestamps, cropped regions and MP4 codecs. A moving portrait verifies face tracking across a cut.
- Live model quality, quota and platform reachability depend on the account, source and deployment region. No external credentials are required by the deterministic suite.
