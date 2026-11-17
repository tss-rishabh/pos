"""Read native replacement evidence only from an owned, disposable MySQL fixture."""
import json
from pathlib import Path
import re
import sys

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'compatibility/upstream/legacy-order-imports'))
from native import native_order
from protocol import ImportReview


def main():
    value=json.load(sys.stdin)
    url=make_url(value['url'])
    if (url.drivername!='mysql' or url.host not in ('localhost','127.0.0.1')
            or url.query or not re.fullmatch(r'pos_rewrite_import_runtime_[a-f0-9]{12}',url.database or '')):
        raise ValueError('Disposable native membership fixture required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    try:
        with Session(engine) as session:
            try:
                _header,lines,line_hash,payable=native_order(session,5001,value['plan'],value['capability'],
                    value['additional'],value['replaced'])
                return {'lines':lines,'lineHash':line_hash,'payable':payable}
            except ImportReview as error:
                return {'code':error.code}
            finally:session.rollback()
    finally:engine.dispose()


if __name__=='__main__':
    try:print(json.dumps(main(),separators=(',',':')))
    except BaseException:
        print('{"fixtureError":"NATIVE_REPLACEMENT_FIXTURE_FAILED"}')
        sys.exit(1)
