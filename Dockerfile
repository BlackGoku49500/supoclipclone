FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/BlackGoku49500/supoclipclone"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=7860 \
    SUPO_DATA_DIR=/data \
    SUPO_MODEL_DIR=/opt/supoclip-model \
    SUPO_ASR_THREADS=4 \
    OMP_NUM_THREADS=4 \
    OPENBLAS_NUM_THREADS=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/supoclip-python/bin:${PATH}"
WORKDIR /app
# Build in a disposable mount. Only the standalone app, media tools and offline model enter the image.
RUN --mount=type=bind,source=.,target=/src \
    --mount=type=tmpfs,target=/build \
    --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -f /run/secrets/build_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca PIP_CERT=/run/secrets/build_ca SSL_CERT_FILE=/run/secrets/build_ca; \
    fi; \
    cd /build; cp -a /src/. ./; \
    npm ci --include=dev --no-audit --no-fund --cache /build/npm-cache; \
    npm run build; \
    cp -a .next/standalone/. /app/; \
    mkdir -p /app/.next/static; cp -a .next/static/. /app/.next/static/; \
    cp -a public worker LICENSE /app/; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates ffmpeg fontconfig fonts-dejavu-core fonts-noto-core python3 python3-venv; \
    rm -rf /var/lib/apt/lists/*; \
    python3 -m venv /opt/supoclip-python; \
    pip install --no-cache-dir -r /app/worker/requirements.txt; \
    python3 /app/worker/model.py "$SUPO_MODEL_DIR"; \
    fc-cache -f; \
    chown -R node:node /app; \
    install -d -o node -g node /data /app/.next/cache
USER node
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
