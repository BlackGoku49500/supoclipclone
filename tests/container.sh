#!/bin/sh
# Exercise the released image as a non-root service and run the production-route media suite inside it.
set -eu
image=${1:-supoclip-lite:local}
port=${SUPO_TEST_PORT:-7860}
name="supoclip-check-$$"
suite="/tmp/supoclip-tests"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --init --memory=4g --cpus=2 --name "$name" -p "127.0.0.1:$port:7860" "$image" >/dev/null
attempt=0
until curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then docker logs "$name"; exit 1; fi
    sleep 1
done
docker exec "$name" sh -c 'test "$(id -u)" = 1000 && test -w /data && test -r "$SUPO_MODEL_DIR/model.bin"'
# Normalize checkout permissions on the streamed test copy for the unprivileged image user.
tar --mode='u+rwX,go+rX' -C "$(dirname "$0")/.." --exclude=__pycache__ -cf - tests |
    docker exec -i "$name" sh -c "mkdir -p '$suite' && tar -xf - -C '$suite' && ln -s /app/worker '$suite/worker'"
docker exec -e PYTHONPATH=/app -w /app "$name" python3 -m unittest discover -s "$suite/tests" -p 'test_*.py' -v
docker exec "$name" node "$suite/tests/http-e2e.mjs" --image
docker image inspect --format 'Image size in bytes {{.Size}}' "$image"
docker exec "$name" sh -c 'if test -r /sys/fs/cgroup/memory.peak; then printf "Peak cgroup bytes "; cat /sys/fs/cgroup/memory.peak; fi'
