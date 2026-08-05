# Builds the whole web app: frontend bundle + backend binary in one image.
#
# Build from the REPO ROOT, not from server/, because the backend depends on
# crates outside this directory (tauri-app/crates/remote-files, dino-admin):
#
#   docker build -f server/Dockerfile -t adbstudio-web .
#
# The SSH key is NOT baked in — mount it at run time (see server/DEPLOY.md).

# --- frontend -------------------------------------------------------------
FROM node:22-bookworm AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# public/ carries scrcpy-server + icon-helper.apk. fetch-assets.sh needs network
# and the native app's resources, so require them to be present already (run
# `npm run assets` before building the image).
RUN test -f public/scrcpy-server || (echo "public/scrcpy-server missing — run 'npm run assets' first" && exit 1)
RUN npm run build

# --- backend --------------------------------------------------------------
FROM rust:1-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
      protobuf-compiler pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Copy the path dependencies too, or cargo can't resolve the manifest.
COPY server/ server/
COPY dino-admin/ dino-admin/
COPY tauri-app/Cargo.toml tauri-app/Cargo.toml
COPY tauri-app/crates/ tauri-app/crates/
WORKDIR /src/server
RUN cargo build --release --locked

# --- runtime --------------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      # adb: the ws->tcp relay needs a real adb server behind it for wireless
      # devices and mDNS discovery. USB devices never come through here.
      adb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=server /src/server/target/release/adbstudio-web-server /usr/local/bin/
COPY --from=web /app/web/dist /srv/web

ENV ADBSTUDIO_ADDR=0.0.0.0:7070 \
    ADBSTUDIO_STATIC=/srv/web \
    ADBSTUDIO_SSH_KEY=/run/secrets/id_rsa \
    ADBSTUDIO_ADB_SERVER=127.0.0.1:5037

EXPOSE 7070

# Start an adb server alongside the app. `adb devices` here sees the *container's*
# network, which is what serves wireless devices; mDNS needs host networking to
# be useful (see DEPLOY.md).
COPY server/entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
