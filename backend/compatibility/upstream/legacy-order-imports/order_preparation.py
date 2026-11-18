"""Rollback-only source preview. No order, absence or payment proof is minted.

This purpose runs before an order nonce exists. Only a current Node-owned
RUNNING preparation lease authorizes it; source cannot create/renew that lease.
"""
from contextlib import contextmanager,nullcontext
from copy import deepcopy
from datetime import datetime
import os
import re
from zoneinfo import ZoneInfo
from sqlalchemy import event

from protocol import PREPARATION_CONTRACT,ImportReview,digest,verify_preparation
from native import one,rows,json_value,fresh_authority
from screening_transaction import owned,mark_customer
from transaction import private_session,VIOLATION
from effects import CAPTURE
from tracing import TRUSTED_ACTOR
from membership_handoff import CURRENT_HISTORY,PreparedMembershipHistory,prepared_history
from membership_history import request
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent/'benefit-profile'))
from benefit_controls import NeedCouponHistory
from coupon_handoff import prepared_coupon_history


class NeedHistory(BaseException):
    """Bypass source `except Exception` fallbacks without permitting more SQL."""
    def __init__(self,scope):self.scope=deepcopy(scope)


class HistoryProbe(PreparedMembershipHistory):
    def __init__(self,clock,zone,cap,point_factory=None):
        self.clock=clock
        self.zone=zone;self.point_factory=point_factory;self._point=None
        self.expected={'contract':'pos-csv-membership-history-v1','operationId':cap['operationId'],
            'requestHash':cap['requestHash'],'planHash':cap['planHash'],'customerId':cap['authority']['customerId']}

    @property
    def point(self):
        if self._point is None:
            expected=datetime.fromtimestamp(self.clock()/1000,ZoneInfo(self.zone)).replace(tzinfo=None)
            point=self.point_factory() if self.point_factory is not None else expected
            if (not isinstance(point,datetime) or point.tzinfo is not None
                    or abs((point-expected).total_seconds())>=1):
                raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CLOCK_INVALID')
            self._point=point.replace(microsecond=0)
        return self._point

    def execution_clock(self,state):
        expected=request(state,self.point)
        if any(expected[name]!=value for name,value in self.expected.items()):
            raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
        return self.point

    def read(self,scope):
        if any(scope[name]!=value for name,value in self.expected.items()):
            raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
        raise NeedHistory(scope)


class _Rollback(BaseException):
    def __init__(self,result):self.result=result


def lock_preparation(session,cap,now):
    operation=one(session,"SELECT actor_id,store_id,counter_id,request_hash,plan_hash,namespace,state FROM pos_rewrite_import_financial_operations WHERE id=:id AND OCTET_LENGTH(state)<=16000 FOR SHARE",{'id':cap['operationId']})
    state=json_value(operation['state'])
    if (any(str(operation[column])!=cap['scope'][name] for name,column in
            (('actorId','actor_id'),('storeId','store_id'),('counterId','counter_id')))
            or operation['request_hash']!=cap['requestHash'] or operation['plan_hash']!=cap['planHash']
            or operation['namespace']!=cap['namespace'] or state.get('scope')!=cap['scope']
            or state.get('authority')!=cap['authority'] or state.get('preparationContract')!=PREPARATION_CONTRACT
            or state.get('benefitContracts')!=cap.get('benefitContracts')
            or state.get('status')!='running' or state.get('orderId') is not None):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    # Unfiltered latest sequence: a stale RUNNING row cannot outlive replacement.
    row=one(session,"SELECT id,sequence_no,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END AS data FROM pos_rewrite_import_financial_preparations WHERE operation_id=:op ORDER BY sequence_no DESC LIMIT 1 FOR SHARE",{'op':cap['operationId']})
    data=json_value(row['data'])
    if (not isinstance(data,dict) or row['id']!=cap['attemptId'] or data.get('id')!=cap['attemptId']
            or data.get('contract')!=PREPARATION_CONTRACT or data.get('scope')!=cap['scope']
            or data.get('planHash')!=cap['planHash'] or data.get('requestHash')!=cap['requestHash']
            or data.get('authorityHash')!=cap['authorityHash'] or data.get('phase')!='RUNNING'
            or not isinstance(data.get('ownerHash'),str) or not re.fullmatch(r'[a-f0-9]{64}',data['ownerHash'])
            or data.get('sequence')!=row['sequence_no'] or data.get('expiresAt')!=cap['attemptExpiresAt']
            or type(data.get('expiresAt')) is not int or data['expiresAt']<=now):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    if rows(session,'SELECT kind FROM pos_rewrite_import_financial_stages WHERE operation_id=:op FOR SHARE',{'op':cap['operationId']},6):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    if (rows(session,'SELECT kind FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:op LIMIT 1 FOR SHARE',{'op':cap['operationId']},2)
            or rows(session,'SELECT order_id FROM pos_rewrite_import_financial_order_bindings WHERE operation_id=:op LIMIT 1 FOR SHARE',{'op':cap['operationId']},2)):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    queue=data.get('queue')
    if queue is not None:
        if not isinstance(queue,dict) or set(queue)!={'jobId','claimToken'}:
            raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
        job=one(session,"SELECT actor_id,state,claim_token,TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',lease_until) DIV 1000 AS lease_ms FROM pos_rewrite_legacy_order_imports WHERE id=:id FOR SHARE",{'id':queue['jobId']})
        row=one(session,'SELECT store_id,counter_id,state FROM pos_rewrite_legacy_order_import_rows WHERE job_id=:job AND operation_id=:op FOR SHARE',{'job':queue['jobId'],'op':cap['operationId']})
        if (str(job['actor_id'])!=cap['scope']['actorId'] or job['state']!='RUNNING'
                or job['claim_token']!=queue['claimToken'] or job['lease_ms'] is None or job['lease_ms']<=now
                or row['state']!='STARTING' or str(row['store_id'])!=cap['scope']['storeId']
                or str(row['counter_id'])!=cap['scope']['counterId']):
            raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    return state


