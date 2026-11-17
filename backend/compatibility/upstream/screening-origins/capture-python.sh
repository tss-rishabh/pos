#!/bin/sh
# Preserve the reviewed dependency image's Python/virtualenv selection.
# exec retains the PID used by the publisher's deadline/abort cancellation.
exec python3 "$@"
