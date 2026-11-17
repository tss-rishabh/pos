"""Pinned source import boundary, no original DB/provider/main initialization."""
import os
import inspect
from pathlib import Path
import sys
import tempfile
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import patch

from protocol import ImportReview
from source_runtime import SourceRuntime,bind_source_sessions,SilentLogger,ReadOnlyCache,SOURCE_REDIS_ALIASES
from transaction import PrivateSessionProxy,private_session

HERE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',str(HERE.parents[4]/'backend-tss-api_v2')))
FILES=('database/__init__.py','database/database.py','database/WriteDbConn.py')
ALIASES={'database.database':('Session','SessionR','SessionC','SessionReadCMS'),'database.WriteDbConn':('Session',)}


class Settings(ModuleType):
    def __getattr__(self,name):
        if name.startswith('__'):raise AttributeError(name)
        if name in ('USER','PASSWORD','HOST','DBPORT','DATABASE'):
            raise AssertionError('Original SQL credential expression evaluated')
        return 1


class Startup(unittest.TestCase):
    def environment(self):
        settings=Settings('settings');settings.__file__=str(ROOT/'settings.py')
        logger=ModuleType('utils.logger');logger.get_logger=lambda:SilentLogger()
        utils=ModuleType('utils');utils.__path__=[];utils.logger=logger
        redis=ModuleType('redis');clients=[]
        class Client:
            def __init__(self,*_args,**_kwargs):self.reads=[];clients.append(self)
            def get(self,key):self.reads.append(key);return b'controlled-source-read'
            def __getattr__(self,_name):raise AssertionError('Provider I/O during source bootstrap')
        redis.Redis=Client
        modules={'settings':settings,'redis':redis,'utils':utils,'utils.logger':logger}
        return modules,clients

    def bind(self):
        proxy=PrivateSessionProxy();bind_source_sessions(ROOT,proxy);return proxy

    def test_actual_pinned_aliases_and_factories_never_construct_original_engines(self):
        modules,clients=self.environment()
        with patch.dict(sys.modules,modules),patch('sqlalchemy.create_engine',side_effect=AssertionError('Original SQL engine constructed')),patch('sqlalchemy.orm.sessionmaker',side_effect=AssertionError('Original SQL session factory constructed')):
            proxy=self.bind()
            self.assertNotIn('database.ReadDbConn',sys.modules)
            self.assertEqual(len(clients),8)
            aliases=[]
            for name,names in ALIASES.items():
                for alias in names:
                    value=getattr(sys.modules[name],alias);self.assertIs(value,proxy);aliases.append(value)
            for value in aliases:
                with self.assertRaises(ImportReview):value.execute('SELECT 1')
            for name in ('database.database','database.WriteDbConn'):
                with self.assertRaises(ImportReview):sys.modules[name].engine.connect()
                with self.assertRaises(ImportReview):sys.modules[name].session_factory()
            creator=sys.modules['database'].make_sessions
            inputs={name:None for name,value in inspect.signature(creator).parameters.items() if value.default is inspect.Parameter.empty}
            with self.assertRaises(ImportReview) as error:creator(**inputs)
            self.assertEqual(error.exception.code,'ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')
            calls=[]
            native=SimpleNamespace(execute=lambda statement,params,**_kwargs:calls.append(str(statement)) or object(),flush=lambda:None)
            with private_session(native) as current:
                for value in aliases:
                    self.assertIs(value.current(),current);value.execute('SELECT 1')
                for name in ('database.database','database.WriteDbConn'):
                    self.assertIs(sys.modules[name].session_factory(),current)
            self.assertEqual(calls,['SELECT 1']*5)
            self.assertNotIn('main',sys.modules)

    def test_a_preimported_unqualified_alias_is_refused_before_bootstrap(self):
        modules,_clients=self.environment();modules['database.database']=ModuleType('database.database')
        with patch.dict(sys.modules,modules):
            with self.assertRaises(ImportReview) as error:self.bind()
            self.assertEqual(error.exception.code,'ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')

    def test_modified_database_source_is_rejected_before_modules_are_published(self):
        modules,_clients=self.environment()
        with tempfile.TemporaryDirectory(prefix='pos-source-session-pin-') as directory,patch.dict(sys.modules,modules):
            target=Path(directory)
            for name in FILES:
                path=target/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((ROOT/name).read_bytes())
            with (target/'database/WriteDbConn.py').open('a') as writer:writer.write('\n# Unqualified source change\n')
            before={name:sys.modules.get(name) for name in ('database','database.database','database.WriteDbConn')}
            with self.assertRaises(ImportReview) as error:bind_source_sessions(target,PrivateSessionProxy())
            self.assertEqual(error.exception.code,'ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
            self.assertEqual(before,{name:sys.modules.get(name) for name in before})

    def test_repeated_controlled_bootstrap_keeps_every_alias_on_the_owned_session(self):
        modules,_clients=self.environment()
        with patch.dict(sys.modules,modules):
            self.bind();proxy=self.bind()
            with private_session(SimpleNamespace(flush=lambda:None)) as current:
                for name,names in ALIASES.items():
                    for alias in names:self.assertIs(getattr(sys.modules[name],alias).current(),current)
                self.assertIs(sys.modules['database.database'].Session,proxy)

    def test_source_runtime_passes_import_boundary_and_wraps_all_eight_redis_aliases(self):
        modules,clients=self.environment()
        # Controller/model dependencies are inert here. The actual three pinned
        # database definitions and SourceRuntime constructor still execute.
        fake_names=('controllers.OrderController','controllers.CheckoutController','controllers.CartController',
                    'controllers.CatalogController','middleware.CartMiddleware','controllers.KinesisProducer',
                    'models.Order','tasks','controllers.cart.Cart')
        for name in fake_names:
            module=ModuleType(name);module.__file__=str(ROOT/(name.replace('.','/')+'.py'));modules[name]=module
        modules['controllers.CatalogController'].PosProductDetail=lambda:object()
        modules['controllers.CartController'].Cart=lambda:object()
        modules['middleware.CartMiddleware'].PosCartFactory=object()
        modules['middleware.CartMiddleware'].PricelistManager=object()
        modules['controllers.cart.Cart'].ItemTypes=object()
        for name in ('OrderModel','OrderStoreModel','HasProductModel'):setattr(modules['models.Order'],name,type(name,(),{}))
        codec=ModuleType('model_compat');codec.install_model_codec=lambda *_args:None;modules['model_compat']=codec
        requests=ModuleType('requests');requests.sessions=SimpleNamespace(Session=type('Session',(),{'request':lambda *_args,**_kwargs:(_ for _ in ()).throw(AssertionError('HTTP during bootstrap'))}));modules['requests']=requests
        requested=[]
        def import_module(name):
            requested.append(name)
            if name not in modules:raise AssertionError('Unqualified source import: '+name)
            return modules[name]
        def source_class(*_args,**_kwargs):return type('ControlledFixture',(),{})
        with patch.dict(sys.modules,modules),patch.dict(os.environ,{'POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT':''}),patch('source_runtime.compile_class',side_effect=source_class),patch('sqlalchemy.create_engine',side_effect=AssertionError('Original SQL engine constructed')),patch('source_runtime.importlib.import_module',side_effect=import_module):
            runtime=SourceRuntime(ROOT,ROOT)
            self.assertIsNotNone(runtime.order)
            self.assertIsNotNone(runtime.producer)
            self.assertNotIn('database.ReadDbConn',requested)
            self.assertNotIn('main',requested)
            for name,names in ALIASES.items():
                self.assertTrue(all(isinstance(getattr(sys.modules[name],alias),PrivateSessionProxy) for alias in names))
            self.assertEqual(len(SOURCE_REDIS_ALIASES),8)
            for alias in SOURCE_REDIS_ALIASES:
                value=getattr(sys.modules['database.database'],alias)
                self.assertIsInstance(value,ReadOnlyCache)
                self.assertEqual(value.get('opaque-fixture-key'),b'controlled-source-read')
                self.assertIs(value.set('opaque-fixture-key','not-published'),False)
                self.assertIs(value.eval('private-script-canary',0),False)
                self.assertIs(value.register_script('private-script-canary'),False)
                self.assertIs(value.pipeline(),False)
                self.assertIs(value.execute_command('SET','opaque-fixture-key','not-published'),False)
                self.assertIs(value.transaction(lambda *_args:(_ for _ in ()).throw(AssertionError('Transaction callback ran'))),False)
            self.assertEqual(sum(len(client.reads) for client in clients),8)


if __name__=='__main__':unittest.main()