# Closed metadata probes used by the full native-head qualifier. These expose
# physical definitions/privileges, never historical business rows or a write.
_METADATA_TABLES = (
    'orders', 'users', 'has_products', 'order_coupon_log', 'coupons',
    'spiderman_screening_orders',
    'pos_rewrite_screening_origin_history_heads',
    'pos_rewrite_screening_origin_history_changes',
    'pos_rewrite_membership_history_heads', 'pos_rewrite_coupon_history_heads',
    'user_eav', 'pos_rewrite_membership_versions',
    'pos_rewrite_screening_counter_heads', 'pos_rewrite_screening_counters',
    'pos_rewrite_screening_contributions',
)
_METADATA_TABLE = '(?:' + '|'.join(re.escape(name) for name in _METADATA_TABLES) + ')'
_METADATA_TARGET = '(?:`' + _METADATA_TABLE + r'`|`sys`\.`sys_config`)'


def _preparation_metadata_statement(statement):
    return (statement == 'SHOW GRANTS FOR CURRENT_USER()'
            or re.fullmatch(r'SELECT 1 FROM ' + _METADATA_TARGET + r' WHERE FALSE', statement) is not None
            or re.fullmatch(r'SHOW CREATE TABLE ' + _METADATA_TARGET, statement) is not None)


@contextmanager
def read_only_source(session):
    """Allow locking/current SELECTs, never a business write or native COMMIT."""
    connection=session.connection()
    def statement(_connection,_cursor,sql,_parameters,_context,_many):
        compact=re.sub(r'/\*.*?\*/',' ',sql,flags=re.S).strip()
        if _preparation_metadata_statement(sql.strip()):return
        if not re.match(r'^SELECT\b',compact,re.I):
            VIOLATION.set(True)
            raise ImportReview('ORDER_IMPORT_PREPARATION_WRITE_BLOCKED')
        metadata_only=re.fullmatch(r'SELECT id FROM (?:orders|order_coupon_log) LIMIT 0',compact,re.I)
        if not metadata_only and re.search(r'\b(?:FROM|JOIN)\s+(?:`?[a-z_]+`?\.)?`?(?:orders|has_products|order_coupon_log)`?\b',compact,re.I):
            VIOLATION.set(True)
            raise ImportReview('ORDER_IMPORT_PREPARATION_HISTORY_UNQUALIFIED')
    def flush(current,*_args):
        if current.new or current.dirty or current.deleted:
            VIOLATION.set(True)
            raise ImportReview('ORDER_IMPORT_PREPARATION_WRITE_BLOCKED')
    def commit(*_args):
        VIOLATION.set(True)
        raise ImportReview('ORDER_IMPORT_PREPARATION_WRITE_BLOCKED')
    event.listen(connection,'before_cursor_execute',statement)
    event.listen(session,'before_flush',flush)
    event.listen(session,'before_commit',commit)
    try:yield
    finally:
        event.remove(connection,'before_cursor_execute',statement)
        event.remove(session,'before_flush',flush)
        event.remove(session,'before_commit',commit)


