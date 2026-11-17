"""Source components for the disposable Node financial-composition fixture.

Never an application entrypoint. No source service/bootstrap, provider, broker,
cloud history or production schema is contacted. Original component arithmetic
and its independently qualified Python deduction oracle are retained.
"""
import json
import contextlib
import io
from decimal import Decimal
from pathlib import Path
import sys
from types import SimpleNamespace

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import native_driver as original
from benefit_source import source_coupon_deduction
from benefit_receipts import coupon_consumption_receipt, store_descriptor
from transaction import normalize_source_sentinels


def receipt(session, state, plan, line_items):
    value = original_receipt(session, state, plan, line_items)
    # The existing source-component fixture fixed counter3. This fixture binds
    # the same original source result to its actual native Store/Counter row.
    mapping = session.execute(text(
        "SELECT store_id,counter_id FROM order_stores WHERE order_id=5001 FOR UPDATE"
    )).mappings().all()
    if len(mapping) != 1 or str(mapping[0]['store_id']) != state['scope']['storeId'] or str(mapping[0]['counter_id']) != state['scope']['counterId']:
        raise RuntimeError('FIXTURE_SCOPE')
    return {**value, 'storeId': str(mapping[0]['store_id']), 'counterId': str(mapping[0]['counter_id'])}


original_receipt = original.source_receipt
original.source_receipt = receipt


if __name__ == '__main__':
    engine = None
    try:
        value = json.load(sys.stdin)
        url = make_url(value['url'])
        if url.host not in ('localhost', '127.0.0.1') or not url.database.startswith('pos_rewrite_import_runtime_') or url.query:
            raise RuntimeError('FIXTURE_SCOPE')
        engine = create_engine(url.set(drivername='mysql+pymysql'), echo=False, hide_parameters=True, isolation_level='READ COMMITTED')
        event.listen(Session, 'before_flush', normalize_source_sentinels)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), Session(engine) as session, session.begin():
            session.execute(text('SET timestamp=1781505000'))
            if value.get('mode') == 'preview':
                _, header, _ = original.source_line_products(raw=True)
                result = {'payable': format(Decimal(str(header['pay_amt'])), '.2f'),
                          'couponAmount': format(Decimal(str(header['coupon_amt_used'])), '.2f')}
            elif value.get('mode') == 'consume':
                saved = session.execute(text(
                    "SELECT proof,proof_hash FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=:operation AND kind='coupon-benefit' FOR UPDATE"
                ), {'operation': value['state']['scope']['operationId']}).mappings().one()
                coupon = json.loads(saved['proof']) if isinstance(saved['proof'], str) else saved['proof']
                deduction = source_coupon_deduction(original.ROOT, {'logger': original.SilentLogger()})
                deduction(original.Proxy(session), SimpleNamespace(id=5001, coupon_used=int(coupon['couponId'])), {'user_id': 77})
                activation, seal = coupon_consumption_receipt(session, coupon, saved['proof_hash'], value['confirmationHash'], value['key'])
                store_descriptor(session, value['state'], 'coupon-consume', activation, value['key'], value['now'])
                result = {'activation': activation, 'seal': seal}
            else:
                result = original.stage(session, value)
        print(json.dumps({'ok': True, 'result': result}, separators=(',', ':'), allow_nan=False))
    except Exception as error:
        # Captured fixture output must not contain SQL/driver URLs or key data.
        import traceback
        native=getattr(error,'orig',None)
        args=getattr(native,'args',())
        print(json.dumps({'ok': False, 'code': 'BENEFIT_FINANCIAL_FIXTURE_FAILURE',
            'nativeCode':args[0] if args and type(args[0]) is int else None,
            'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)][-6:]}, separators=(',', ':')))
    finally:
        if engine is not None:
            engine.dispose()
