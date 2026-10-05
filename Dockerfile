# S7 Monitor — obraz serwera (API + SSE + PWA)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
# better-sqlite3 zwykle pobiera gotowy plik binarny; gdyby się nie udało — kompilujemy ze źródeł.
RUN npm ci --omit=dev \
 || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
     && rm -rf /var/lib/apt/lists/* && npm ci --omit=dev --build-from-source) \
 && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    TZ=Europe/Warsaw
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
