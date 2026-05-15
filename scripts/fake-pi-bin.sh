#!/bin/sh
# Wrapper so PI_ACP_PI_COMMAND can be a single executable path.
# Ignores all arguments (--mode rpc --no-themes etc.) from pi-acp adapter.
exec node "$(dirname "$0")/fake-pi.mjs"
