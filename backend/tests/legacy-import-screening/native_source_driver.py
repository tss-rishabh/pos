"""Disposable source fixture with the real screening helper/model/PosOrder body.

No upstream file is changed. The production candidate is screening_profile.py;
this fixture only extends the existing literal-source runner's model selection.
"""
import ast
import datetime
import hashlib
import json
import sys
import tempfile
import time
from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'compatibility/upstream/legacy-order-imports'))
import native_source_driver as original_driver
from native_source_driver import NativePipeline, Cart, K
from profiles import assert_plain_profile
from screening_profile import ScreeningSourceRuntime, CONTRACT, SCHEMA, WRITERS, SOURCE
from protocol import ImportReview
from receiver import Receiver
from transaction import normalize_source_sentinels, guard_private_statement, guard_private_commit

original_compile = original_driver.compile_class
FIXTURE_ADDRESS = 88


def compile_screening(root, path, name, namespace):
    if name == 'PosOrder':
        helper = (Path(root) / 'libs/OrderHelper.py').read_bytes()
        model = (Path(root) / 'models/Order.py').read_bytes()
        controller = (Path(root) / 'controllers/OrderController.py').read_bytes()
        if any(hashlib.sha256(raw).hexdigest() != SOURCE[key] for raw, key in
               ((helper, 'helperHash'), (model, 'modelHash'), (controller, 'controllerHash'))):
            raise ImportReview('ORDER_IMPORT_SCREENING_UNQUALIFIED')
        funcs = [node for node in ast.parse(helper).body if isinstance(node, ast.FunctionDef) and node.name in
                 {'get_screening_tickets_bought', 'enforce_screening_ticket_limit'}]
        namespace['SCREENING_MAX_TICKETS'] = 2
        exec(compile(ast.Module(body=funcs, type_ignores=[]), '<pinned-screening-native-helpers>', 'exec'), namespace)
        marker = next(node for node in ast.parse(model).body if isinstance(node, ast.ClassDef) and node.name == 'SpidermanScreeningOrderModel')
        models = {**namespace, 'datetime': datetime}
        exec(compile(ast.Module(body=[marker], type_ignores=[]), '<pinned-screening-model>', 'exec'), models)
        namespace['SpidermanScreeningOrderModel'] = models['SpidermanScreeningOrderModel']
        namespace['build_address_model'] = lambda *_args, **_kwargs: (None, FIXTURE_ADDRESS)
    return original_compile(root, path, name, namespace)


original_driver.compile_class = compile_screening


class QualifiedNativePipeline(NativePipeline):
    def _order_pipeline(self, session, user, plan, capability):
        global FIXTURE_ADDRESS
        FIXTURE_ADDRESS = 88 if str(user['user_id']) == '77' else 89
        # The inherited entry point and its base admission globals match
        # SourceRuntime, so selected profiles wrap the one real base guard.
        result = super()._order_pipeline(session, user, plan, capability)
        if self.mode == 'screening-race':
            print('SCREENING_BODY_READY', flush=True)
            deadline = time.monotonic() + 10
            while not self.fixture_gate.is_file():
                if time.monotonic() >= deadline:
                    raise ImportReview('ORDER_IMPORT_SCREENING_FIXTURE_TIMEOUT')
                time.sleep(0.01)
        return result


def run(value):
    url = make_url(value['url'])
    if (url.host not in ('127.0.0.1', 'localhost') or not url.database.startswith('pos_rewrite_import_runtime_') or
        len(url.database) != len('pos_rewrite_import_runtime_') + 12 or url.query):
        raise ImportReview('ORDER_IMPORT_SCREENING_FIXTURE_REQUIRED')
    engine = create_engine(url.set(drivername='mysql+pymysql'), echo=False, hide_parameters=True)
    event.listen(Session, 'before_flush', normalize_source_sentinels)
    event.listen(Session, 'before_commit', guard_private_commit)
    event.listen(engine, 'before_cursor_execute', guard_private_statement)
    source = QualifiedNativePipeline(value['sourceRoot'], value.get('mode'))
    if value.get('mode') == 'screening-race':
        gate = Path(value['gate']).resolve()
        if (gate.name != 'release' or gate.parent.parent != Path(tempfile.gettempdir()).resolve()
                or not gate.parent.name.startswith('pos-screening-source-race-')):
            raise ImportReview('ORDER_IMPORT_SCREENING_FIXTURE_REQUIRED')
        source.fixture_gate = gate
    source.settings.IS_LINE_ITEM_ENABLED = value['unitMode']
    pipeline = ScreeningSourceRuntime(source, value['authKey'], value['proofKey'], lambda: value['now'],
                                      {'profile': CONTRACT, 'schema': SCHEMA, 'writers': WRITERS})
    service = Receiver(sessionmaker(bind=engine, expire_on_commit=False), pipeline, value['authKey'], value['proofKey'], clock=lambda: value['now'])
    try:
        return service.order(value['operationId'], value['body'])
    finally:
        engine.dispose()


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.loads(sys.stdin.read())), separators=(',', ':')))
    except ImportReview as error:
        print(json.dumps({'code': error.code}, separators=(',', ':')))
    except Exception:
        # Never serialize native exceptions, source/customer data or credentials.
        print('{"code":"SCREENING_NATIVE_FIXTURE_FAILED"}')
        sys.exit(1)
