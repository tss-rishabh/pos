"""Arbitrary native coupon-ID controls for the independent generic publisher.

No command/customer/history/order work. The response is the shared generic
control descriptor, with an additional authenticated origin-head policy in its
opaque configuration hash. It does not confer CSV/Node/customer authority.
"""
import hmac
import json
import re
from contextlib import contextmanager
from datetime import datetime,timedelta,timezone
from uuid import UUID,uuid4
from sqlalchemy import event,text
from origin_contracts import unsafe
from native import one
from origin_coupon_source import Probe,settings_namespace,CONFIG_KEYS
from origin_coupon_cache import SnapshotCache
from benefit_controls import CurrentConfigurationCache
from benefit_source import compile_coupon
from benefit_history import seal
from benefit_receipts import COUPON_CONTROL
from benefit_history_heads import _heads,_public_heads

CONTRACT='pos-screening-origin-coupon-controls-v1'
PREFIX='/internal/screening-origins/coupons/controls/'


@contextmanager
def readonly(session):
    if session.in_transaction():unsafe('SCREENING_ORIGIN_COUPON_SQL_SCOPE')
    connection=session.connection(execution_options={'isolation_level':'REPEATABLE READ'})
    started=[False]
    def observe(_connection,_cursor,statement,_params,_context,_many):
        compact=' '.join(statement.split()).upper()
        if not started[0] and compact=='SET TRANSACTION READ ONLY':started[0]=True;return
        if not started[0] or not (compact.startswith('SELECT ') or compact=='SHOW GRANTS FOR CURRENT_USER()' or re.fullmatch(r'SHOW CREATE TABLE `[A-Z0-9_]+`',compact)):unsafe('SCREENING_ORIGIN_COUPON_SQL_SCOPE')
    event.listen(connection,'before_cursor_execute',observe)
    try:
        session.execute(text('SET TRANSACTION READ ONLY'))
        with session.no_autoflush:yield
    finally:
        event.remove(connection,'before_cursor_execute',observe);session.rollback()


class OriginCouponControls:
    def __init__(self,sessions,coupons):self.sessions,self.coupons=sessions,coupons
    def read(self,coupon_id):
        if not isinstance(coupon_id,str) or not re.fullmatch(r'[1-9][0-9]{0,9}',coupon_id) or int(coupon_id)>2147483647:unsafe('SCREENING_ORIGIN_COUPON_CONTROLS_INVALID')
        # Real cache reads precede all SQL. There is deliberately no birthday
        # customer guard or source/customer operation in this background API.
        raw={}
        for name in CONFIG_KEYS:
            if self.coupons.source_cache.exists(name):
                value=self.coupons.source_cache.get(name)
                if isinstance(value,bytes):value=value.decode('utf-8')
                if not isinstance(value,str) or len(value.encode())>16000:unsafe('SCREENING_ORIGIN_COUPON_CONTROLS_INVALID')
                raw[name]=value
        cache=CurrentConfigurationCache(SnapshotCache(raw))
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        with self.sessions() as session,readonly(session):
            reader=Probe(session,None);point=self.coupons._point()
            ns=compile_coupon(self.coupons.root,settings_namespace(self.coupons.coupon_settings,point,reader,cache,ValidationException,ItemTypes,lambda *_a:False))
            ns['get_auto_apply_coupon'](reader);ns['get_birthday_coupon_details'](reader)
            native=one(session,'SELECT '+COUPON_CONTROL+' AS native_hash FROM coupons WHERE id=:id LIMIT 2',{'id':coupon_id})
            policy=self.coupons.heads.policy(session);identity=self.coupons.heads._identity(session)
            heads=_public_heads(_heads(session,{'couponId':coupon_id},controls_only=True))
            observed=self.coupons.clock();zone=self.coupons.zone
            from zoneinfo import ZoneInfo
            end=int(datetime.combine(point.date()+timedelta(days=1),datetime.min.time(),tzinfo=ZoneInfo(zone)).timestamp()*1000)
            data={'contract':'pos-csv-coupon-generation-controls-v1','couponId':coupon_id,
                'configurationHash':seal('coupon-configuration',{'cache':cache.values,'settings':self.coupons.coupon_settings,'couponInputHash':native['native_hash'],'originHistoryPolicy':policy},self.coupons.history_key),
                'couponInputHash':native['native_hash'],'sourceTimeZone':zone,'sourceDay':point.strftime('%Y-%m-%d'),
                'sourceAsOf':point.strftime('%Y-%m-%d %H:%M:%S'),**identity,'heads':heads,'observedAt':observed,'expiresAt':min(observed+60000,end)}
            return {'data':data,'proofHash':seal('coupon-generation-config',data,self.coupons.history_key)}


def private_application(resource,key,emit_stream,fallback=None):
    if not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):unsafe('SCREENING_ORIGIN_COUPON_CONTROLS_CONFIGURATION')
    if key in (resource.coupons.key,resource.coupons.history_key):unsafe('SCREENING_ORIGIN_COUPON_CONTROLS_CONFIGURATION')
    def application(environ,start_response):
        path=environ.get('PATH_INFO','')
        if not path.startswith(PREFIX) and fallback is not None:return fallback(environ,start_response)
        try:
            request_id=str(UUID(environ.get('HTTP_X_REQUEST_ID','')))
        except (ValueError,TypeError,AttributeError):request_id=str(uuid4())
        status,code='503 Service Unavailable','SCREENING_ORIGIN_COUPON_CONTROLS_UNAVAILABLE'
        try:
            supplied=environ.get('HTTP_X_POS_ORIGIN_COUPON_CONTROLS_KEY')
            if not isinstance(supplied,str) or not hmac.compare_digest(key,supplied):
                status,code='401 Unauthorized','SCREENING_ORIGIN_COUPON_CONTROLS_UNAUTHORIZED';raise ValueError()
            coupon_id=path[len(PREFIX):]
            if (environ.get('REQUEST_METHOD')!='GET' or environ.get('QUERY_STRING')
                    or environ.get('CONTENT_LENGTH','0') not in ('','0') or not re.fullmatch(r'[1-9][0-9]{0,9}',coupon_id)):
                status,code='400 Bad Request','SCREENING_ORIGIN_COUPON_CONTROLS_INVALID';raise ValueError()
            body=json.dumps(resource.read(coupon_id),separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
            if len(body)>16000:raise ValueError()
            status='200 OK'
        except Exception:body=json.dumps({'code':code},separators=(',',':')).encode()
        event={'timestamp':datetime.now(timezone.utc).isoformat(),'module':'screening-origins','resource':'coupon-controls',
            'eventId':'screening-origins.coupon-controls.'+('read' if status=='200 OK' else 'review'),
            'eventInstanceId':str(uuid4()),'requestId':request_id,'userId':None}
        try:emit_stream.write(json.dumps(event,separators=(',',':'))+'\n');emit_stream.flush()
        except Exception:pass
        start_response(status,[('Content-Type','application/json'),('Cache-Control','private, no-store'),('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff'),('X-Request-ID',request_id)])
        return [body]
    return application
