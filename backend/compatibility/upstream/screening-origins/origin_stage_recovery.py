"""Issue same-attempt recovery authority after real current source authentication.

This module never creates an Order, payment attempt, provider request or source
job. The immutable original attempt and creation remain the financial payload;
the short receipt changes only who may reconcile that already-started stage.
"""
import base64
import hmac
from sqlalchemy import text
from native import one, rows, json_value, HEADER, LINE
from origin_contracts import UUID, HASH, checked, canonical, digest, point, fail
from origin_auth import source_origin
from origin_ledger import read, creation, projection
from origin_frame import ALLOCATION

CONTRACT = 'pos-screening-origin-stage-recovery-v1'
REASONS = {'service-rotation', 'customer-contact-changed', 'source-reconciliation', 'session-renewal'}
ACTIVE = {'SENDING', 'PENDING', 'UNCERTAIN'}
TERMINAL = {'CONFIRMED', 'FAILED', 'CAPTURED'}
ATTEMPT_FIELDS = {'contract', 'commandId', 'orderId', 'customerId', 'creationHash', 'requestHash',
                  'referenceHash', 'paymentRequestHash', 'phase', 'provider', 'payloadHash',
                  'responseHash', 'observationHash', 'declined', 'createdAt', 'updatedAt', 'version'}
FIELDS = {'contract', 'recoveryId', 'commandId', 'origin', 'orderId', 'customerId', 'actorId', 'storeId',
          'counterId', 'creationHash', 'requestHash', 'referenceHash', 'originalAuthorityHash',
          'paymentRequestHash', 'payloadHash', 'attemptVersion', 'attemptHash', 'currentAuthority',
          'currentAuthorityHash', 'reason', 'issuedAt', 'expiresAt', 'noProviderStart'}
USE_FIELDS = {'contract', 'recoveryId', 'commandId', 'orderId', 'customerId', 'recoveryHash', 'creationHash',
              'requestHash', 'paymentRequestHash', 'payloadHash', 'provider', 'attemptVersion',
              'attemptHash', 'attemptCreatedAt', 'currentAuthorityHash', 'acceptedAt', 'expiresAt'}


def refused():
    fail('SCREENING_ORIGIN_STAGE_RECOVERY_REQUIRED')


def signed(key, purpose, value, seal):
    return isinstance(seal, str) and HASH.fullmatch(seal) and hmac.compare_digest(digest(key, purpose, value), seal)


def envelope(key, purpose, value):
    return {'data': value, 'proofHash': digest(key, purpose, value)}


def encoded(value):
    return base64.urlsafe_b64encode(canonical(value).encode()).decode().rstrip('=')


def principal_for(req, session, owner, system_owner, hint, details, now):
    if hint['origin'] != 'external-system':
        _native, principal, grant = source_origin(req, session, owner.key, now, hint['origin'])
        if grant is not None and (grant['requestHash'] != hint['requestHash'] or grant['cartHash'] != hint['cartHash']):
            refused()
    else:
        # Authenticate was performed by the actual original CSK validator, and
        # the same current service is rechecked under this owned transaction.
        if system_owner is None or details is None:
            refused()
        from origin_system import current_service
        service = current_service(session, owner.key, details)
        customer = hint['customerId']
        native = one(session, 'SELECT id,email,telephone,status,is_block,is_disabled,is_two_fa FROM users WHERE id=:id FOR UPDATE', {'id': customer})
        if native['status'] != 1 or native['is_block'] not in (None, 0) or native['is_disabled'] not in (None, 0):
            refused()
        principal = {'origin': 'external-system', 'customerId': customer, 'actorId': None, 'storeId': None,
                     'counterId': None, 'serviceId': 'csk', 'serviceRevision': service['revision'],
                     'credentialHash': service['credentialHash'], 'configurationHash': service['configurationHash'],
                     'identityHash': digest(owner.key, 'system-customer', {'id': customer, 'email': native['email'],
                         'telephone': native['telephone'], 'status': native['status'], 'isBlock': native['is_block'],
                         'isDisabled': native['is_disabled'], 'isTwoFa': native['is_two_fa']})}
    # Renewable grant identifiers are not stage authority. Their signed native
    # session/actor/scope/request/cart proof was nevertheless checked above.
    principal = {name: value for name, value in principal.items() if name != 'grantId'}
    if any(principal.get(name) != hint[name] for name in ('origin', 'customerId', 'actorId', 'storeId', 'counterId')):
        refused()
    return principal


