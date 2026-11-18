"""Readonly disposable-native revision metadata probe; no error/row logs."""
import json
import os
from pathlib import Path
import sys


def main():
    raw = sys.stdin.buffer.read(24001)
    if len(raw) > 24000:
        raise ValueError()
    value = json.loads(raw)
    if set(value) != {'url', 'environment'}:
        raise ValueError()
    root = Path(__file__).resolve().parents[2]
    sys.path[:0] = [str(root/'compatibility/upstream'/name) for name in
                   ('screening-origins', 'legacy-order-imports', 'public-screening-writer')]
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import Session
    from origin_history_privileges import qualified_head_metadata
    url = make_url(value['url'])
    if url.host not in ('localhost', '127.0.0.1') or not url.database.startswith('native_head_revision_'):
        raise ValueError()
    os.environ.update(value['environment'])
    engine = create_engine(url.set(drivername='mysql+pymysql'), echo=False, hide_parameters=True,
                           connect_args={'connect_timeout': 5, 'read_timeout': 10, 'write_timeout': 10})
    try:
        with engine.connect().execution_options(isolation_level='REPEATABLE READ') as connection:
            connection.exec_driver_sql('START TRANSACTION READ ONLY')
            session = Session(bind=connection)
            try:
                result = qualified_head_metadata(session)
                visible = session.execute(text("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email')")).scalar_one()
                return {'allowed': True, 'revisionTriggers': len(result['membershipRevisionTriggers']),
                        'appVisibleTriggers': int(visible)}
            finally:
                session.close()
                connection.rollback()
    finally:
        engine.dispose()


if __name__ == '__main__':
    try:
        result = main()
    except BaseException:
        result = {'allowed': False, 'revisionTriggers': 0, 'appVisibleTriggers': 0}
    sys.stdout.write(json.dumps(result, separators=(',', ':')))
