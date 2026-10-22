#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-jellymark:local}"
CONTAINER_NAME="${CONTAINER_NAME:-JellySync}"
HOST_PORT="${HOST_PORT:-8788}"
DATA_DIR="${DATA_DIR:-${ROOT_DIR}/data}"
TOKEN_FILE="${TOKEN_FILE:-${DATA_DIR}/admin-token}"
# A renamed container must not be installed alongside the older production
# JellyMark container: both would contend for port 8788, and a different image
# tag could accidentally replace a newer, working test deployment.
if [[ "$CONTAINER_NAME" == JellySync ]]; then
  for old_name in jellyfin-watchlist-sync jellymark-sync; do
    if docker container inspect "$old_name" >/dev/null 2>&1; then
      printf 'ERROR: Existing JellyMark container %s detected.\n' "$old_name" >&2
      printf 'Migrate its current image, data, and credentials before using the new JellySync name.\n' >&2
      exit 1
    fi
  done
fi
# Unraid's GUI must remain the owner once a native DockerMan template is in use.
# Replacing it with a bare docker run would remove native Edit/Auto-Start.
if [[ "$(docker container inspect "$CONTAINER_NAME" --format '{{index .Config.Labels "net.unraid.docker.managed"}}' 2>/dev/null || true)" == dockerman ]]; then
  printf 'ERROR: %s is managed by Unraid. Update it through the native template, not this script.\n' "$CONTAINER_NAME" >&2
  exit 1
fi
umask 077
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
if [[ ! -s "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24 > "$TOKEN_FILE"; else
    python3 - <<'PY' > "$TOKEN_FILE"
import secrets
print(secrets.token_hex(24))
PY
  fi
  chmod 600 "$TOKEN_FILE"
fi
ADMIN_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
echo "Building ${IMAGE_NAME}..."
docker build -t "$IMAGE_NAME" "$ROOT_DIR"
if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "Replacing existing ${CONTAINER_NAME}; persistent data is preserved."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --label 'net.unraid.docker.icon=https://raw.githubusercontent.com/isaacAmejia/jellymark/main/assets/unraid/jellysync.png' \
  --label "net.unraid.docker.webui=http://[IP]:[PORT:${HOST_PORT}]/" \
  --label 'net.unraid.docker.shell=sh' \
  -p "${HOST_PORT}:8788" \
  -e DATA_DIR=/data \
  -e PORT=8788 \
  -e JWS_ADMIN_TOKEN="$ADMIN_TOKEN" \
  -v "${DATA_DIR}:/data" \
  "$IMAGE_NAME" >/dev/null
cat <<OUT

JellyMark Sync is running.

Open:        http://YOUR-SERVER-HOST:${HOST_PORT}/
Token file:  ${TOKEN_FILE}
Data:        ${DATA_DIR}

Read the token file locally, then paste the token into the admin page to unlock setup.
Your Jellyfin Watchlist works independently of this sync service.
OUT




