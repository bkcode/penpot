# The exporter supplies a matching ARM64/AMD64 Chromium and its system libraries.
ARG PENPOT_VERSION=2.18.5
FROM penpotapp/exporter:${PENPOT_VERSION} AS build
USER root
WORKDIR /tmp/resident-worker
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --ignore-workspace --frozen-lockfile
COPY src ./src
RUN pnpm run build

FROM penpotapp/exporter:${PENPOT_VERSION}
USER root
WORKDIR /opt/penpot/resident-worker
COPY --from=build /tmp/resident-worker/dist ./dist
RUN mkdir node_modules && ln -s /opt/penpot/exporter/node_modules/playwright node_modules/playwright && chown -R penpot:penpot .
USER penpot:penpot
EXPOSE 4404
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 CMD node -e "fetch('http://127.0.0.1:4404/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
