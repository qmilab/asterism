# syntax=docker/dockerfile:1

# Asterism, packaged so the same local runtime runs anywhere a container runs.
#
# THIS IS PACKAGING, NOT A SECURITY BOUNDARY. The runtime's separation guarantees
# inside the container are exactly the same as on the host — no more, no less. The
# image lets you run the same runtime elsewhere; it does not add isolation or
# containment around an agent. See docs/container.md.
#
# Two stages: build the workspace with the full toolchain, then carry only the
# compiled output and production dependencies into a slim runtime image.

# --- build: install against the committed lockfile, then compile to dist/ ------
FROM oven/bun:1 AS build
WORKDIR /app

# Manifests first so the dependency layer stays cached until a package.json or the
# lockfile actually changes — editing source does not re-resolve dependencies.
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json        packages/core/package.json
COPY packages/adapter-pi/package.json  packages/adapter-pi/package.json
COPY packages/adapter-lodestar/package.json packages/adapter-lodestar/package.json
COPY packages/reflect/package.json     packages/reflect/package.json
COPY packages/recall-local/package.json packages/recall-local/package.json
COPY packages/server/package.json      packages/server/package.json
COPY packages/channels/package.json    packages/channels/package.json
COPY packages/cli/package.json         packages/cli/package.json
RUN bun install --frozen-lockfile

# Compile every package (tsc -b across the workspace's project references).
COPY packages ./packages
RUN bun run build

# Re-resolve WITHOUT dev dependencies (TypeScript, @types/*) so only what the
# runtime needs is carried forward; dist/ lives under packages/ and is untouched.
# Then drop the now-unneeded sources, keeping each package's dist/ + manifest.
RUN rm -rf node_modules && bun install --frozen-lockfile --production
RUN find packages -mindepth 2 -maxdepth 2 -type d -name src -exec rm -rf {} +

# --- runtime: just Bun, the compiled dist/, and production dependencies ---------
FROM oven/bun:1-slim AS runtime
ENV NODE_ENV=production

# Outbound model calls go over HTTPS, so the trust store must be present.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Application code lives under /app; an install's state (the SQLite store, agent
# workspaces, the access token) lives under /data — a separate named volume, so the
# container stays disposable while state survives `docker rm`.
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

# Run unprivileged as the image's built-in `bun` user (uid 1000). /data is created
# owned by that user, so a fresh named volume mounted there is writable. The runtime
# walks up from the working directory to find `.asterism`, exactly as on the host —
# so /data is the working directory and the home lands at /data/.asterism.
RUN mkdir -p /data && chown bun:bun /data
USER bun
WORKDIR /data
VOLUME /data

# The local-first default binds 127.0.0.1, which a container cannot publish; an
# exposed endpoint overrides it with `serve <agent> --host 0.0.0.0`. 4831 is the
# runtime's default port (override with `--port`).
EXPOSE 4831

# The CLI is the entrypoint; whatever you pass after the image name is its command
# line — `serve <agent> --host 0.0.0.0`, `channel discord <agent>`, `new …`, `init`.
# With no arguments it prints usage.
ENTRYPOINT ["bun", "/app/packages/cli/dist/bin.js"]
