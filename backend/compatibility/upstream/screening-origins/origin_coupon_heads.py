"""Other-origin scope for the existing shared coupon mutation-head protocol.

No CSV/Node capability is accepted or manufactured. The original authenticated
command and owned source Frame supply the customer/nonce. Historical rows are
never read. Locks are late: native Order writes precede their trigger/head locks.
"""
import copy
import hashlib
from contextlib import contextmanager
from sqlalchemy import event,text
from native import one
from sqlalchemy.orm import Session
from sqlalchemy.pool import Pool
from origin_contracts import unsafe
from origin_coupon_contracts import check_command
from benefit_history_heads import NativeCouponHistoryHeads,_heads,_public_heads,_revision

INFO='_origin_coupon_head_scope'


def reject():unsafe('SCREENING_ORIGIN_COUPON_HEAD_CHANGED')


class OriginCouponHeads:
    def __init__(self,history_source_key):self.native=NativeCouponHistoryHeads(history_source_key)
    def policy(self,session):
        # Root's common qualifier verifies its exact fixed definer function,
        # source4 trigger owner and each separate locked participant owner.
        # No source caller/publisher needs TRIGGER or a copied trigger body.
        from origin_history_privileges import qualified_head_metadata
        metadata=qualified_head_metadata(session);manifest=self.native.assert_ready()
        actual=metadata.get('couponTriggers')
        if not isinstance(actual,list) or len(actual)!=10:reject()
        expected=manifest['definitions']
        if len({row['name'] for row in actual})!=10:reject()
        for row in actual:
            if not isinstance(row,dict) or set(row)!={'name','tableName','event','timing','hash','definer','sqlMode'}:reject()
            match=[item for item in expected if item['name']==row['name']]
            if (len(match)!=1 or any(row[name]!=match[0][key] for name,key in (('tableName','table'),('event','event'),('timing','timing')))
                    or row['hash']!=hashlib.sha256(match[0]['statement'].encode()).hexdigest()
                    or not {'STRICT_TRANS_TABLES','STRICT_ALL_TABLES'}.intersection(row['sqlMode'].split(','))):reject()
        policy=metadata.get('policy')
        if not isinstance(policy,dict) or set(policy)!={'contract','metadataHash','qualifierHash'}:reject()
        return policy
    def _identity(self,session):
        self.policy(session)
        native=one(session,'SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema')
        return {'writersContract':self.native.assert_ready()['writersContract'],
                'writersDefinitionHash':self.native.assert_ready()['definitionHash'],**native}
    def capture(self,session,customer_id,coupon_id):
        return {**self._identity(session),
                'heads':_public_heads(_heads(session,{'customerId':customer_id,'couponId':coupon_id}))}
    @contextmanager
    def scope(self,frame,selections):
        from origin_frame import CURRENT_ORIGIN
        session=frame.session
        if (CURRENT_ORIGIN.get() is not frame or not isinstance(session,Session) or not session.in_transaction()
                or INFO in session.info or session.connection().get_isolation_level()!='READ COMMITTED'):reject()
        check_command(session,frame.value,frame.owner.key)
        connection=session.connection()
        if connection.execute(text('SELECT @pos_rewrite_coupon_history_owner')).scalar_one() is not None:
            connection.invalidate();reject()
        scope=HeadScope(self,frame,selections)
        for selection in selections:
            if self.capture(session,frame.value['customerId'],selection['couponId'])!=selection['witness']:reject()
        session.info[INFO]=scope;connection.info[INFO]=scope
        event.listen(connection,'commit',scope.commit_guard)
        try:
            connection.execute(text('SET @pos_rewrite_coupon_history_owner=:owner'),{'owner':frame.value['id']})
            yield scope
            if scope.validated is None:reject()
        finally:
            try:
                connection.execute(text('SET @pos_rewrite_coupon_history_owner=NULL'));scope.cleaned=True
            except BaseException:
                connection.invalidate();raise


class HeadScope:
    def __init__(self,port,frame,selections):
        self.port,self.frame=port,frame;self.session=frame.session;self.connection=self.session.connection()
        self.transaction=self.session.get_transaction();self.selections=copy.deepcopy(selections)
        self.validated=None;self.cleaned=False;self.commit_guard=self._commit
    def validate(self):
        if self.validated is not None:return
        result=[]
        for selection in self.selections:
            scope={'customerId':self.frame.value['customerId'],'couponId':selection['couponId']}
            current=_heads(self.session,scope,lock=True)
            if self.port._identity(self.session)!={key:selection['witness'][key] for key in ('writersContract','writersDefinitionHash','serverUuid','sourceSchema')}:reject()
            for row,old in zip(current,selection['witness']['heads']):
                revision,initial=_revision(row['revision']),_revision(old['revision'])
                if row['owner']==self.frame.value['id']:
                    if row['start'] is None or _revision(row['start'])!=initial or revision<=initial:reject()
                elif revision!=initial:reject()
            result.append((scope,current))
        self.validated=result
    def _commit(self,connection):
        try:
            from transaction import CURRENT
            if (connection is not self.connection or not self.cleaned or self.validated is None or CURRENT.get() is not None
                    or self.session.get_transaction() is not self.transaction or self.session.new or self.session.dirty or self.session.deleted):reject()
            for selection in self.selections:
                if self.port.policy(connection)!=selection['originHistoryPolicy']:reject()
            for scope,expected in self.validated:
                if _heads(connection,scope,lock=True)!=expected:reject()
        except BaseException:
            connection.invalidate();raise


def ended(session,transaction):
    scope=session.info.get(INFO)
    if isinstance(scope,HeadScope) and scope.transaction is transaction:
        session.info.pop(INFO,None)
        if event.contains(scope.connection,'commit',scope.commit_guard):event.remove(scope.connection,'commit',scope.commit_guard)
        if not scope.cleaned:scope.connection.invalidate()


def returned(_connection,record):
    scope=record.info.pop(INFO,None)
    if isinstance(scope,HeadScope) and not scope.cleaned:record.invalidate()


event.listen(Session,'after_transaction_end',ended)
event.listen(Pool,'checkin',returned)
