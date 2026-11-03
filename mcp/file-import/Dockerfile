ARG PENPOT_VERSION=2.18.5
FROM penpotapp/exporter:${PENPOT_VERSION} AS build
USER root
WORKDIR /tmp/file-import
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --ignore-workspace --frozen-lockfile
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-workspace && mkdir jobs

FROM penpotapp/mcp:${PENPOT_VERSION}
WORKDIR /opt/penpot/file-import
COPY --from=build /tmp/file-import/dist ./dist
COPY --from=build /tmp/file-import/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build --chown=node:node /tmp/file-import/jobs /data/jobs
EXPOSE 4405
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4405/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