def attempt(session, command, key):
    found = rows(session, 'SELECT command_id,order_id,customer_id,phase,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END AS data,proof_hash FROM pos_rewrite_screening_origin_payment_attempts WHERE command_id=:id FOR UPDATE', {'id': command['id']}, 2)
    if not found:
        return None
    row = found[0]
    value = json_value(row['data'])
    if (not isinstance(value, dict) or set(value) != ATTEMPT_FIELDS or value['contract'] != 'pos-screening-origin-payments-v1'
            or value['commandId'] != command['id'] or row['command_id'] != command['id']
            or value['orderId'] != command['orderId'] or str(row['order_id']) != command['orderId']
            or value['customerId'] != command['customerId'] or str(row['customer_id']) != command['customerId']
            or any(value[name] != command[name] for name in ('creationHash', 'requestHash', 'referenceHash'))
            or value['phase'] != row['phase'] or value['phase'] not in ACTIVE | TERMINAL
            or value['provider'] not in ('juspay', 'gokwik', 'none') or type(value['declined']) is not bool
            or type(value['version']) is not int or not 1 <= value['version'] <= 9007199254740991
            or not point(value['createdAt']) or not point(value['updatedAt']) or value['updatedAt'] < value['createdAt']
            or any(not isinstance(value[name], str) or not HASH.fullmatch(value[name]) for name in ('paymentRequestHash', 'payloadHash'))
            or any(value[name] is not None and (not isinstance(value[name], str) or not HASH.fullmatch(value[name])) for name in ('responseHash', 'observationHash'))
            or not signed(key, 'payment-attempt', value, row['proof_hash'])):
        refused()
    return value, row['proof_hash']


def terminal(session, command, source, stage, key):
    phase = stage['phase']
    if phase not in TERMINAL:
        return None
    if phase == 'CONFIRMED':
        row = one(session, 'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_payments WHERE command_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE', {'id': command['id']})
        purpose, contract = 'payment', 'pos-screening-origin-payment-v1'
    else:
        if stage['observationHash'] is None:
            refused()
        row = one(session, 'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_payment_outcomes WHERE command_id=:id AND observation_hash=:observation AND OCTET_LENGTH(data)<=16000 FOR SHARE', {'id': command['id'], 'observation': stage['observationHash']})
        purpose, contract = 'payment-outcome', 'pos-screening-origin-payment-outcome-v1'
    proof = json_value(row['data'])
    if (not isinstance(proof, dict) or proof.get('contract') != contract or proof.get('status') != phase
            or proof.get('commandId') != command['id'] or proof.get('orderId') != command['orderId']
            or str(row['order_id']) != command['orderId'] or proof.get('origin') != command['origin']
            or proof.get('customerId') != command['customerId'] or proof.get('method') != source.get('method')
            or any(proof.get(name) != command[name] for name in ('creationHash', 'requestHash', 'referenceHash'))
            or proof.get('observationHash') != stage['observationHash'] or proof.get('provider') != stage['provider']
            or proof.get('sourceCommit') != '434f3e438d1cb48c64e5723222c6efda506db571'
            or phase != 'CONFIRMED' and proof.get('noConfirmation') is not True
            or not signed(key, purpose, proof, row['proof_hash'])):
        refused()
    return {'commandId': command['id'], 'orderId': command['orderId'], 'status': phase,
            'terminal': True, 'receipt': {'data': proof, 'proofHash': row['proof_hash']}, 'noProviderStart': True}


