#!/bin/sh
set -eu
mkdir -p "${NGINX_ENVSUBST_OUTPUT_DIR:-/tmp/nginxconf}"
exec /docker-entrypoint.sh "$@"
