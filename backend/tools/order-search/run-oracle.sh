#!/bin/sh
set -eu
# Reuse cached, pinned source dependencies. No network or automatic installation.
exec uv run --offline --no-project --with django==4.2.5 --with pymysql==1.1.1 python "$@"
