"""Owned source transaction and fresh-after-customer screening read witness.

Capability authentication precedes this helper in Receiver. This witness proves
lock/snapshot order only; it never grants actor, order, price or date authority.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import re
from sqlalchemy import event
from sqlalchemy.orm import Session
from protocol import ImportReview
from native import rows,one

_ACTIVE=ContextVar('pos_import_owned_transaction',default=None)


def _scope(cap):
    return (cap['operationId'],cap['requestHash'],cap['planHash'],cap['scope']['actorId'],
            cap['scope']['storeId'],cap['scope']['counterId'],cap['authority']['customerId'])


def _session(value):
    for _ in range(5):
        if isinstance(value,Session):return value
        value=getattr(value,'session',None)
        if value is None:break
    raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED')


class _Witness:
    def __init__(self,session,cap,transaction,isolation):
        self.session,self.scope,self.transaction,self.isolation=session,_scope(cap),transaction,isolation
        self.customer_id=str(cap['authority']['customerId'])
        self.customer_seen=False
        self.customer_ready=False
        self.violation=False

    def reject(self):
        self.violation=True
        raise ImportReview('ORDER_IMPORT_SCREENING_LOCK_ORDER') from None

    def observe(self,_connection,_cursor,statement,parameters,_context,_many):
        if self.customer_ready:return
        sql=' '.join(statement.split()).strip()
        if re.match(r'^(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+`?(?:orders|order_stores|has_products|spiderman_screening_orders|pos_rewrite_import_screening_reservations)`?\b',sql,re.I):
            self.reject()
        if not re.match(r'^SELECT\b',sql,re.I) or not re.search(r'\bFROM\b',sql,re.I):return
        # No native Order/HP/reservation lock may precede the global customer.
        if re.search(r'\b(?:FROM|JOIN)\s+`?(?:orders|order_stores|has_products|spiderman_screening_orders|pos_rewrite_import_screening_reservations)`?\b',sql,re.I):
            self.reject()
        if not re.search(r'\bFOR\s+(?:SHARE|UPDATE)\s*;?$',sql,re.I):
            # A plain native SELECT would establish an RR view before waiting
            # for the customer's previous writer, invalidating this witness.
            self.reject()
        if re.search(r'\bFROM\s+`?users`?\s+WHERE\s+`?id`?\s*=',sql,re.I) and re.search(r'FOR\s+UPDATE\s*;?$',sql,re.I):
            values=parameters.values() if isinstance(parameters,dict) else parameters or ()
            if any(type(value) in (str,int) and str(value)==self.customer_id for value in values):
                self.customer_seen=True


def prefix(session,cap,factual=False):
    # Shared actor/epoch prefix matches Node administration. It deliberately
    # does not require an active old actor: original immutable service receipt
    # reconciliation must survive archival. New work still calls fresh_authority.
    from authority_succession import actor_hint
    actor=actor_hint(cap)
    rows(session,'SELECT id FROM pos_user WHERE id=:id FOR SHARE',{'id':actor},2)
    rows(session,'SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=:id FOR SHARE',{'id':actor},2)
    one(session,'SELECT id FROM stores WHERE id=:id FOR UPDATE',{'id':cap['scope']['storeId']})
    if cap.get('succession') and not factual:
        one(session,'SELECT operator_id FROM pos_rewrite_operator_checkins WHERE operator_id=:actor AND store_id=:store AND counter_id=:counter AND expires_at>UTC_TIMESTAMP(3) FOR SHARE',{'actor':actor,'store':cap['scope']['storeId'],'counter':cap['scope']['counterId']})


@contextmanager
def owned(session,cap,factual=False):
    session=_session(session)
    if session.in_transaction() or _ACTIVE.get() is not None:
        raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED')
    with session.begin():
        # New owned transaction only. SQLAlchemy restores the pooled native
        # connection's prior isolation on release; no global SQL mode/isolation
        # is changed. RC avoids absent receipt/proof next-key locks as well as
        # stale views; a fresh RR snapshot alone would not avoid those gaps.
        connection=session.connection(execution_options={'isolation_level':'READ COMMITTED'})
        isolation=connection.get_isolation_level()
        if isolation!='READ COMMITTED':
            raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED')
        witness=_Witness(session,cap,session.get_transaction(),isolation)
        token=_ACTIVE.set(witness)
        observer=witness.observe
        event.listen(connection,'before_cursor_execute',observer)
        try:
            prefix(session,cap,factual)
            yield witness
            if witness.violation:witness.reject()
        finally:
            event.remove(connection,'before_cursor_execute',observer)
            _ACTIVE.reset(token)


def mark_customer(session,cap,customer_id):
    witness=_ACTIVE.get();session=_session(session)
    if (witness is None or witness.session is not session or witness.scope!=_scope(cap)
            or witness.transaction is not session.get_transaction() or not witness.customer_seen
            or witness.customer_id!=str(customer_id) or witness.violation):
        raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED')
    witness.customer_ready=True


def current(session,cap):
    """Opaque internal witness: customer held before every consistent read."""
    witness=_ACTIVE.get();session=_session(session)
    if (witness is None or witness.session is not session or witness.scope!=_scope(cap)
            or witness.transaction is not session.get_transaction() or not witness.customer_ready
            or witness.violation):
        raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED')
    return witness
