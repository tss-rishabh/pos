"""Readonly local native qualifier probe. Inputs/results never enter logs."""
import json
import os
from pathlib import Path
import sys

def main():
    value=json.loads(sys.stdin.buffer.read(24001))
    if set(value)!={'url','environment'}:raise ValueError()
    root=Path(__file__).resolve().parents[2]
    sys.path[:0]=[str(root/'compatibility/upstream'/name) for name in ('screening-origins','legacy-order-imports','public-screening-writer')]
    from sqlalchemy import create_engine,text
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import Session
    from origin_history_privileges import qualified_head_metadata
    url=make_url(value['url'])
    if url.host not in ('localhost','127.0.0.1') or not url.database.startswith('pos_rewrite_'):raise ValueError()
    os.environ.update(value['environment'])
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True,
        connect_args={'connect_timeout':5,'read_timeout':10,'write_timeout':10})
    try:
        with engine.connect().execution_options(isolation_level='READ COMMITTED') as connection:
            connection.exec_driver_sql('START TRANSACTION READ ONLY')
            session=Session(bind=connection)
            try:
                session.execute(text('SELECT COUNT(*) FROM users')).close()
                qualified_head_metadata(session)
            finally:session.close();connection.rollback()
        return True
    finally:engine.dispose()

if __name__=='__main__':
    try:allowed=main()
    except BaseException:allowed=False
    sys.stdout.write(json.dumps({'allowed':allowed},separators=(',',':')))