def native_stage(session, command, source):
    # The customer/staff/service prefix and command/attempt locks are already
    # held. Recheck the original full native header, allocation and every HP.
    order = one(session, 'SELECT user_id,payment_method,order_status,'+HEADER+' AS header_hash,'+ALLOCATION+' AS allocation_hash FROM orders WHERE id=:id FOR UPDATE', {'id': command['orderId']})
    if (str(order['user_id']) != command['customerId'] or order['payment_method'] != source.get('method')
            or order['header_hash'] != source.get('headerHash') or order['allocation_hash'] != source.get('allocationHash')
            or order['order_status'] not in (0, 17)):
        refused()
    found = rows(session, 'SELECT id,prod_id,qty,'+LINE+' AS input_hash FROM has_products WHERE order_id=:id ORDER BY id LIMIT 1001 FOR UPDATE', {'id': command['orderId']}, 1001)
    actual = [{'id': str(row['id']), 'productId': str(row['prod_id']), 'quantity': row['qty'], 'inputHash': row['input_hash']} for row in found]
    if actual != source.get('lines'):
        refused()
    projection(session, command)
    if command['storeId'] is not None:
        stores = rows(session, 'SELECT store_id,counter_id FROM order_stores WHERE order_id=:id LIMIT 2 FOR SHARE', {'id': command['orderId']}, 2)
        if len(stores) != 1 or str(stores[0]['store_id']) != command['storeId'] or str(stores[0]['counter_id']) != command['counterId']:
            refused()
    elif rows(session, 'SELECT store_id FROM order_stores WHERE order_id=:id AND store_id<>0 LIMIT 2 FOR SHARE', {'id': command['orderId']}, 2):
        refused()


def stored(session, recovery_id, command, key):
    found = rows(session, 'SELECT recovery_id,command_id,order_id,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END AS data,proof_hash FROM pos_rewrite_screening_origin_stage_recoveries WHERE recovery_id=:id FOR SHARE', {'id': recovery_id}, 2)
    if not found:
        return None
    row, value = found[0], json_value(found[0]['data'])
    if (not isinstance(value, dict) or set(value) != FIELDS or value['contract'] != CONTRACT
            or value['recoveryId'] != recovery_id or row['recovery_id'] != recovery_id
            or value['commandId'] != command['id'] or row['command_id'] != command['id']
            or value['orderId'] != command['orderId'] or str(row['order_id']) != command['orderId']
            or any(value[name] != command[name] for name in ('origin', 'customerId', 'actorId', 'storeId', 'counterId', 'creationHash', 'requestHash', 'referenceHash'))
            or value['originalAuthorityHash'] != command['authorityHash'] or value['reason'] not in REASONS
            or value['noProviderStart'] is not True or not point(value['issuedAt']) or not point(value['expiresAt'])
            or not value['issuedAt'] < value['expiresAt'] <= value['issuedAt']+60000
            or type(value['attemptVersion']) is not int or value['attemptVersion'] < 1
            or not isinstance(value['currentAuthority'], dict)
            or any(not isinstance(value[name], str) or not HASH.fullmatch(value[name]) for name in ('paymentRequestHash', 'payloadHash', 'attemptHash', 'currentAuthorityHash'))
            or digest(key, 'authority', value['currentAuthority']) != value['currentAuthorityHash']
            or not signed(key, 'payment-stage-recovery', value, row['proof_hash'])):
        refused()
    return {'data': value, 'proofHash': row['proof_hash']}


def same_attempt(session, proof, stage, attempt_hash, key):
    value = proof['data']
    if value['paymentRequestHash'] != stage['paymentRequestHash'] or value['payloadHash'] != stage['payloadHash']:
        refused()
    if stage['version'] == value['attemptVersion'] and attempt_hash == value['attemptHash']:
        return True
    # Only a genuine accepted Go use may explain later observations of the
    # same immutable attempt. Never treat an arbitrary newer version as reuse.
    found = rows(session, 'SELECT command_id,order_id,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END AS data,proof_hash FROM pos_rewrite_screening_origin_stage_recovery_uses WHERE recovery_id=:id FOR SHARE', {'id': value['recoveryId']}, 2)
    if not found:
        return False
    row, use = found[0], json_value(found[0]['data'])
    if (not isinstance(use, dict) or set(use) != USE_FIELDS or use['contract'] != 'pos-screening-origin-stage-recovery-use-v1'
            or row['command_id'] != value['commandId'] or str(row['order_id']) != value['orderId']
            or any(use[name] != value[name] for name in ('recoveryId', 'commandId', 'orderId', 'customerId', 'creationHash', 'requestHash', 'paymentRequestHash', 'payloadHash', 'attemptVersion', 'attemptHash', 'currentAuthorityHash', 'expiresAt'))
            or use['recoveryHash'] != proof['proofHash'] or use['provider'] != stage['provider']
            or use['attemptCreatedAt'] != stage['createdAt'] or use['attemptVersion'] > stage['version']
            or not point(use['acceptedAt']) or not value['issuedAt'] <= use['acceptedAt'] < value['expiresAt']
            or not signed(key, 'payment-stage-recovery-use', use, row['proof_hash'])):
        refused()
    return True


