"""Atomic SQL equivalent of source birthday_{user_id} TTL guard.

Candidate only: all competing source writers must share this authority, and
retained legacy Redis keys must be imported/observed before cutover. A private
worker flag cannot prove that external deployment contract.
"""
import copy
import hmac
import json
from uuid import uuid4
from sqlalchemy import text
from benefit_history import seal, canonical
from benefit_source import BenefitReview

GUARD_CONTRACT = 'pos-csv-birthday-cooperative-guard-v1'


def legacy_guard_observation(redis, scope, key, now_ms):
    """PRE-DISPATCH trusted source adapter; never invoke under SQL locks.
    Only EXISTS is read. The source key/PII never enters logs or the document.
    """
    exists = redis.exists('birthday_coupon_'+scope['customerId'])
    if type(exists) not in (bool,int) or exists not in (0,1):
        raise BenefitReview('ORDER_IMPORT_BIRTHDAY_GUARD_UNQUALIFIED')
    value = {'contract': GUARD_CONTRACT, 'operationId': scope['operationId'],
             'requestHash': scope['requestHash'], 'customerId': scope['customerId'],
             'observedAt': now_ms, 'present': bool(exists)}
    return {**value, 'signature': seal('birthday-observation', value, key)}


class SqlBirthdayCache:
    def __init__(self, session, scope, cache, key, cache_key, observation, now_ms, contract):
        self.session, self.scope, self.key = session, copy.deepcopy(scope), key
        self.cache, self.now_ms = copy.deepcopy(cache), now_ms
        self.key_name = 'birthday_coupon_' + scope['customerId']
        self.claim = None
        try:
            if contract != GUARD_CONTRACT or key == cache_key or not isinstance(observation, dict): raise ValueError()
            body = {k:v for k,v in observation.items() if k != 'signature'}
            if set(body) != {'contract','operationId','requestHash','customerId','observedAt','present'}: raise ValueError()
            if any(body[n] != scope[n] for n in ('operationId','requestHash','customerId')) or body['contract'] != contract:
                raise ValueError()
            if type(body['present']) is not bool or type(body['observedAt']) is not int or not 0 <= now_ms-body['observedAt'] <= 60000:
                raise ValueError()
            if not hmac.compare_digest(seal('birthday-observation', body, cache_key), observation['signature']): raise ValueError()
            self.legacy_present = body['present']
        except (ValueError, KeyError, TypeError):
            raise BenefitReview('ORDER_IMPORT_BIRTHDAY_GUARD_UNQUALIFIED') from None
        self.guard = None

    def _guard(self):
        if self.guard is None:
            # Caller already holds original command→Store→Order(if any)→MUser.
            # Unique customer mutex, exact no-op conflict update, current read.
            self.session.execute(text('INSERT INTO pos_rewrite_import_birthday_guards (customer_id,operation_id,expires_at_ms) VALUES (:customer,:operation,0) ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id)'),
                {'customer': self.scope['customerId'], 'operation': self.scope['operationId']})
            self.guard = dict(self.session.execute(text('SELECT operation_id,expires_at_ms FROM pos_rewrite_import_birthday_guards WHERE customer_id=:customer FOR UPDATE'),
                {'customer': self.scope['customerId']}).mappings().one())
        return self.guard

    def exists(self, name):
        if name != self.key_name:
            if name.startswith('birthday_coupon_'): raise BenefitReview()
            return name in self.cache
        guard = self._guard()
        # Exact original-operation replay can restore its retained coupon
        # selection without consuming a second claim or extending expiry.
        return self.legacy_present or (int(guard['expires_at_ms']) > self.now_ms and
            guard['operation_id'] != self.scope['operationId']) or self.claim is not None

    def get(self, name):
        if name == self.key_name:
            return b'{"is_applied":true}' if self.exists(name) else None
        value = self.cache.get(name)
        return json.dumps(value).encode() if value is not None else None

    def set(self, name, value, ex=None):
        if name != self.key_name:
            if name not in ('auto_apply_coupon','birthday_coupon'): raise BenefitReview()
            self.cache[name] = json.loads(value)
            return True
        try:
            if type(ex) is not int or not 1 <= ex <= 2592000 or json.loads(value) != {'is_applied': True}:
                raise ValueError()
        except (ValueError, TypeError): raise BenefitReview() from None
        old = self.session.execute(text('SELECT receipt,proof_hash,request_hash FROM pos_rewrite_import_birthday_claims WHERE operation_id=:operation FOR UPDATE'),
            {'operation': self.scope['operationId']}).mappings().one_or_none()
        if old:
            receipt = json.loads(old['receipt']) if isinstance(old['receipt'], str) else old['receipt']
            if old['request_hash'] != self.scope['requestHash'] or receipt['scope'] != self.scope or not hmac.compare_digest(seal('birthday-claim', receipt, self.key), old['proof_hash']):
                raise BenefitReview()
            self.claim = {**receipt, 'receiptHash': old['proof_hash']}
            return True
        guard = self._guard()
        if self.legacy_present or int(guard['expires_at_ms']) > self.now_ms:
            raise BenefitReview('ORDER_IMPORT_BIRTHDAY_ALREADY_CLAIMED')
        expires = self.now_ms + ex*1000
        receipt = {'scope': self.scope, 'id': str(uuid4()),
            'keyHash': seal('birthday-key', self.scope['customerId'], self.key), 'expiresAt': expires}
        proof = seal('birthday-claim', receipt, self.key)
        self.session.execute(text('UPDATE pos_rewrite_import_birthday_guards SET operation_id=:operation,expires_at_ms=:expiry WHERE customer_id=:customer'),
            {'operation': self.scope['operationId'], 'expiry': expires, 'customer': self.scope['customerId']})
        self.session.execute(text('INSERT INTO pos_rewrite_import_birthday_claims (operation_id,request_hash,claim_id,receipt,proof_hash) VALUES (:operation,:request,:id,:receipt,:proof)'),
            {'operation': self.scope['operationId'], 'request': self.scope['requestHash'], 'id': receipt['id'],
             'receipt': canonical(receipt), 'proof': proof})
        self.guard = {'operation_id': self.scope['operationId'], 'expires_at_ms': expires}
        self.claim = {**receipt, 'receiptHash': proof}
        return True
