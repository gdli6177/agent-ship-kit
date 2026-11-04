#!/bin/sh
set -eu

entrypoint=${1:?missing pane entrypoint}
herdr=${HERDR_BIN_PATH:-herdr}

if [ "${HERDR_ENV:-}" != "1" ]; then
  printf '%s\n' "Crewvane: open this action from inside Herdr." >&2
  exit 1
fi
set -- plugin pane open \
  --plugin dev.crewvane \
  --entrypoint "$entrypoint" \
  --placement overlay \
  --focus

exec "$herdr" "$@"
