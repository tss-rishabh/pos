"""Closed worker diagnostics: no request lines, exceptions or source parameters."""

import json
import sys
import uuid

from gunicorn.glogging import Logger


class PrivateGunicornLogger(Logger):
    def access(self, *_args, **_kwargs):
        pass

    def error(self, *_args, **_kwargs):
        sys.stderr.write(
            json.dumps(
                {
                    "module": "runtime",
                    "resource": "offline-cash-pricing-worker",
                    "eventId": "runtime.offline-cash-pricing-worker.error",
                    "eventInstanceId": str(uuid.uuid4()),
                    "requestId": None,
                    "userId": None,
                },
                separators=(",", ":"),
            )
            + "\n"
        )

    critical = warning = exception = error

    def info(self, *_args, **_kwargs):
        pass

    debug = info
