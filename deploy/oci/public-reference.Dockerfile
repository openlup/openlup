# The published public-reference OCI descriptor. This file is projected to the
# exported root Dockerfile; it is intentionally unrelated to the private
# full-platform Dockerfile at the source root.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
WORKDIR /workspace
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json ./packages/core/package.json
RUN npm ci

COPY . ./
RUN npm run build

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
ARG PUBLIC_REFERENCE_REVISION
ARG PUBLIC_REFERENCE_CAPABILITY_DIGEST

LABEL org.opencontainers.image.title="OpenLup public reference"
LABEL org.opencontainers.image.description="Read-only public reference pages"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.revision="${PUBLIC_REFERENCE_REVISION}"
LABEL io.openlup.public-reference.base-image-digest="sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
LABEL io.openlup.public-reference.capability-digest="${PUBLIC_REFERENCE_CAPABILITY_DIGEST}"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /workspace/dist ./dist
COPY --from=builder /workspace/config/site-routes.json ./config/site-routes.json
COPY --from=builder /workspace/config/public-reference-capability-manifest.json ./config/public-reference-capability-manifest.json
COPY --from=builder /workspace/server/runtime/public-reference/serve.ts ./server/runtime/public-reference/serve.ts
COPY --from=builder /workspace/server/_lib/observability/runtimeProvenance.ts ./server/_lib/observability/runtimeProvenance.ts
COPY --from=builder /workspace/scripts/site-routes.mjs ./scripts/site-routes.mjs

# Build arguments are validated before they become the immutable public runtime
# receipt. The final image intentionally has neither application dependencies
# nor a JavaScript package manager command.
RUN test "$(printf %s "$PUBLIC_REFERENCE_REVISION" | wc -c)" -eq 40 \
    && printf %s "$PUBLIC_REFERENCE_REVISION" | grep -Eq '^[0-9a-f]{40}$' \
    && printf %s "$PUBLIC_REFERENCE_CAPABILITY_DIGEST" | grep -Eq '^sha256-[0-9a-f]{64}$' \
    && printf '%s\n' "$PUBLIC_REFERENCE_REVISION" > .public-reference-release \
    && printf '{"revision":"%s","capabilityDigest":"%s"}\n' "$PUBLIC_REFERENCE_REVISION" "$PUBLIC_REFERENCE_CAPABILITY_DIGEST" > .public-reference-runtime.json \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "-ec", "read -r baked_release < /app/.public-reference-release; export APP_RELEASE_SHA=\"$baked_release\"; unset APP_DEPLOYMENT_URL; exec node --experimental-strip-types /app/server/runtime/public-reference/serve.ts"]
