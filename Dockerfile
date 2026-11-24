FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
# ffmpeg + fonts are used only when a user chooses "Run on server" (server-side watching/rendering).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# CPU binaries of onnxruntime-node are bundled; skip its optional CUDA download.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev && npm cache clean --force \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32
COPY server ./server
COPY public ./public
# Stamped by docker compose (the updater passes the deployed commit) so the UI can show what is running.
ARG GIT_COMMIT=""
ARG BUILD_TIME=""
RUN node -e "require('fs').writeFileSync('build.json', JSON.stringify({ commit: process.env.GIT_COMMIT || '', builtAt: process.env.BUILD_TIME || new Date().toISOString() }))"
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
