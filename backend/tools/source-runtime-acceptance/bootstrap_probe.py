"""Network-disabled actual SourceRuntime bootstrap probe, fixtures only.

Settings are compiled from source with a declared generated fixture environment;
dotenv discovery is disabled, and no developer/source .env is opened. This is
dependency/import evidence, not certification of production catalog/cache data.
"""
import ast
import contextlib
import hashlib
import io
import json
import logging
import os
import sys
import tempfile
import traceback
from pathlib import Path
from types import ModuleType,SimpleNamespace
from unittest.mock import patch

ROOT=Path('/owned')
SOURCE=Path('/source')


def settings_fixture():
    tree=ast.parse((SOURCE/'settings.py').read_bytes());parents={child:node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    env={}
    for node in ast.walk(tree):
        if (isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='get'
                and isinstance(node.func.value,ast.Name) and node.func.value.id=='ENV' and node.args and isinstance(node.args[0],ast.Constant)):
            if len(node.args)>1:continue
            name=node.args[0].value;parent=parents.get(node)
            value='fixture'
            if isinstance(parent,ast.Call):
                function=ast.unparse(parent.func)
                if function in ('int','float'):value='0'
                elif function=='json.loads':value='[]'
            env[name]=value
    env.update(PORT='8000',DBPORT='3306',R_DBPORT='3306',V1_HOST='https://fixture.invalid/',
        EXCULSIVE_LAUNCH_DATE='2020-01-01 00:00:00',START_DATE_TIME='2020-01-01 00:00:00',END_DATE_TIME='2030-01-01 00:00:00',
        BIRTHDAY_SALE_START='2020-01-01 00:00:00',BIRTHDAY_SALE_END='2030-01-01 00:00:00',
        EXCLUSIVE_PRODUCT='{}',EXCLUSIVE_UPGRADE_PRODUCT='{}',EXCLUSIVE_UPGRADE_PRODUCT_INFO='{}',EXCLUSIVE_PRODUCT_INFO='{}',
        BEAKER_REDIS_URL='redis://fixture.invalid:6379/9',MONGO_HOST='fixture.invalid',MONGO_PORT='27017',
        MONGO_DATABASE='fixture',POS_MONGO_DATABASE='fixture',REDIS_PORT='6379',CMS_REDIS_PORT='6379',
        USER_REDIS_PORT='6379',BLACKLIST_REDIS_PORT='6379',PAYMENT_REDIS_PORT='6379',REDIS_BUFFER_PORT='6379',
        CART_PROCESS_ORDER_TRACK='1',CHECKOUT_DOMAIN='https://fixture.invalid/',LOGGING_PATH='/tmp/pos-fixture',
        LOGIN_API_V2_EXPIRY_DATE='2030-01-01')
    # No fixture credentials can authenticate to a service.
    for name in env:
        if name.endswith('_QUEUE'):env[name]='fixture-'+name.lower()
    dotenv=ModuleType('dotenv');dotenv.load_dotenv=lambda *_a,**_k:None;dotenv.find_dotenv=lambda *_a,**_k:''
    module=ModuleType('settings');module.__file__=str(SOURCE/'settings.py')
    with patch.dict(sys.modules,{'dotenv':dotenv}),patch.dict(os.environ,env,clear=False):
        exec(compile(tree,'<fixture-source-settings>','exec'),module.__dict__)
    sys.modules['settings']=module
    return module


def run():
    sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
    settings=settings_fixture()
    from source_runtime import SourceRuntime
    queues=sorted(set(value for name,value in vars(settings).items() if name.endswith('_QUEUE') and isinstance(value,str) and value))
    queues+=['pos-import-effects']+['user_cart_track_'+str(i) for i in range(10)]
    queues=sorted(set(queues))
    with tempfile.NamedTemporaryFile() as ca:
        environment={'POS_LEGACY_IMPORT_CELERY_CONTRACT':'pos-import-owned-celery-v1',
            'POS_LEGACY_IMPORT_BROKER_URL':'amqps://fixture:fixture@broker.invalid/private',
            'POS_LEGACY_IMPORT_EFFECT_QUEUES':json.dumps(queues),'POS_LEGACY_IMPORT_BROKER_CA_FILE':ca.name}
        attempts=[]
        def forbidden(kind):
            def blocked(*_a,**_k):attempts.append(kind);raise AssertionError('Fixture external effect was refused')
            return blocked
        from botocore.client import BaseClient
        from celery.app.control import Control
        from celery.app.task import Task
        import redis
        with patch.dict(os.environ,environment),patch.object(BaseClient,'_make_api_call',forbidden('aws-api')),patch.object(Control,'add_consumer',forbidden('celery-control')),patch.object(Task,'apply_async',forbidden('celery-publish')),patch.object(redis.Redis,'execute_command',forbidden('redis-command')):
            pipeline=SourceRuntime(SOURCE,SOURCE)
            module=sys.modules['middleware.CartMiddleware']
            names=[getattr(value,'__name__',type(value).__name__) for value in module.default_wrappers]
        if attempts:raise AssertionError('Unowned external source effect attempted')
    return {'stage':'actual-source-runtime-initialized','wrappers':names,'externalCalls':0}


if __name__=='__main__':
    output=sys.stdout;logging.disable(logging.CRITICAL)
    # Original libraries may print at import. Never expose source configuration,
    # raw dependency exceptions or captured fixture payloads in probe output.
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        try:result=run()
        except Exception as error:
            result={'stage':'actual-source-runtime-refused','errorType':type(error).__name__,
                    'frames':[Path(frame.filename).name+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)]}
            if isinstance(error,(ModuleNotFoundError,ImportError)):
                result['dependency']=getattr(error,'name',None)
    output.write(json.dumps(result,separators=(',',':'))+'\n')
