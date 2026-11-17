"""One private writer transaction, including nested commits in the pinned source."""
from contextvars import ContextVar
from contextlib import contextmanager
from sqlalchemy import text,null
from sqlalchemy.engine import Connection
import re
from protocol import ImportReview

CURRENT = ContextVar('pos_private_import_transaction', default=None)
VIOLATION=ContextVar('pos_private_import_violation',default=False)


class LegacyRow:
    def __init__(self,row):self.value=dict(row._mapping) if hasattr(row,'_mapping') else dict(row)
    def __getitem__(self,key):return tuple(self.value.values())[key] if type(key) is int else self.value[key]
    def __iter__(self):return iter(self.value.values())
    def __len__(self):return len(self.value)
    def keys(self):return self.value.keys()
    def items(self):return self.value.items()
    def get(self,key,default=None):return self.value.get(key,default)
    @property
    def _mapping(self):return self.value
    def __getattr__(self,key):
        try:return self.value[key]
        except KeyError:raise AttributeError(key) from None


class LegacyResult:
    def __init__(self,result):self.result=result
    def fetchone(self):
        row=self.result.fetchone();return None if row is None else LegacyRow(row)
    def first(self):
        row=self.result.first();return None if row is None else LegacyRow(row)
    def fetchall(self):return [LegacyRow(row) for row in self.result.fetchall()]
    def fetchmany(self,size=None):return [LegacyRow(row) for row in self.result.fetchmany(size)]
    def all(self):return self.fetchall()
    def __iter__(self):return (LegacyRow(row) for row in self.result)
    def __getattr__(self,name):return getattr(self.result,name)


class TransactionSession:
    def __init__(self, session):
        self.session = session

    def execute(self, statement, parameters=None, **kwargs):
        if 'params' in kwargs:
            if parameters is not None:raise ImportReview('ORDER_IMPORT_UNQUALIFIED_SQL')
            parameters=kwargs.pop('params')
        if isinstance(statement,str):
            normalized=statement.lstrip()
            if (not re.match(r'^(SELECT|INSERT|UPDATE|DELETE)\b',normalized,re.I) or
                re.search(r'\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?(?:cart_items|cart_meta|carts|cart_details)`?\b',normalized,re.I)):
                VIOLATION.set(True)
                raise ImportReview('ORDER_IMPORT_UNQUALIFIED_SQL')
            statement = text(statement)
        return LegacyResult(self.session.execute(statement,parameters or {},**kwargs))

    def commit(self):
        self.session.flush()

    def rollback(self):
        # A swallowed legacy rollback must not reset the operation lock and let
        # later statements escape the caller's transaction.
        raise ImportReview('ORDER_IMPORT_SOURCE_ROLLBACK')

    def close(self):
        return None

    def remove(self):
        return None

    def __getattr__(self,name):
        return getattr(self.session,name)


class PrivateSessionProxy:
    """Replace original scoped-session exports BEFORE importing controllers."""
    def __call__(self):
        return self.current()

    def current(self):
        value = CURRENT.get()
        if value is None:
            raise ImportReview('ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')
        return value

    def __getattr__(self,name):
        return getattr(self.current(),name)


@contextmanager
def private_session(session):
    if CURRENT.get() is not None:
        raise ImportReview('ORDER_IMPORT_NESTED_TRANSACTION')
    token = CURRENT.set(TransactionSession(session))
    violation=VIOLATION.set(False)
    try:
        yield CURRENT.get()
        if VIOLATION.get():raise ImportReview('ORDER_IMPORT_UNQUALIFIED_SQL')
    finally:
        CURRENT.reset(token)
        VIOLATION.reset(violation)


def normalize_source_sentinels(session, _flush_context, _instances):
    if CURRENT.get() is None:
        return
    for model in list(session.new):
        if getattr(model,'__tablename__',None) in {'cart_items','cart_meta','carts','cart_details'}:
            VIOLATION.set(True)
            raise ImportReview('ORDER_IMPORT_PRIVATE_CART_REQUIRED')
        if getattr(model,'__tablename__',None) != 'orders':
            continue
        # Same reviewed schema profile as Node cash import; no financial field
        # or SQL mode is changed. Unsupported physical DDL remains fail closed.
        for field in ('ship_date','ret_ex_request_date','pg_disc_platform'):
            if getattr(model,field,None) in ('',None):
                # SQLAlchemy reapplies a scalar default for explicit None.
                # sql.null() emits the reviewed native NULL without a zero date.
                setattr(model,field,null())
        if getattr(model,'courier',None) == '':
            model.courier = 0


def guard_private_statement(_connection,_cursor,statement,_parameters,_context,_many):
    if CURRENT.get() is None:
        return
    statement=re.sub(r'/\*.*?\*/',' ',statement,flags=re.S)
    if (re.match(r'^\s*(?:CALL|ALTER|CREATE|DROP|TRUNCATE|COMMIT|SET|GRANT|REVOKE|LOAD)\b',statement,re.I) or
        re.search(r'\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?(?:cart_items|cart_meta|carts|cart_details)`?\b',statement,re.I)):
        VIOLATION.set(True)
        raise ImportReview('ORDER_IMPORT_UNQUALIFIED_SQL')


def guard_private_commit(connection):
    """Bind to Engine.commit: SAVEPOINT release is not an outer commit."""
    if CURRENT.get() is not None:
        VIOLATION.set(True)
        # A rejected commit event can leave SQLAlchemy's root transaction
        # inactive before rollback. Discard the physical transaction instead
        # of returning its uncommitted changes or session variables to a pool.
        if isinstance(connection,Connection) and not connection.closed and not connection.invalidated:
            connection.invalidate()
        raise ImportReview('ORDER_IMPORT_SOURCE_COMMIT_ESCAPED')
