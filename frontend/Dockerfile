FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ARG POS_MEDIA_ORIGINS=
ENV POS_MEDIA_ORIGINS=${POS_MEDIA_ORIGINS}
WORKDIR /app
COPY package.json package-lock.json ./
COPY tools/dependency-security/manifest.json tools/dependency-security/verify.mjs tools/dependency-security/picomatch-4.0.7-pos-review.tgz ./tools/dependency-security/
# The web image never loads the desktop-only native modules (better-sqlite3-multiple-ciphers for
# Electron offline billing), so install scripts are skipped: no toolchain, no native build.
RUN node tools/dependency-security/verify.mjs --archive-only && npm ci --ignore-scripts && node tools/dependency-security/verify.mjs
COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# Web bundle only: `npm run build` also typechecks and bundles electron/, which is not in this image.
RUN npx tsc --noEmit -p tsconfig.json && npx vite build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
ENV API_UPSTREAM=backend:4410 NGINX_ENVSUBST_OUTPUT_DIR=/tmp/nginxconf NGINX_ENVSUBST_FILTER=API_UPSTREAM
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 nginx/entrypoint.sh /usr/local/bin/pos-web-entrypoint
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
ENTRYPOINT ["/usr/local/bin/pos-web-entrypoint"]
CMD ["nginx","-g","daemon off;"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["wget","-q","--spider","http://127.0.0.1:8080/health/static"]
