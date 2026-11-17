"""Genuine legacy staff grants on fixed original cart/preview transports.

No order nonce, payment capability or customer token is manufactured here. The
original request's real Django/MPos session and original customer credential
are revalidated by legacy_staff before HTTP starts.
"""
import time
from urllib.parse import urlsplit
import requests
from origin_contracts import canonical, identifier, fail
from legacy_staff import key, authenticated, issue, database

MAX_PAYLOAD = 1000000
MAX_RESPONSE = 4000000
# These are literal original order/views.py cart and quote helpers. They never
# include /order, /pos/order, payments, or an arbitrary browser-provided path.
ROUTES = {'pos/product', 'wallet',
          'pg', 'store-discount-pg', 'giftvoucher', 'coupon', 'validatecheckout', 'processorder'}


def refused():
    fail('SCREENING_ORIGIN_CART_AUTH_REQUIRED')


def endpoint(url):
    from django.conf import settings
    if not isinstance(url, str) or len(url) > 2048:
        refused()
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        refused()
    allowed = set()
    for configured, cart_routes in ((settings.MAIN_API_V2_URL, {'cart', 'syncart'}),
                                    (settings.API_V2_URL, {'pos/cart', 'pos/syncart'})):
        if not isinstance(configured, str):
            refused()
        base = urlsplit(configured)
        if base.scheme != 'https' or not base.hostname or base.username or base.password or base.query or base.fragment:
            refused()
        prefix = configured.rstrip('/')+'/'
        allowed.update(prefix+suffix for suffix in ROUTES | cart_routes)
    if url not in allowed:
        refused()
    return parsed.path.rsplit('/', 1)[-1]


def location(request, payload):
    store = identifier(payload.get('store_id'))
    post = getattr(request, 'POST', {})
    match = getattr(request, 'resolver_match', None)
    route = getattr(match, 'kwargs', {}) or {}
    for value in (post.get('store_id'), route.get('store_id')):
        if value is not None and identifier(value) != store:
            refused()
    # Initial CreateOrderView.get carries the actual selected route counter.
    # Ajax callers carry that page counter as an ordinary location input. The
    # real grant issuer independently verifies native assignment/check-in.
    counters = [identifier(value) for value in (payload.get('counter_id'), post.get('counter_id'), route.get('counter_id')) if value is not None]
    if not counters or any(value != counters[0] for value in counters):
        refused()
    return store, counters[0]


class AuthenticatedCartRequest:
    """Add a server-derived actor to the existing issuer's captured-actor seam.

    The actual user/session/cookie objects and login epoch stay unchanged. An
    explicitly supplied stale actor is refused; an absent actor is derived
    solely from legacy_staff.authenticated, never a cart body.
    """
    def __init__(self, request, actor_id):
        self.original = request
        self.META = dict(request.META)
        supplied = self.META.get('HTTP_X_TSS_SCREENING_ACTOR')
        if supplied is not None and identifier(supplied) != actor_id:
            refused()
        self.META['HTTP_X_TSS_SCREENING_ACTOR'] = actor_id

    def __getattr__(self, name):
        return getattr(self.original, name)


def post(request, url, payload, headers, **original_options):
    endpoint(url)
    if (not isinstance(payload, dict) or payload.get('is_pos') is not True
            or not isinstance(headers, dict) or set(original_options)-{'timeout'}):
        refused()
    body = dict(payload)
    store, counter = location(request, body)
    body['counter_id'] = counter
    if len(canonical(body).encode()) > MAX_PAYLOAD:
        refused()
    supplied = dict(headers)
    token = supplied.get('Authorization') or body.get('token')
    if not isinstance(token, str) or not 1 <= len(token) <= 16000 or body.get('token') not in (None, token):
        refused()
    if any(name.lower().startswith('x-tss-screening-') for name in supplied):
        refused()
    # The proxy only records the actor already authenticated from the actual
    # source session. issue() still rechecks epoch, native password, current
    # actor/store/counter/check-in and original customer JWT under its own SQL
    # transaction, then commits before returning the short native grant.
    _alias, connection = database()
    if connection.in_atomic_block or not connection.get_autocommit():
        refused()
    secret = key()
    _origin, actor_id, _session_hash, _record = authenticated(request, secret, int(time.time()*1000))
    current = AuthenticatedCartRequest(request, actor_id)
    supplied.update(issue(current, token, body))
    if connection.in_atomic_block or not connection.get_autocommit():
        refused()
    supplied['Authorization'] = token
    supplied['Content-Type'] = 'application/json'
    # Requests uses independent connection/read bounds. There is no retry on
    # timeout, redirect following, private response logging or held grant SQL.
    original_timeout = original_options.get('timeout')
    read_timeout = 20 if original_timeout is None else original_timeout
    if type(read_timeout) not in (int, float) or not 0 < read_timeout <= 30:
        refused()
    response = requests.post(url, json=body, headers=supplied, timeout=(5, read_timeout), allow_redirects=False, stream=True)
    try:
        chunks, size = [], 0
        for chunk in response.iter_content(chunk_size=65536):
            size += len(chunk)
            if size > MAX_RESPONSE:
                refused()
            chunks.append(chunk)
        # Preserve the genuine original requests.Response contract, including
        # status, headers and exact body used by the unchanged caller's json().
        response._content = b''.join(chunks)
        response._content_consumed = True
    finally:
        response.close()
    return response
