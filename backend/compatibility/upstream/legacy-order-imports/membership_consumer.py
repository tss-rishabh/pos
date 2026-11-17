"""Dedicated Celery consumer factory for reviewed import membership invalidation.

Example: python membership_consumer.py worker --logfile=/dev/null
--without-gossip --without-mingle --without-heartbeat -Q <approved-private-queue>.
Use a separate process and the same private runtime/source/DB/TLS configuration.
"""
import sys
from protocol import ImportReview


def create_consumer():
    try:
        # Initializes the same pinned private source runtime and closes source
        # stdout/stderr/logging before source imports or consumer execution.
        from runtime import _create_application
        from membership_profile import selected
        from membership_cache import TASK
        if not selected():
            raise ImportReview()
        _create_application()
        app=sys.modules['tasks'].app
        if TASK not in app.tasks:
            raise ImportReview()
        return app
    except Exception:
        raise ImportReview('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED') from None


if __name__=='__main__':
    create_consumer().worker_main(sys.argv[1:])
