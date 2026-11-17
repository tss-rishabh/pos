"""Original source effects, durably captured before the source COMMIT.

Payloads are encrypted; workers receive command UUIDs, never JWTs/cart/contact
arguments. A claimed delivery that loses its ACK is reconciled, not resent.
"""
import copy
import base64
import hashlib
import hmac
import json
import os
import time
from contextvars import ContextVar
from types import SimpleNamespace
from sqlalchemy import text
from origin_contracts import canonical,digest,fail,unsafe
from native import one,json_value
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ACTIVE=ContextVar('screening_origin_effect_capture',default=None)
TASKS={'make_assign_warehouse_request','update_app_platform_version','update_customer_support_flagging_task',
       'order_flag','check_climes','pos_online_order','create_cashback_for_pos','sendFacebookEvents',
       'netcore_events_task','mirror_order_to_post_order','sync_kinesis_orders','insert_into_kinesis',
       'send_order_placed_sms','process_abandon_cart_data'}
CACHE_READS={'get','exists','hget','hgetall','mget','hmget','smembers','sismember','ttl','type','lrange','zrange'}
CACHE_WRITES={'set','setex','psetex','delete','expire','pexpire','hset','hmset','hdel','sadd','srem','zadd','zrem'}


def seal_effects(key,command_id,effects):
    nonce=os.urandom(12)
    secret=hashlib.sha256(('screening-origin-effects.v1:'+key).encode()).digest()
    return base64.urlsafe_b64encode(nonce+AESGCM(secret).encrypt(nonce,canonical(effects).encode(),command_id.encode())).decode().rstrip('=')


def open_effects(key,command_id,payload,checksum):
    try:
        if not isinstance(payload,str) or len(payload)>1400000:raise ValueError()
        raw=base64.urlsafe_b64decode(payload+'='*((4-len(payload)%4)%4))
        secret=hashlib.sha256(('screening-origin-effects.v1:'+key).encode()).digest()
        clear=AESGCM(secret).decrypt(raw[:12],raw[12:],command_id.encode())
        if not hmac.compare_digest(hashlib.sha256(clear).hexdigest(),checksum):raise ValueError()
        values=json.loads(clear)
        if not isinstance(values,list) or len(values)>100:raise ValueError()
        return values
    except Exception:fail('SCREENING_ORIGIN_EFFECT_PROOF_INVALID')


