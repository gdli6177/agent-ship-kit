#!/bin/sh
set -eu

cli=${CREWVANE_CLI_PATH:-${HOME}/.local/bin/crewvane}
if [ ! -x "$cli" ]; then
  printf '%s\n' \
    "Crewvane CLI is not available at $cli." \
    "Open Crewvane once, choose a workspace, then reopen this plugin." >&2
  exit 1
fi

# Plugin events run inside the Herdr server and must never inherit the current
# case scope from a concierge that happened to start that server.
unset CREWVANE_COORDINATOR CREWVANE_COORDINATOR_SCOPE_FILE
exec "$cli" event herdr --json
