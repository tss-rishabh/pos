"""Private, GET-only current coupon control descriptor; no financial action."""
import hmac
import json
import re
from datetime import datetime, timezone
from uuid import UUID, uuid4
from protocol import ImportReview
from transaction import CURRENT

CONTRACT = 'pos-csv-coupon-generation-controls-v1'
PREFIX = '/internal/pos/coupon-history/controls/current'
HEADER = 'HTTP_X_POS_COUPON_HISTORY_CONTROLS_KEY'


def unavailable():
    raise ImportReview('ORDER_IMPORT_COUPON_CONTROLS_UNAVAILABLE') from None


def options(environment, proof_key, other_keys=()):
    contract = environment.get('POS_COUPON_GENERATION_CONTROLS_CONTRACT')
    key = environment.get('POS_COUPON_GENERATION_CONTROLS_KEY', '')
    if contract in (None, '') and key in (None, ''): return None
    if (contract != CONTRACT or not isinstance(key, str) or not re.fullmatch(r'[!-~]{32,4096}', key)
            or key == proof_key or key in other_keys):
        unavailable()
    return {'key': key}


def private_application(resource, key, emit_stream, fallback=None):
    if not isinstance(key, str) or not re.fullmatch(r'[!-~]{32,4096}', key): unavailable()
    def application(environ, start_response):
        path = environ.get('PATH_INFO', '')
        if path != PREFIX and fallback is not None: return fallback(environ, start_response)
        supplied_id = environ.get('HTTP_X_REQUEST_ID')
        try:
            request_id = str(UUID(supplied_id))
            if request_id != supplied_id: raise ValueError()
        except (TypeError, ValueError, AttributeError):
            request_id = str(uuid4())
        status, code = '503 Service Unavailable', 'ORDER_IMPORT_COUPON_CONTROLS_UNAVAILABLE'
        try:
            supplied = environ.get(HEADER)
            if (not isinstance(supplied, str) or not re.fullmatch(r'[!-~]{32,4096}', supplied)
                    or not hmac.compare_digest(key, supplied)):
                status, code = '401 Unauthorized', 'ORDER_IMPORT_COUPON_CONTROLS_UNAUTHORIZED'
                unavailable()
            if (path != PREFIX or environ.get('REQUEST_METHOD') != 'GET'
                    or environ.get('QUERY_STRING') or environ.get('CONTENT_LENGTH', '0') not in ('', '0')
                    or CURRENT.get() is not None):
                status, code = '400 Bad Request', 'ORDER_IMPORT_COUPON_CONTROLS_REQUEST_INVALID'
                unavailable()
            result = resource.read()
            body = json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
            if len(body) > 8192: unavailable()
            status = '200 OK'
        except Exception:
            body = json.dumps({'code': code}, separators=(',', ':')).encode()
        event = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'module': 'legacy-order-imports', 'resource': 'coupon-generation-controls',
            'eventId': 'legacy-order-imports.coupon-generation-controls.' + ('read' if status == '200 OK' else 'review'),
            'eventInstanceId': str(uuid4()), 'requestId': request_id, 'userId': None,
        }
        try:
            emit_stream.write(json.dumps(event, separators=(',', ':')) + '\n')
            emit_stream.flush()
        except Exception:
            pass
        start_response(status, [
            ('Content-Type', 'application/json'), ('Cache-Control', 'private, no-store'),
            ('Content-Length', str(len(body))), ('X-Content-Type-Options', 'nosniff'),
            ('X-Request-ID', request_id),
        ])
        return [body]
    return application


def resource(sessions, proof_key, benefits):
    # Keep pre-bootstrap option validation free of source/cache/DB construction.
    from coupon_generation_controls import CouponGenerationControls
    return CouponGenerationControls(sessions, proof_key, benefits)