class StageRecoveryIssuer:
    def __init__(self, owner, system_owner=None):
        self.owner, self.system_owner = owner, system_owner

    def now(self):
        value = self.owner.clock()
        if not point(value) or value+60000 > 9007199254740991:
            refused()
        return value

    def issue(self, req, command_id, recovery_id, reason):
        if not isinstance(reason, str) or reason not in REASONS:
            refused()
        return self._run(req, command_id, recovery_id, reason)

    def read(self, req, command_id, recovery_id):
        return self._run(req, command_id, recovery_id, None)

    def _run(self, req, command_id, recovery_id, reason):
        if not isinstance(command_id, str) or not UUID.fullmatch(command_id) or not isinstance(recovery_id, str) or not UUID.fullmatch(recovery_id):
            refused()
        details = None
        # No raw external authority object is accepted by this API. Only the
        # actual source owner validates the genuine current CSK API key.
        if self.system_owner is not None and req.get_header('X-CSK-API-Key'):
            details = self.system_owner.authenticate(req)
        with self.owner.sessions() as session, session.begin():
            connection = session.connection(execution_options={'isolation_level': 'READ COMMITTED'})
            if connection.get_isolation_level() != 'READ COMMITTED':
                refused()
            # Nonlocking authenticated hint locates only the original scope;
            # actor/Store/customer authentication still precedes journal locks.
            hints = rows(session, 'SELECT id,origin,customer_id,actor_id,store_id,counter_id,phase,order_id,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END AS data,proof_hash FROM pos_rewrite_screening_origin_commands WHERE id=:id', {'id': command_id}, 2)
            if not hints:
                return {'commandId': command_id, 'status': 'NOT_FOUND', 'missing': True, 'noProviderStart': True}
            hint = checked(hints[0], self.owner.key)
            supplied_origin = req.get_header('X-TSS-Screening-Origin')
            if supplied_origin is not None and supplied_origin != hint['origin']:
                refused()
            now = self.now()
            principal = principal_for(req, session, self.owner, self.system_owner, hint, details, now)
            # Closed source event boundary receives only the genuinely
            # authenticated actor, never a body/header-supplied identity.
            req.context['screening_origin_event_actor_id'] = principal['actorId']
            command = read(session, command_id, principal['customerId'], self.owner.key)
            if command != hint or command['phase'] not in ('BOUND', 'COUNTED') or command['orderId'] is None:
                refused()
            source = creation(session, command, self.owner.key)
            if (any(source.get(name) != command[name] for name in ('origin', 'customerId', 'actorId', 'storeId', 'counterId', 'requestHash', 'referenceHash', 'authorityHash', 'cartHash'))
                    or source.get('sourceCommit') != '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'):
                refused()
            if command['origin'] == 'external-system':
                row = one(session, 'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_authorities WHERE command_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE', {'id': command_id})
                authority = json_value(row['data'])
                if (not isinstance(authority, dict) or authority.get('commandId') != command_id or authority.get('customerId') != command['customerId']
                        or authority.get('requestHash') != command['requestHash'] or authority.get('referenceHash') != command['referenceHash']
                        or source.get('systemAuthorityHash') != row['proof_hash'] or not signed(self.owner.key, 'system-authority', authority, row['proof_hash'])):
                    refused()
                from system_successor import assert_active
                assert_active(session, command['referenceHash'], command_id, self.owner.key)
            current = attempt(session, command, self.owner.key)
            if current is None:
                return {'commandId': command_id, 'orderId': command['orderId'], 'status': 'ATTEMPT_NOT_FOUND', 'missing': True, 'noProviderStart': True}
            stage, stage_hash = current
            completed = terminal(session, command, source, stage, self.owner.key)
            if completed is not None:
                return completed
            native_stage(session, command, source)
            proof = stored(session, recovery_id, command, self.owner.key)
            if proof is None and reason is None:
                return {'commandId': command_id, 'orderId': command['orderId'], 'recoveryId': recovery_id, 'status': 'NOT_FOUND', 'missing': True, 'noProviderStart': True}
            # Re-read the clock and current native authority after all locks and
            # native comparisons. Expired JWT/grant/session cannot mint a lease.
            now = self.now()
            fresh = principal_for(req, session, self.owner, self.system_owner, command, details, now)
            if fresh != principal:
                refused()
            current_hash = digest(self.owner.key, 'authority', fresh)
            if proof is None:
                if stage['phase'] not in ACTIVE:
                    refused()
                value = {'contract': CONTRACT, 'recoveryId': recovery_id, 'commandId': command_id, 'origin': command['origin'],
                    'orderId': command['orderId'], 'customerId': command['customerId'], 'actorId': command['actorId'],
                    'storeId': command['storeId'], 'counterId': command['counterId'], 'creationHash': command['creationHash'],
                    'requestHash': command['requestHash'], 'referenceHash': command['referenceHash'],
                    'originalAuthorityHash': command['authorityHash'], 'paymentRequestHash': stage['paymentRequestHash'],
                    'payloadHash': stage['payloadHash'], 'attemptVersion': stage['version'], 'attemptHash': stage_hash,
                    'currentAuthority': fresh, 'currentAuthorityHash': current_hash, 'reason': reason,
                    'issuedAt': now, 'expiresAt': now+60000, 'noProviderStart': True}
                proof = envelope(self.owner.key, 'payment-stage-recovery', value)
                if len(canonical(value).encode()) > 16000:
                    refused()
                session.execute(text('INSERT INTO pos_rewrite_screening_origin_stage_recoveries(recovery_id,command_id,order_id,data,proof_hash) VALUES(:recovery,:command,:order,:data,:proof)'),
                    {'recovery': recovery_id, 'command': command_id, 'order': command['orderId'], 'data': canonical(value), 'proof': proof['proofHash']})
            value = proof['data']
            if reason is not None and reason != value['reason']:
                refused()
            status = 'AUTHORIZED'
            if not value['issuedAt'] <= now < value['expiresAt']:
                status = 'EXPIRED'
            elif value['currentAuthorityHash'] != current_hash or value['currentAuthority'] != fresh:
                status = 'AUTHORITY_CHANGED'
            elif not same_attempt(session, proof, stage, stage_hash, self.owner.key):
                status = 'STALE_ATTEMPT'
            result = {'commandId': command_id, 'orderId': command['orderId'], 'recoveryId': recovery_id, 'status': status,
                      'recovery': proof, 'expiresAt': value['expiresAt'], 'noProviderStart': True}
            if status == 'AUTHORIZED':
                authorization = {'contract': 'pos-screening-origin-payment-submission-v1', 'commandId': command_id,
                    'orderId': command['orderId'], 'customerId': command['customerId'], 'creationHash': command['creationHash'],
                    'requestHash': command['requestHash'], 'referenceHash': command['referenceHash'],
                    'authorityHash': command['authorityHash'], 'paymentRequestHash': stage['paymentRequestHash'],
                    'issuedAt': now, 'expiresAt': value['expiresAt']}
                result['headers'] = {'X-TSS-Screening-Command': command_id,
                    'X-TSS-Screening-Stage-Recovery': encoded(proof),
                    'X-TSS-Screening-Payment-Authorization': encoded(envelope(self.owner.key, 'payment-read', authorization))}
            return result
