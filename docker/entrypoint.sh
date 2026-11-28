#!/bin/sh
# Runs Tagmonia as PUID:PGID (D72). Started as root, it only makes /config belong to that user and then drops
# to it for good; started as another user (Docker's `user:`), it just runs as that user.
set -eu

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
case "$PUID$PGID" in
  *[!0-9]*) echo "PUID and PGID must be numbers (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;;
esac
if [ "$PUID" = "0" ]; then
  echo "PUID=0 would run Tagmonia as root, which it never does; use another user" >&2
  exit 1
fi

CONFIG="${TAGMONIA_CONFIG_DIR:-/config}"
mkdir -p "$CONFIG"
# Only when the owner differs (a first start, or a changed PUID/PGID): a full chown on every start would be slow.
if [ "$(stat -c %u:%g "$CONFIG")" != "$PUID:$PGID" ]; then
  echo "Tagmonia: giving $CONFIG to $PUID:$PGID"
  chown -R "$PUID:$PGID" "$CONFIG"
fi

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"
