"""Bounded GET-only snapshot of the source's two global coupon cache keys."""
import copy
import json
from benefit_source import BenefitReview
from transaction import CURRENT

KEYS = ('auto_apply_coupon', 'birthday_coupon')


class ConfigurationSnapshot:
    def __init__(self, values):
        if not isinstance(values, dict) or set(values) != set(KEYS):
            raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        self.values = {}
        for name, value in values.items():
            if value is not None:
                if not isinstance(value, (str, bytes)) or len(value) > 16000:
                    raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
                parsed = json.loads(value)
                if not isinstance(parsed, dict):
                    raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
                self.values[name] = copy.deepcopy(value)

    def exists(self, name):
        if name not in KEYS: raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        return name in self.values

    def get(self, name):
        if name not in KEYS: raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        return self.values.get(name)


def source_configuration_snapshot(source, *, redis_module=None):
    """Clone only the trusted source connection options, never a request URL.

    A private bounded pool keeps existing source clients unchanged. MULTI/EXEC
    contains only two GETs: wrong-type keys fail as the literal GET would, and
    no warming, claims, TTL refresh or invalidation is performed.
    """
    if CURRENT.get() is not None:
        raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
    try:
        if redis_module is None:
            import redis as redis_module
        from redis.retry import Retry
        from redis.backoff import NoBackoff
        from source_runtime import ReadOnlyCache
        original = source
        for _ in range(8):
            if not isinstance(original, ReadOnlyCache): break
            original = original.source
        else:
            raise ValueError()
        pool = original.connection_pool
        options = dict(pool.connection_kwargs)
        options.update(socket_connect_timeout=1.0, socket_timeout=1.0,
                       retry_on_timeout=False, retry_on_error=[], retry=Retry(NoBackoff(), 0))
        bounded = redis_module.ConnectionPool(connection_class=pool.connection_class,
                                             max_connections=1, **options)
        try:
            client = redis_module.Redis(connection_pool=bounded)
            with client.pipeline(transaction=True) as commands:
                for name in KEYS: commands.get(name)
                values = commands.execute()
            if not isinstance(values, list) or len(values) != len(KEYS): raise ValueError()
            return ConfigurationSnapshot(dict(zip(KEYS, values)))
        finally:
            bounded.disconnect()
    except Exception:
        raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED') from None
