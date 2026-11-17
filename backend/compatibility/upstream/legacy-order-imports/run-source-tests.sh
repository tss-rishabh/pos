#!/bin/sh
set -eu
import_source_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
import_source_python="$import_source_root/../offline-cash-pricing/.venv/bin/python"
if [ ! -x "$import_source_python" ]; then
  printf '%s\n' 'The locked offline-cash Python fixture runtime is required.' >&2
  exit 1
fi
"$import_source_python" -B "$import_source_root/prepare.py"
"$import_source_python" -B "$import_source_root/test_protocol.py" -v
"$import_source_python" -B "$import_source_root/test_source_sessions.py" -v
"$import_source_python" -B "$import_source_root/tender-profile/prepare.py"
"$import_source_python" -B "$import_source_root/tender-profile/test_tender.py" -v
