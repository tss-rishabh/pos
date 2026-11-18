#!/bin/sh
# Authoring only until the coordinated native execution slot is available.
set -eu
umask 077
origin_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$origin_here/assemble.py" "$@"
