"""Reject native coupon history before execution, including imported aliases.

Qualified SourceCouponCandidate replays these literal reads entirely in memory;
they must never reach a driver. Current order/HP evidence remains outside this
cart-only fence and is not mislabeled as an application history fallback.
"""
import re
from contextlib import contextmanager
from sqlalchemy import event
from benefit_source import BenefitReview


def coupon_history_statement(statement):
    raw=re.sub(r'/\*.*?\*/',' ',str(statement),flags=re.S)
    raw=re.sub(r'--[^\r\n]*(?:\r?\n|$)',' ',raw)
    sql=' '.join(raw.lower().split())
    # The qualified head port opens only metadata/MDL. LIMIT 0 cannot read a
    # historical row and is the exact audited capture statement, not a SELECT
    # prefix exemption that could become a data fallback.
    if re.fullmatch(r'select id from (?:orders|order_coupon_log) limit 0',sql):return False
    tables=set(re.findall(r'\b(?:from|join)\s+(?:`?[a-z0-9_]+`?\.)?`?(orders|order_coupon_log)`?\b',sql))
    return 'order_coupon_log' in tables or 'orders' in tables and re.search(r'\bcoupon_used\b',sql) is not None


@contextmanager
def guard_coupon_history(session):
    rejected=False
    def inspect(statement):
        nonlocal rejected
        if coupon_history_statement(statement):
            rejected=True
            raise BenefitReview('ORDER_IMPORT_COUPON_HISTORY_QUERY_UNQUALIFIED')
    class Current:
        def execute(self,statement,*args,**kwargs):
            inspect(statement)
            return session.execute(statement,*args,**kwargs)
        def __getattr__(self,name):return getattr(session,name)
    def clause(_connection,statement,_multiparams,_params,_options):inspect(statement)
    def cursor(_connection,_cursor,statement,_parameters,_context,_many):inspect(statement)
    connection=session.connection() if callable(getattr(session,'connection',None)) else None
    if connection is not None:
        event.listen(connection,'before_execute',clause)
        event.listen(connection,'before_cursor_execute',cursor)
    try:
        yield Current()
        if rejected:raise BenefitReview('ORDER_IMPORT_COUPON_HISTORY_QUERY_UNQUALIFIED')
    finally:
        if connection is not None:
            event.remove(connection,'before_execute',clause)
            event.remove(connection,'before_cursor_execute',cursor)
