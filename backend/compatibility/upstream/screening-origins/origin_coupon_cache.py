"""Original birthday TTL under the shared native customer guard.

No Redis writes occur while SQL locks are held. Existing legacy EXISTS is read
by the genuine source before opening SQL; every participating issuer must share
this guard before its cooperation selector is qualified.
"""
import copy
import hmac
import json
from uuid import UUID,uuid4
from sqlalchemy import text
from native import one,rows,json_value
from origin_contracts import canonical,digest,unsafe
from benefit_controls import CurrentConfigurationCache


class SnapshotCache:
    def __init__(self,values):self.values=values
    def exists(self,name):return name in self.values
    def get(self,name):return self.values.get(name)


class OriginCouponCache:
    def __init__(self,owner,session,value,snapshot):
        self.owner,self.session,self.value=owner,session,value
        self.snapshot=copy.deepcopy(snapshot);self.config=CurrentConfigurationCache(SnapshotCache(snapshot['config']))
        self.claim=None;self.guard=None
        # This is an opaque cooperative mutex owner, not a CSV operation or a
        # financial authority. Domain separation prevents a supplied UUID from
        # impersonating the owner of an unrelated import/customer claim.
        self.nonce=str(UUID(bytes=bytes.fromhex(digest(owner.key,'coupon-guard-owner',{'commandId':value['id'],'origin':value['origin']}))[:16],version=4))
    def _guard(self):
        if self.guard is None:
            self.session.execute(text('INSERT INTO pos_rewrite_import_birthday_guards(customer_id,operation_id,expires_at_ms) VALUES(:customer,:owner,0) ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id)'),
                {'customer':self.value['customerId'],'owner':self.nonce})
            self.guard=one(self.session,'SELECT operation_id,expires_at_ms FROM pos_rewrite_import_birthday_guards WHERE customer_id=:customer FOR UPDATE',{'customer':self.value['customerId']})
        return self.guard
    def exists(self,name):
        if name=='welcome_coupon':return name in self.snapshot['config']
        if name=='birthday_coupon_'+self.value['customerId']:
            guard=self._guard()
            return self.snapshot['legacyPresent'] or self.claim is not None or (int(guard['expires_at_ms'])>self.owner.clock() and guard['operation_id']!=self.nonce)
        if name.startswith('birthday_coupon_'):unsafe('SCREENING_ORIGIN_COUPON_SCOPE_CHANGED')
        return self.config.exists(name)
    def get(self,name):
        if name=='welcome_coupon':
            value=self.snapshot['config'].get(name)
            return value.encode('utf-8') if isinstance(value,str) else value
        if name=='birthday_coupon_'+self.value['customerId']:return b'{"is_applied":true}' if self.exists(name) else None
        return self.config.get(name)
    def set(self,name,value,ex=None):
        if name!='birthday_coupon_'+self.value['customerId']:return self.config.set(name,value,ex)
        if type(ex) is not int or not 1<=ex<=2592000 or json.loads(value)!={'is_applied':True}:unsafe('SCREENING_ORIGIN_COUPON_GUARD_INVALID')
        if self.claim is not None:return True
        old=rows(self.session,'SELECT request_hash,receipt,proof_hash FROM pos_rewrite_screening_origin_birthday_claims WHERE command_id=:id FOR SHARE',{'id':self.value['id']},2)
        if old:
            receipt=json_value(old[0]['receipt'])
            if (len(old)!=1 or old[0]['request_hash']!=self.value['requestHash'] or receipt.get('commandId')!=self.value['id']
                    or not hmac.compare_digest(digest(self.owner.key,'coupon-birthday-claim',receipt),old[0]['proof_hash'])):unsafe('SCREENING_ORIGIN_COUPON_GUARD_INVALID')
            self.claim={name:receipt[name] for name in ('id','keyHash','expiresAt')};self.claim['receiptHash']=old[0]['proof_hash'];return True
        guard=self._guard();now=self.owner.clock()
        if self.snapshot['legacyPresent'] or int(guard['expires_at_ms'])>now:unsafe('SCREENING_ORIGIN_COUPON_ALREADY_CLAIMED')
        receipt={'commandId':self.value['id'],'origin':self.value['origin'],'customerId':self.value['customerId'],
            'requestHash':self.value['requestHash'],'cartHash':self.value['cartHash'],'ownerNonce':self.nonce,
            'id':str(uuid4()),'keyHash':digest(self.owner.key,'coupon-birthday-key',self.value['customerId']),'expiresAt':now+ex*1000}
        proof=digest(self.owner.key,'coupon-birthday-claim',receipt)
        self.session.execute(text('UPDATE pos_rewrite_import_birthday_guards SET operation_id=:owner,expires_at_ms=:expiry WHERE customer_id=:customer'),
            {'owner':self.nonce,'expiry':receipt['expiresAt'],'customer':self.value['customerId']})
        self.session.execute(text('INSERT INTO pos_rewrite_screening_origin_birthday_claims(command_id,claim_id,request_hash,receipt,proof_hash) VALUES(:command,:id,:request,:receipt,:proof)'),
            {'command':self.value['id'],'id':receipt['id'],'request':self.value['requestHash'],'receipt':canonical(receipt),'proof':proof})
        self.guard={'operation_id':self.nonce,'expires_at_ms':receipt['expiresAt']}
        self.claim={name:receipt[name] for name in ('id','keyHash','expiresAt')};self.claim['receiptHash']=proof
        return True
