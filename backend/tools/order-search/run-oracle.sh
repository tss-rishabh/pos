#!/bin/sh
set -eu
# Source Dockerfile/Dockerfile.celery use CPython3.10. Never select ambient
# newer Python for source arithmetic or deployment-qualified detail comparisons.
# Reuse cached, pinned dependencies; offline mode forbids runtime downloads.
exec uv run --offline --no-project --python 3.10 --with django==4.2.5 --with pymysql==1.1.1 python "$@"
