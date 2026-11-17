"""Invocation-local automatic membership batching and literal history fence.

Selected commands postpone only automatic membership processing until final
Cart.get. Unselected commands keep per-add ordering. Neither may execute the
three literal membership history SELECTs through an imported native Session.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import re
from sqlalchemy import event
from protocol import PREPARATION_CONTRACT,ImportReview
from transaction import VIOLATION

BUILDING=ContextVar('pos_import_membership_catalog_build',default=None)
PREVIEW_ONLY=ContextVar('pos_import_read_only_preview',default=False)
HISTORY_QUERIES=frozenset((
    'SELECT id, payment_method, order_status FROM orders WHERE user_id = :user_id AND order_status = 3 ORDER BY created_at DESC LIMIT 1',
    'SELECT id, payment_method, order_status FROM orders WHERE user_id = :user_id AND order_status = 3 AND created_at > :date_before ORDER BY created_at DESC',
    'SELECT prod_id,is_exclusive_order FROM has_products WHERE order_id = :order_id',
))


def selected(cap):
    return (cap.get('preparationContract')==PREPARATION_CONTRACT or
            (cap.get('contract')==PREPARATION_CONTRACT and cap.get('purpose')=='source-cart-preview'))


@contextmanager
def read_only_preview():
    if PREVIEW_ONLY.get():raise ImportReview('ORDER_IMPORT_NESTED_TRANSACTION')
    token=PREVIEW_ONLY.set(True)
    try:yield
    finally:PREVIEW_ONLY.reset(token)


def preview_effect(function):
    def controlled(*args,**kwargs):
        if PREVIEW_ONLY.get():return None
        return function(*args,**kwargs)
    return controlled


def automatic_membership(source):
    class InvocationMembership(source):
        def process(self):
            cap=BUILDING.get()
            if cap is not None:
                if not selected(cap):raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
                from membership_profile import CONTEXT
                state=CONTEXT.get()
                if state is not None and state['capability'] is not cap:
                    raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
                # Defer the method, not its decision. Final Cart.get executes
                # the complete literal method with current selected controls.
                return None
            return super().process()
    return InvocationMembership


@contextmanager
def catalog_build(cap):
    token=BUILDING.set(cap if selected(cap) else None)
    try:yield
    finally:BUILDING.reset(token)


@contextmanager
def guard_history(session):
    blocked=False
    def inspect(statement):
        nonlocal blocked
        compact=' '.join(str(statement).split())
        compact=re.sub(r'%\(([a-z_]+)\)s',r':\1',compact)
        if compact in HISTORY_QUERIES:
            blocked=True;VIOLATION.set(True)
            raise ImportReview('ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED')
    class CurrentOnly:
        def execute(self,statement,*args,**kwargs):
            inspect(statement)
            return session.execute(statement,*args,**kwargs)
        def __getattr__(self,name):return getattr(session,name)
    def statement(_connection,_cursor,sql,_parameters,_context,_many):inspect(sql)
    def clause(_connection,sql,_multiparams,_params,_options):inspect(sql)
    # Production owned receivers admit native SQLAlchemy Sessions only. The
    # direct proxy also lets inert source oracles test exact literal queries.
    connection=session.connection() if callable(getattr(session,'connection',None)) else None
    if connection is not None:
        event.listen(connection,'before_execute',clause)
        event.listen(connection,'before_cursor_execute',statement)
    try:
        yield CurrentOnly()
        if blocked:raise ImportReview('ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED')
    finally:
        if connection is not None:
            event.remove(connection,'before_execute',clause)
            event.remove(connection,'before_cursor_execute',statement)
