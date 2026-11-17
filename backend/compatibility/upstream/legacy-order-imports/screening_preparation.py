"""Qualified current ticket counter for rollback-only CSV Cart preview.

Capture only after the exact owned global customer lock. Cart can replay only
the pinned screening helper query. Every other historical query retains its
separate published-history route. Nothing is reserved or written here.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy

from protocol import ImportReview,verify_preparation
from screening_transaction import current
from screening_counter import read_current,ReplaySession,CounterReadRefused,refuse

_ACTIVE=ContextVar('pos_csv_screening_preparation_counter',default=None)


class _Counter:
    def __init__(self,owner,session,user,plan,cap):
        self.owner,self.session,self.cap,self.plan=owner,session,deepcopy(cap),deepcopy(plan)
        self.customer=str(user['user_id'])
        self.witness=current(session,cap)
        if self.customer!=cap['authority']['customerId']:
            raise ImportReview('ORDER_IMPORT_SCREENING_SCOPE_CHANGED')
        self.snapshot=read_current(session,self.customer)

    def check(self,owner,session,user,plan,cap):
        if (self.owner is not owner or self.cap!=cap or self.plan!=plan or
                self.customer!=str(user['user_id']) or current(session,cap) is not self.witness):refuse()


@contextmanager
def capture(owner,session,user,plan,cap):
    """Before the generic preview SQL guard; no public capability is admitted."""
    verified=verify_preparation(owner.auth_key,cap,cap['operationId'],plan,owner.clock())
    if _ACTIVE.get() is not None:raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED')
    state=_Counter(owner,session,user,plan,verified)
    token=_ACTIVE.set(state)
    try:
        yield
        state.snapshot.validate()
    except CounterReadRefused:
        raise ImportReview('ORDER_IMPORT_SCREENING_COUNTER_INVALID') from None
    finally:_ACTIVE.reset(token)


@contextmanager
def replay(owner,session,user,plan,cap):
    state=_ACTIVE.get()
    try:
        if state is None:raise ImportReview('ORDER_IMPORT_SCREENING_PREPARATION_REQUIRED')
        state.check(owner,session,user,plan,cap)
        supplied=ReplaySession(session,state.snapshot)
        yield supplied
        if supplied.reads==0:refuse()
    except CounterReadRefused:
        raise ImportReview('ORDER_IMPORT_SCREENING_COUNTER_INVALID') from None

