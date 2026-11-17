# Stage 1: Build
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Runtime (minimal image, non-root user)
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The server's filesystem is the container's, not the caller's machine. Stated explicitly so the image does not
# depend on the code's default (which may become `local` for npm installs). `docker run -e` / `--env-file` still
# override it.
ENV MCP_DEPLOYMENT_MODE=docker
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY resources/boilerplate ./resources/boilerplate
COPY resources/test-orchestrator ./resources/test-orchestrator
USER node
CMD ["node", "dist/index.js"]
