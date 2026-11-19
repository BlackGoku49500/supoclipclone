# Working on SupoClip Lite

The application runs as one Docker service. Keep the studio in `app/`, server handlers and queue logic in `server/`, shared source types in `lib/`, and media processes in `worker/`. Preserve the session ownership boundary and keep OpenRouter credentials out of files, logs and subprocess arguments.

Use Node 22+, Python 3.11+ and FFmpeg. Run `make check`, `make test` and `make test-e2e` using the setup in the README. Scope media changes to selected intervals and cover changes to timing, resumability or caching with a focused regression test under `tests/`.

Keep user-visible changes in the root changelog, with a link to the pull request. Describe verification and any data or configuration changes in the PR. Do not commit runtime data, credentials or downloaded model files.