def append(value):
    current=ACTIVE.get()
    if current is None:unsafe('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
    try:
        copied=json.loads(canonical(value))
        if len(current)>=100 or len(canonical([*current,copied]).encode())>1000000:raise ValueError()
    except Exception:unsafe('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
    current.append(copied)
    return SimpleNamespace(id='deferred-origin-effect')


class Call:
    def __init__(self,name,args=(),kwargs=None,options=None):
        if name not in TASKS:unsafe('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        self.value={'name':name,'args':list(args),'kwargs':kwargs or {},'options':options or {}}
    def set(self,**options):self.value['options'].update(options);return self
    def __or__(self,other):return Chain([self,other])


class Chain:
    def __init__(self,calls):self.calls=calls
    def __or__(self,other):return Chain([*self.calls,other])
    def apply_async(self,args=None,**options):
        if [call.value['name'] for call in self.calls]!=['sync_kinesis_orders','insert_into_kinesis']:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        return append({'kind':'chain','calls':[call.value for call in self.calls],'args':list(args or []),'options':options})


class Task:
    def __init__(self,name):
        if name not in TASKS:unsafe('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
        self.name=name
    def __call__(self,*args,**kwargs):
        append({'kind':'direct-task','call':Call(self.name,args,kwargs).value})
        return None
    def s(self,*args,**kwargs):return Call(self.name,args,kwargs)
    def apply_async(self,args=None,kwargs=None,**options):return append({'kind':'task','call':Call(self.name,args or [],kwargs,options).value})
    def delay(self,*args,**kwargs):return self.apply_async(args,kwargs)


class Tasks:
    def __getattr__(self,name):return Task(name)


class Cache:
    def __init__(self,original,name):self.original,self.name=original,name
    def __getattr__(self,name):
        if name in CACHE_READS:return getattr(self.original,name)
        if name not in CACHE_WRITES:unsafe('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
        def capture(*args,**kwargs):
            # Conditional and arithmetic Redis writes affect the source result.
            # They cannot be guessed or replayed as ordinary deferred writes.
            if name=='set' and (kwargs.get('nx') or kwargs.get('xx')):unsafe('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
            if name=='set' and self.name=='payment_redis_object' and len(args)==2 and isinstance(args[0],str) and args[0].startswith('txn_lock_'):
                from origin_frame import CURRENT_ORIGIN
                current=CURRENT_ORIGIN.get()
                if (current is None or args[0]!='txn_lock_'+current.value['customerId'] or set(kwargs)!={'ex'}
                        or type(kwargs['ex']) is not int or not 1<=kwargs['ex']<=86400 or args[1] not in (1,'1')):unsafe('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
                # This is the original synchronous lock acquisition, atomically
                # tagged with its real source command. Later Go cache effects
                # may compare this owner and cannot overwrite a newer cart.
                lua="""local owner=redis.call('GET',KEYS[2]);
if redis.call('EXISTS',KEYS[1])==1 and owner~=ARGV[1] then return 0 end;
redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]);
redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[3]);return 1"""
                try:acquired=self.original.eval(lua,2,args[0],'txn_lock_owner_'+current.value['customerId'],current.value['id'],str(args[1]),kwargs['ex'])
                except Exception:unsafe('SCREENING_ORIGIN_TRANSACTION_LOCK_UNCERTAIN')
                if type(acquired) is not int or acquired!=1:unsafe('SCREENING_ORIGIN_TRANSACTION_LOCK_CHANGED')
                append({'kind':'cache-acquisition','commandId':current.value['id'],'customerId':current.value['customerId'],
                        'expiresAt':int(time.time()*1000)+kwargs['ex']*1000})
                return True
            from origin_cache import observe
            observed=observe(self.original,self.name,name,list(args),kwargs,ACTIVE.get())
            append({'kind':'cache','alias':self.name,'method':name,'args':list(args),'kwargs':kwargs,'observations':observed})
            return True
        return capture


def persist(session,command,key,effects,now):
    raw=canonical(effects);checksum=hashlib.sha256(raw.encode()).hexdigest()
    session.execute(text("INSERT INTO pos_rewrite_screening_origin_effects(command_id,payload,effects_hash,phase,deliveries,updated_at_ms) VALUES(:id,:payload,:hash,'PENDING','[]',:now)"),
        {'id':command['id'],'payload':seal_effects(key,'screening-origin:'+command['id'],effects),'hash':checksum,'now':now})
    return checksum


def load(session,command,key):
    row=one(session,'SELECT payload,effects_hash,phase,deliveries,updated_at_ms FROM pos_rewrite_screening_origin_effects WHERE command_id=:id AND OCTET_LENGTH(payload)<=1400000 FOR UPDATE',{'id':command['id']})
    effects=open_effects(key,'screening-origin:'+command['id'],row['payload'],row['effects_hash'])
    if hashlib.sha256(canonical(effects).encode()).hexdigest()!=row['effects_hash']:fail()
    from origin_ledger import creation
    if creation(session,command,key)['effectsHash']!=row['effects_hash']:fail()
    deliveries=json_value(row['deliveries'])
    if not isinstance(effects,list) or len(effects)>100 or not isinstance(deliveries,list):fail()
    return row,effects,deliveries


def dispatch(sessions,command_id,key,registry,clock):
    """Executable postcommit worker. Registry resolves actual original tasks.

    `publish` requires the installed broker's durable queue/publisher confirms;
    `direct`, `cache`, `cart` execute only their separately qualified handlers.
    No source order/payment function is reachable from this worker.
    """
    while True:
        with sessions() as session,session.begin():
            from origin_ledger import read
            hint=one(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id})
            value=read(session,command_id,str(hint['customer_id']),key)
            if value['phase'] not in ('BOUND','COUNTED'):fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
            row,effects,deliveries=load(session,value,key)
            if row['phase']=='UNCERTAIN':return {'phase':'UNCERTAIN','completed':len(deliveries)}
            if row['phase']=='COMPLETE':return {'phase':'COMPLETE','completed':len(deliveries)}
            if row['phase']=='SENDING':
                if row['updated_at_ms']+120000>clock():return {'phase':'SENDING','completed':len(deliveries)}
                session.execute(text("UPDATE pos_rewrite_screening_origin_effects SET phase='UNCERTAIN',updated_at_ms=:now WHERE command_id=:id"),{'now':clock(),'id':command_id})
                return {'phase':'UNCERTAIN','completed':len(deliveries)}
            if row['phase']!='PENDING' or len(deliveries)>len(effects):fail()
            index=len(deliveries)
            if index==len(effects):
                session.execute(text("UPDATE pos_rewrite_screening_origin_effects SET phase='COMPLETE',updated_at_ms=:now WHERE command_id=:id"),{'now':clock(),'id':command_id})
                return {'phase':'COMPLETE','completed':index}
            effect=copy.deepcopy(effects[index])
            effect_id=digest(key,'effect-id',{'commandId':command_id,'index':index,'effect':effect})
            effect.update(commandId=command_id,ordinal=index)
            session.execute(text("UPDATE pos_rewrite_screening_origin_effects SET phase='SENDING',updated_at_ms=:now WHERE command_id=:id"),{'now':clock(),'id':command_id})
        # The durable SENDING fence precedes the external call, with no SQL lock.
        try:
            if effect['kind'] in ('task','chain'):receipt=registry.publish(effect,effect_id)
            elif effect['kind']=='direct-task':receipt=registry.direct(effect,effect_id)
            elif effect['kind']=='cache':receipt=registry.cache(effect,effect_id)
            elif effect['kind']=='cart':receipt=registry.cart(effect,effect_id)
            elif effect['kind']=='membership-cache':receipt=registry.membership_cache(effect,effect_id)
            elif effect['kind']=='cart-tracking':receipt=registry.cart_tracking(effect,effect_id)
            elif effect['kind']=='cache-acquisition':receipt={'id':effect_id,'accepted':True}
            else:fail('SCREENING_ORIGIN_EFFECT_UNQUALIFIED')
            if not isinstance(receipt,dict) or set(receipt)!={'id','accepted'} or receipt['accepted'] is not True or not isinstance(receipt['id'],str) or not 1<=len(receipt['id'])<=128:fail()
        except Exception:
            with sessions() as session,session.begin():
                session.execute(text("UPDATE pos_rewrite_screening_origin_effects SET phase='UNCERTAIN',updated_at_ms=:now WHERE command_id=:id AND phase='SENDING'"),{'now':clock(),'id':command_id})
            return {'phase':'UNCERTAIN','completed':index}
        with sessions() as session,session.begin():
            current=one(session,'SELECT phase,deliveries FROM pos_rewrite_screening_origin_effects WHERE command_id=:id FOR UPDATE',{'id':command_id})
            if current['phase']!='SENDING' or json_value(current['deliveries'])!=deliveries:fail()
            deliveries.append({'index':index,'effectId':effect_id,'receipt':receipt})
            session.execute(text("UPDATE pos_rewrite_screening_origin_effects SET phase='PENDING',deliveries=:deliveries,updated_at_ms=:now WHERE command_id=:id"),
                            {'deliveries':canonical(deliveries),'now':clock(),'id':command_id})
