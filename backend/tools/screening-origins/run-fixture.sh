#!/bin/sh
set -eu
task_backend_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
task_fixture_project="$task_backend_root/compatibility/upstream/offline-cash-pricing"
# A separate locked fixture environment leaves the shared source .venv intact.
export UV_PROJECT_ENVIRONMENT="${TMPDIR:-/tmp}/pos-origin-source-fixtures-20261118"
exec uv run --project "$task_fixture_project" --frozen --group origin-source-fixtures python "$@"