def prepare(receiver,operation_id,body):
    if (os.environ.get('POS_LEGACY_IMPORT_PREPARATION_CONTRACT')!=PREPARATION_CONTRACT
            or not isinstance(body,dict) or not {'capability','plan'}.issubset(body)
            or set(body)-{'capability','plan','membershipHistory','couponHistory'}):
        raise ImportReview('ORDER_IMPORT_PREPARATION_UNAVAILABLE')
    plan=body['plan'];cap=verify_preparation(receiver.auth_key,body['capability'],operation_id,plan,receiver.clock())
    if ('membershipHistory' in body)!=('membershipHistoryHash' in cap):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    if ('couponHistory' in body)!=('couponHistoryHash' in cap):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    TRUSTED_ACTOR.set(cap['scope']['actorId'])
    history=body.get('membershipHistory')
    history_key=os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY','')
    ids=[]
    if history is not None:
        from membership_profile import selected
        import json
        try:
            ids=json.loads(os.environ.get('POS_MEMBERSHIP_PRODUCT_IDS','[]'))
            if (not selected() or history_key in (receiver.auth_key,receiver.proof_key)
                    or not isinstance(ids,list) or not 1<=len(ids)<=1000 or len(set(ids))!=len(ids)
                    or any(not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]{0,18}',value)
                           or int(value)>9223372036854775807 for value in ids)):
                raise ValueError()
        except Exception:raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID') from None
    # Validate/copy any document before SQL, then enter one invocation-local scope.
    coupon_key=os.environ.get('POS_LEGACY_IMPORT_COUPON_HISTORY_KEY','')
    guard_key=os.environ.get('POS_LEGACY_IMPORT_COUPON_GUARD_KEY','')
    if 'couponHistory' in body and (body['couponHistory'] is None or coupon_key==history_key and history_key):
        raise ImportReview('ORDER_IMPORT_PREPARATION_INVALID')
    with prepared_history(history,cap,receiver.auth_key,history_key,ids,receiver.zone,receiver.clock), prepared_coupon_history(
            body.get('couponHistory'),cap,receiver.auth_key,coupon_key,receiver.proof_key,guard_key,receiver.zone,receiver.clock):
        probe_token=None
        if history is None:
            probe_token=CURRENT_HISTORY.set(HistoryProbe(receiver.clock,receiver.zone,cap,
                receiver.pipeline.membership_execution_point))
        try:
            try:
                with receiver.session_factory() as session:
                    with owned(session,cap):
                        state=lock_preparation(session,cap,receiver.clock())
                        user=fresh_authority(session,cap)
                        mark_customer(session,cap,str(user['id']))
                        from receiver import assert_period,assert_source_customer,source_user
                        assert_period(session,cap,plan,receiver.clock(),receiver.zone,
                                      'historical-correction' if state.get('correction') is not None else None)
                        assert_source_customer(session,cap,plan)
                        member=rows(session,"SELECT entity FROM user_eav WHERE entity=:email AND attribute='EXCLUSIVE_MEMBER' AND is_active=1 LIMIT 1 FOR SHARE",{'email':user['email']},2)
                        user=source_user(user,cap['authority']['customerId'],bool(member))
                        from source_runtime import UNSAFE_HTTP
                        effects=[];token=CAPTURE.set(effects);http_token=UNSAFE_HTTP.set(False)
                        outcome='ready';scope=None;coupon_scope=None;coupon_witness=None
                        try:
                            # A specialized current financial-counter adapter
                            # may establish its opaque replay witness here. It
                            # must not weaken the following SELECT-only/history
                            # guards or create a financial order checkpoint.
                            prepare_scope=getattr(receiver.pipeline,'preparation_scope',None)
                            with (prepare_scope(session,user,plan,cap) if prepare_scope is not None else nullcontext()), read_only_source(session),private_session(session) as source:
                                try:receiver.pipeline.preparation_pipeline(source,user,plan,cap)
                                except NeedHistory as required:
                                    outcome='need-history';scope=required.scope
                                except NeedCouponHistory as required:
                                    outcome='need-coupon-history';coupon_scope=required.scope;coupon_witness=required.witness
                                if UNSAFE_HTTP.get():
                                    raise ImportReview('ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED')
                        finally:
                            CAPTURE.reset(token)
                            UNSAFE_HTTP.reset(http_token)
                        verify_preparation(receiver.auth_key,body['capability'],operation_id,plan,receiver.clock())
                        result={name:cap[name] for name in ('operationId','attemptId','requestHash','planHash','scope','authorityHash','planDigest','attemptExpiresAt')}
                        result.update(contract=PREPARATION_CONTRACT,purpose='source-cart-preview-result',
                            outcome=outcome,historyScope=scope,sourceTimeZone=receiver.zone,
                            membershipHistoryHash=cap.get('membershipHistoryHash'),
                            issuedAt=receiver.clock(),expiresAt=cap['expiresAt'])
                        if 'benefitContracts' in cap:
                            result['benefitContracts']=deepcopy(cap['benefitContracts'])
                            if cap['benefitContracts'].get('automaticCoupon'):
                                result['couponHistoryHash']=cap.get('couponHistoryHash')
                        if coupon_scope is not None:
                            result.update(couponHistoryScope=coupon_scope,couponHistoryWitness=coupon_witness)
                        # Throw through owned/session.begin even for ready: COMMIT
                        # is never reached, and no source receipt/effect is stored.
                        raise _Rollback(result)
            except _Rollback as completed:
                result=completed.result
                if result['outcome']=='need-coupon-history':
                    # Actual legacy Redis observation happens only AFTER the
                    # owned source transaction has rolled back and closed.
                    benefits=getattr(receiver.pipeline,'benefits',None)
                    if benefits is None:raise ImportReview('ORDER_IMPORT_BIRTHDAY_GUARD_UNQUALIFIED')
                    result['birthdayObservation']=benefits.guard_observation(result['couponHistoryScope'])
                    verify_preparation(receiver.auth_key,body['capability'],operation_id,plan,receiver.clock())
                    result['issuedAt']=receiver.clock()
                return {**result,'signature':digest(receiver.proof_key,'preparation-result',result)}
        finally:
            if probe_token is not None:CURRENT_HISTORY.reset(probe_token)
