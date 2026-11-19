# Deploy the studio

Use one long-lived Linux container and one replica. Node serves the UI and API. It runs the Python speech and media processes on demand. The final image contains a verified Whisper base model and defaults to CPU INT8 with four inference threads.

## Local Docker

```sh
docker compose up --build -d
docker compose logs -f studio
```

Open **http://localhost:7860**. Compose starts one service with a named data volume and a health check. To run the image directly, use:

```sh
docker build -t supoclip-lite .
docker run --rm --init --name supoclip-lite -p 127.0.0.1:7860:7860 -v supoclip-data:/data supoclip-lite
```

## Hugging Face Docker Spaces

Use the Lite branch as the Space repository root and choose the Docker SDK. The README declares port 7860. The runtime runs as UID 1000 and uses `/data`. Attach persistent storage to retain checkpoints through replacement of the container. With ephemeral storage, a hardware restart can discard the workspace. CPU hardware with 16 GB of memory fits the intended configuration. Transcription time depends on available CPU, speech density and provider throughput.

## Railway and Render

Deploy the Lite branch as one Docker service. Railway reads `railway.json` and supplies `PORT`. On Render, use the included `render.yaml` Blueprint. For durable jobs, mount a volume or disk at `/data`. Set the instance to stay awake during long jobs. The studio reports progress via short HTTP requests, so running a ten-hour source does not require an hours-long browser connection. Open the same tab to rejoin its job. If the process restarted, choose Generate again to reuse completed audio chunks and OpenRouter passages.

## Configuration

| Setting | Default in Docker | Purpose |
| --- | --- | --- |
| `PORT` | `7860` | Server listen port |
| `SUPO_DATA_DIR` | `/data` | Local session data, checkpoints, section cache and exports |
| `SUPO_ASR_THREADS` | `4` | CPU inference threads, bounded to 1–8 |
| `SUPO_MODEL_DIR` | `/opt/supoclip-model` | Bundled offline multilingual speech weights |

One analysis and one encoder can run concurrently. The largest private upload is 512 MiB. A five-minute decoded audio chunk uses about 10 MB of temporary space. Rendered files, local uploads and cached sections also consume disk. The 24-hour inactivity sweep runs during subsequent studio activity. For an internet-facing personal deployment, use the host's access controls if you need to limit who can consume CPU and disk.

The platform must allow the hosting region to access the VOD and its media CDNs. Signing in, current live broadcasts and DRM-protected sources are outside the supported public-VOD flow. Progressive streams must honor byte ranges. For platforms that do not expose a compatible rendition, import the recording locally. OpenRouter needs outbound HTTPS during hook selection. The production runtime loads its speech model from the image.

The single Docker build installs the current yt-dlp release. Rebuild with `docker compose build --no-cache` when extractor changes are needed. A managed build proxy can pass a public trust bundle with the BuildKit secret `build_ca`.
