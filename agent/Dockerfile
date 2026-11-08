# syntax=docker/dockerfile:1
FROM node:24.22.2-bookworm-slim AS dependencies
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/agent-frontend/package.json apps/agent-frontend/package.json
COPY apps/node-agent/package.json apps/node-agent/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .

FROM dependencies AS development
ENV NODE_ENV=development MODE=DEV
RUN npm run build:packages
CMD ["npm", "run", "dev:frontend", "--", "--host", "0.0.0.0"]

FROM dependencies AS build
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM node:24.22.2-bookworm-slim AS frontend-production
WORKDIR /app
ENV NODE_ENV=production MODE=PROD HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /workspace/apps/agent-frontend/.output ./
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]

FROM node:24.22.2-bookworm-slim AS node-production
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /work && chown node:node /data /work
ENV NODE_ENV=production MODE=PROD HOST=0.0.0.0 PORT=3101
COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/node-agent ./apps/node-agent
COPY --from=build --chown=node:node /workspace/packages/contracts ./packages/contracts
USER node
EXPOSE 3101
CMD ["node", "apps/node-agent/dist/index.js"]
