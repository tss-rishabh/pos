"""Postcommit original source effects. No financial completion is inferred here."""
import hashlib
import hmac
import json
import re
import time
from types import SimpleNamespace
from sqlalchemy import text
from creation import read_creation,creation_hash
from native_authority import rows,one,value_json
from writer_protocol import fail
from protocol import digest,canonical
from screening_profile import checked_state
from receiver import open_effects,Receiver
from effects import prepared_calls,publish_once
from transaction import CURRENT

FIELDS={'contract','operationId','creationHash','orderId','customerId','storeId','counterId','paymentReceiptId','projectionHash','lineHash','completedAt'}


def _hint(sessions,operation,key):
    with sessions() as session:
        row=one(session,'SELECT data,proof_hash FROM pos_rewrite_public_screening_orders WHERE operation_id=:id AND OCTET_LENGTH(data)<=16000',{'id':operation})
        value=value_json(row['data'])
        if value.get('operationId')!=operation or not hmac.compare_digest(creation_hash(key,value),row['proof_hash']):fail()
        return value


def _prefix(session,hint):
    # Original immutable obligation, not a new sale. Archive does not authorize
    # a different scope or erase a committed paid order's existing obligation.
    rows(session,'SELECT id FROM pos_user WHERE id=:id FOR SHARE',{'id':hint['actorId']},1)
    rows(session,'SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id=:id FOR SHARE',{'id':hint['actorId']},1)
    one(session,'SELECT id FROM stores WHERE id=:id FOR UPDATE',{'id':hint['storeId']})
    one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':hint['customerId']})


def _completed(session,hint,key):
    creation=read_creation(session,hint['operationId'],key,hint)
    if creation!=hint:fail()
    reservation=checked_state(one(session,'SELECT * FROM pos_rewrite_import_screening_reservations WHERE operation_id=:id FOR UPDATE',{'id':hint['operationId']}),key)
    row=one(session,'SELECT order_id,data,proof_hash FROM pos_rewrite_public_screening_completions WHERE operation_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':hint['operationId']})
    value=value_json(row['data'])
    if (not isinstance(value,dict) or set(value)!=FIELDS or value['contract']!='pos-node-screening-completion-v1' or
        value['creationHash']!=creation_hash(key,creation) or str(row['order_id'])!=creation['orderId'] or
        any(value[name]!=creation[name] for name in ('operationId','orderId','customerId','storeId','counterId')) or
        not isinstance(value['paymentReceiptId'],str) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,128}',value['paymentReceiptId']) or
        type(value['completedAt']) is not int or not creation['createdAt']<=value['completedAt']<=9007199254740991 or
        not all(isinstance(value[name],str) and re.fullmatch(r'[a-f0-9]{64}',value[name]) for name in ('projectionHash','lineHash')) or
        not hmac.compare_digest(digest(key,'public-screening-completion',value),row['proof_hash']) or
        reservation['kind']!='pos' or reservation['phase']!='COUNTED' or reservation['completionHash']!=row['proof_hash']):fail('SCREENING_COMPLETION_PROOF_REQUIRED')
    projection=one(session,'SELECT store_id,counter_id,user_id,input_hash FROM pos_rewrite_checkout_projections WHERE order_id=:id FOR SHARE',{'id':creation['orderId']})
    if (str(projection['store_id'])!=creation['storeId'] or str(projection['counter_id'])!=creation['counterId'] or
        str(projection['user_id'])!=creation['customerId'] or projection['input_hash']!=value['projectionHash']):fail()
    lines=rows(session,'SELECT has_product_id,product_id,quantity,input_hash FROM pos_rewrite_checkout_projection_lines WHERE order_id=:id ORDER BY has_product_id',{'id':creation['orderId']},1000)
    if not lines or hashlib.sha256('\n'.join(f"{row['has_product_id']}:{row['product_id']}:{row['quantity']}:{row['input_hash']}" for row in lines).encode()).hexdigest()!=value['lineHash']:fail()
    return creation


def publish(sessions,operation,key,tasks,clock=None):
    """At most one dispatch. Processing/uncertain is never resumed or resent."""
    now=clock or (lambda:int(time.time()*1000))
    if CURRENT.get() is not None:fail('SCREENING_PUBLICATION_SCOPE_INVALID')
    Receiver.assert_publisher(SimpleNamespace(pipeline=SimpleNamespace(tasks=tasks)))
    hint=_hint(sessions,operation,key)
    # Router/publisher configuration is not assumed pure. Validate original
    # intents outside every SQL transaction, then compare the retained hash
    # again under the current native claim below.
    with sessions() as session:
        staged=one(session,'SELECT payload,effects_hash FROM pos_rewrite_public_screening_effects WHERE operation_id=:id',{'id':operation})
        if staged['effects_hash']!=hint['effectsHash']:fail()
        intents=open_effects(key,'public-screening:'+operation,staged['payload'],staged['effects_hash'])
    for intent in intents:prepared_calls(tasks,intent)
    with sessions() as session:
        with session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _prefix(session,hint)
            creation=_completed(session,hint,key)
            effect=one(session,'SELECT payload,effects_hash,status,deliveries FROM pos_rewrite_public_screening_effects WHERE operation_id=:id FOR UPDATE',{'id':operation})
            if effect['effects_hash']!=creation['effectsHash']:fail()
            if effect['status']!='pending':return {'status':effect['status']}
            if value_json(effect['deliveries'])!=[]:fail()
            session.execute(text("UPDATE pos_rewrite_public_screening_effects SET status='processing',updated_at_ms=:now WHERE operation_id=:id"),{'id':operation,'now':now()})
    # No native session/locks remain while publishing original source canvases.
    deliveries=[];status='accepted'
    try:
        for intent in intents:deliveries.append(publish_once(tasks,intent))
    except Exception:status='uncertain'
    with sessions() as session:
        with session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _prefix(session,hint)
            one(session,'SELECT order_id FROM pos_rewrite_public_screening_orders WHERE operation_id=:id FOR SHARE',{'id':operation})
            session.execute(text("UPDATE pos_rewrite_public_screening_effects SET status=:status,deliveries=:deliveries,updated_at_ms=:now WHERE operation_id=:id AND status='processing'"),
                {'id':operation,'status':status,'deliveries':canonical(deliveries),'now':now()})
    return {'status':status,'deliveries':deliveries}
