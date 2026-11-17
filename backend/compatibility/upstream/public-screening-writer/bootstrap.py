"""Public API bootstrap; dynamic routing changes selected Node POS frames only."""
import importlib
import hashlib
import json
import os
import sys
from pathlib import Path
from sqlalchemy import event
from sqlalchemy.orm import sessionmaker
from source_frame import (FRAME,RoutedSession,NodePosWriterMiddleware,route_exports,
                          qualify_source,after_validate as frame_after_validate)
from writer_protocol import ScreeningWriterError,fail
from transaction import guard_private_statement,guard_private_commit
from transaction import normalize_source_sentinels


class Bootstrap:
    def __init__(self,root,environment=None):
        self.environment=os.environ if environment is None else environment
        self.root=Path(root).resolve()
        self.base=qualify_source(self.environment['POS_LEGACY_IMPORT_SOURCE_ROOT'])
        manifest=json.loads((Path(__file__).parent/'manifest.json').read_text())
        for name in ('main.py','controllers/OrderController.py'):
            if hashlib.sha256((self.root/name).read_bytes()).hexdigest()!=manifest['candidate'][name]:
                fail('SCREENING_WRITER_SOURCE_UNVERIFIED')
        self.middleware=None
        # Original public API engines remain its ordinary defaults. Capture the
        # actual writer engine without opening a connection, then route every
        # exported scoped session before a controller can capture an old alias.
        self.modules=[importlib.import_module(name) for name in ('database.database','database.WriteDbConn')]
        writer=self.modules[0].Session
        factory=getattr(writer,'session_factory',None)
        bind=getattr(factory,'kw',{}).get('bind')
        if bind is None:fail('SCREENING_WRITER_UNAVAILABLE')
        self.sessions=sessionmaker(bind=bind,expire_on_commit=False)
        event.listen(bind,'before_cursor_execute',guard_private_statement)
        # Session.before_commit also fires for RELEASE SAVEPOINT. Guard the
        # physical connection COMMIT so nested source rollback stays available.
        event.listen(bind,'commit',guard_private_commit)
        event.listen(self.sessions.class_,'before_flush',normalize_source_sentinels)
        for module in self.modules:
            for name in ('Session','SessionR','SessionC','SessionReadCMS'):
                if hasattr(module,name):setattr(module,name,RoutedSession(getattr(module,name)))
        import requests
        original=requests.sessions.Session.request
        def controlled(instance,*args,**kwargs):
            if FRAME.get() is not None:
                FRAME.get().tainted=True
                fail('SCREENING_WRITER_HTTP_UNQUALIFIED')
            return original(instance,*args,**kwargs)
        requests.sessions.Session.request=controlled
    def routes(self,*sessions):return tuple(RoutedSession(session) for session in sessions)
    def order_resource(self,resource):
        class ProtectedOrder:
            def on_post(self,req,resp):
                try:return resource.on_post(req,resp)
                except Exception as error:
                    if FRAME.get() is None:raise
                    FRAME.get().remember_rejection(error)
                    static_http_error(error)
        return ProtectedOrder()
    def activate(self,namespace):
        # Existing approved refund patch remains part of the composed source.
        # Never silently run the original duplicate-SKU refund overwrite.
        from source_refunds import refund_tree
        refund_tree(self.base,'pos-refund-per-hp-v1')
        env=self.environment
        from model_compat import CONTRACT as MODEL_CONTRACT,verify_physical_columns,install_model_codec
        if env.get('POS_LEGACY_IMPORT_MODEL_CONTRACT')!=MODEL_CONTRACT:fail('SCREENING_WRITER_SOURCE_MODEL_UNQUALIFIED')
        # Explicit global physical mapping correction, independently reviewed.
        # Selected sentinel normalization remains scoped to CURRENT only.
        with self.sessions() as session:
            connection=session.connection()
            verify_physical_columns(connection)
            from sqlalchemy import text
            dates=connection.execute(text("SELECT COLUMN_NAME,IS_NULLABLE,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME IN ('ship_date','ret_ex_request_date')")).mappings().all()
            if len(dates)!=2 or any(row['IS_NULLABLE']!='YES' or row['DATA_TYPE']!='datetime' for row in dates):fail('SCREENING_WRITER_ORDER_SCHEMA_UNQUALIFIED')
        models=importlib.import_module('models.Order')
        install_model_codec(models.OrderModel,models.OrderStoreModel,models.HasProductModel)
        contracts={'node':env.get('POS_NODE_SCREENING_WRITER_CONTRACT'),
                   'profile':env.get('POS_LEGACY_IMPORT_SCREENING_CONTRACT'),
                   'schema':env.get('POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT'),
                   'writers':env.get('POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT')}
        # Use the actual existing AuthHandler helper's configuration name;
        # no guessed alias or new customer signing secret is introduced.
        context=importlib.import_module('middleware.PosCustomerContext')
        self.middleware=NodePosWriterMiddleware(self.sessions,self.base,env.get(context.KEY_ENVIRONMENT),
            env.get('POS_LEGACY_IMPORT_PROOF_KEY'),contracts,namespace,namespace['tasks'],namespace['settings'].IS_LINE_ITEM_ENABLED)
        # Capture no private request data in original debug/exception logging;
        # source tasks and all eight Redis aliases are selected-frame proxies.
        route_exports(self.root,tuple(sys.modules.values()))
        for name in ('CartFactory','PosCartFactory'):
            factory=getattr(importlib.import_module('middleware.CartMiddleware'),name)
            original=factory.persistent_cart
            def controlled(*args,_original=original,_factory=factory,**kwargs):
                if FRAME.get() is not None:
                    return _factory.empty_cart(**kwargs)
                return _original(*args,**kwargs)
            factory.persistent_cart=staticmethod(controlled)
        return self
    def process_request(self,req,resp):
        if self.middleware is None:fail('SCREENING_WRITER_UNAVAILABLE')
        try:self.middleware.process_request(req,resp)
        except Exception as error:static_http_error(error)
    def process_response(self,req,resp,resource,req_succeeded):
        try:
            if self.middleware is not None:self.middleware.process_response(req,resp,resource,req_succeeded)
        except Exception as error:static_http_error(error)


def install(root):return Bootstrap(root)


def static_http_error(error):
    import falcon
    code=error.code if isinstance(error,ScreeningWriterError) else 'SCREENING_WRITER_RECONCILIATION_REQUIRED'
    raise falcon.HTTPConflict(title=code,description='The original screening sale needs verification. Keep its reference; do not place another order.') from None


def after_validate(req):
    try:return frame_after_validate(req)
    except Exception as error:static_http_error(error)
