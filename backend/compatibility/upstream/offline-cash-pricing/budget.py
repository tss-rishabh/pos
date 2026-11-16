"""One monotonic request budget shared by database reads and source calculations."""

from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar

from source_calculator import PricingError

_budget = ContextVar("offline_cash_request_budget", default=None)


@contextmanager
def request_budget(seconds=20, *, clock=time.monotonic):
    token = _budget.set((clock() + seconds, clock))
    try:
        yield
    finally:
        _budget.reset(token)


def remaining_milliseconds():
    value = _budget.get()
    if value is None:
        return 20000
    deadline, clock = value
    remaining = int((deadline - clock()) * 1000)
    if remaining <= 0:
        raise PricingError("SOURCE_DEADLINE_EXCEEDED", 503)
    return remaining


def check_deadline():
    remaining_milliseconds()
