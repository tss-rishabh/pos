FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tools/dependency-security/manifest.json tools/dependency-security/verify.mjs tools/dependency-security/picomatch-4.0.7-pos-review.tgz ./tools/dependency-security/
RUN node tools/dependency-security/verify.mjs --archive-only && npm ci --ignore-scripts && node tools/dependency-security/verify.mjs
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime-base
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4410
WORKDIR /app
COPY package.json package-lock.json ./
COPY tools/dependency-security/manifest.json tools/dependency-security/verify.mjs tools/dependency-security/picomatch-4.0.7-pos-review.tgz ./tools/dependency-security/
RUN node tools/dependency-security/verify.mjs --archive-only && npm ci --omit=dev --ignore-scripts && node tools/dependency-security/verify.mjs --production && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY resources ./resources
USER node

FROM runtime-base AS runtime
EXPOSE 4410
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:4410/health/ready',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","dist/server.js"]
