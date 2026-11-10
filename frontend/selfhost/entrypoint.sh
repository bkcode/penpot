#!/usr/bin/env bash
set -euo pipefail

# Keep first-login questions and team setup out of this self-hosted instance.
export PENPOT_FLAGS="${PENPOT_FLAGS:+${PENPOT_FLAGS} }disable-onboarding"

exec /bin/bash /entrypoint.sh "$@"
