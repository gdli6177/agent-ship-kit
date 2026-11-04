#!/bin/sh
set -eu

herdr=${HERDR_BIN_PATH:-herdr}
if [ "${HERDR_ENV:-}" != "1" ]; then
  printf '%s\n' "Crewvane: open this action from inside Herdr." >&2
  exit 1
fi

exec "$herdr" agent focus concierge
