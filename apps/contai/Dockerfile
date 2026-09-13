# Cont.ai by Lumarcont - imagem de producao
# Tudo em Node: OCR (Tesseract WASM), rasterizacao (@napi-rs/canvas, binarios
# pre-compilados) e SQLite (better-sqlite3). Sem dependencias de sistema alem
# das necessarias para compilar better-sqlite3 na fase de build.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/contai.db STORAGE_ROOT=/data/arquivo TESSERACT_CACHE_PATH=/data/tesseract
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/tsconfig.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
