#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${SILVERHAND_ANDROID_ENV:-$HOME/Library/Developer/SilverhandAndroid/env.sh}"
test -f "$CONFIG" || { echo "Missing local environment config: $CONFIG" >&2; exit 1; }
source "$CONFIG"
cd "$APP_DIR/../.."
exec python3 "$APP_DIR/scripts/workflow.py" "$@"
