"""Execute the real pinned voucher ORM constructor and candidate on LOCAL fixtures only."""
import ast
import datetime
import enum
import json
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
from urllib.parse import urlparse, unquote

from sqlalchemy import (BigInteger, Column, Date, DateTime, Enum, Float, Integer,
                        SmallInteger, String, Text, create_engine, text)
from sqlalchemy.engine import URL
from sqlalchemy.orm import declarative_base, sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from prepare_patches import TARGETS, original


class BadRequest(Exception):
    pass


def declarations(source, names, scope):
    nodes=[node for node in ast.parse(source).body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names]
    if len(nodes)!=len(names):
        raise RuntimeError('SOURCE_DECLARATION_CHANGED')
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'<pinned-gift-orm>','exec'),scope)
    return scope


def main():
    request=json.loads(sys.stdin.buffer.readline(8192))
    if set(request)!={'url'}:
        raise RuntimeError('ISOLATED_FIXTURE_REQUIRED')
    url=urlparse(request['url'])
    if (url.scheme!='mysql' or url.hostname not in ('127.0.0.1','localhost') or url.query or url.fragment
            or not __import__('re').fullmatch(r'/pos_rewrite_gift_issuance_test_[a-f0-9]{12}',url.path)):
        raise RuntimeError('ISOLATED_FIXTURE_REQUIRED')
    repository,revision=TARGETS['api-v2']
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=repository,text=True).strip()!=revision:
        raise RuntimeError('SOURCE_REVISION_CHANGED')
    engine=create_engine(URL.create('mysql+pymysql',username=unquote(url.username or ''),password=unquote(url.password or ''),host=url.hostname,port=url.port or 3306,database=url.path[1:]),pool_pre_ping=True)
    factory=sessionmaker(bind=engine,expire_on_commit=False)
    base=declarative_base()
    model_scope=dict(Base=base,enum=enum,datetime=datetime,Column=Column,Integer=Integer,BigInteger=BigInteger,String=String,Float=Float,SmallInteger=SmallInteger,Date=Date,DateTime=DateTime,Enum=Enum,Text=Text)
    declarations(original('api-v2','models/GiftVoucher.py'),['GV_TYPE','GV_PLATFORM','GiftVoucherModal'],model_scope)
    model=model_scope['GiftVoucherModal']

    class Line(base):
        __tablename__='gift_issuance_lines'
        id=Column(BigInteger,primary_key=True)
        voucher_id=Column(BigInteger)
        order_id=Column(BigInteger)

    source=declarations(original('api-v2','libs/OrderHelper.py'),['build_gift_voucher_model'],dict(datetime=datetime.datetime,GiftVoucherModal=model,get_gift_cards=lambda serial:(True,1,'GC-'+str(serial))))
    candidate_source=(ROOT/'payload/controllers/cart/pos_gift_card_issuance.py').read_text()
    functions=[node.name for node in ast.parse(candidate_source).body if isinstance(node,ast.FunctionDef)]
    candidate=declarations(candidate_source,functions,dict(re=__import__('re'),text=text,falcon=SimpleNamespace(HTTPBadRequest=BadRequest)))
    persist=candidate['persist_pos_gift_voucher']

    def card(serial=990111):
        return source['build_gift_voucher_model']({'gvamount':1234},{'user_id':777},SimpleNamespace(id=7001),is_pos=True,serial_no=serial,start_date='11/16/2026',end_date='02/14/2027')

    def line(identifier):
        return [Line(voucher_id=identifier,order_id=7001)]

    with engine.connect() as connection:
        before=connection.scalar(text('SELECT @@SESSION.sql_mode'))
    if 'STRICT_TRANS_TABLES' not in before:
        raise RuntimeError('STRICT_FIXTURE_REQUIRED')
    legacy_failed=False
    with factory() as session:
        try:
            session.add(card());session.commit()
        except Exception as error:
            session.rollback()
            if getattr(getattr(error,'orig',None),'args',(None,))[0]!=1366:
                raise RuntimeError('UNEXPECTED_LEGACY_FAILURE') from None
            legacy_failed=True
    if not legacy_failed:
        raise RuntimeError('LEGACY_EMPTY_PHONE_NOT_OBSERVED')
    with factory() as session:
        value=card()
        identifier=persist(session,value,line)
        if not identifier or value.to_phone!=0 or value.voucher_value!=1234 or value.voucher_initial_value!=1234 or value.voucher_code!='GC-990111' or value.status!=0:
            raise RuntimeError('SOURCE_VALUE_CHANGED')
    with factory() as session:
        try:
            persist(session,card(),line)
        except BadRequest:
            pass
        else:
            raise RuntimeError('DUPLICATE_ISSUANCE')
    with factory() as session:
        try:
            persist(session,card(990121),lambda identifier:(_ for _ in ()).throw(RuntimeError('CONTROLLED_LINE_FAILURE')))
        except RuntimeError:
            pass
        else:
            raise RuntimeError('LATE_FAILURE_IGNORED')
    # Native row lock: block wins and the actual candidate waits, then refuses.
    blocker=engine.connect();transaction=blocker.begin()
    blocker.execute(text('UPDATE gift_card_collection SET is_block=1 WHERE id=1'))
    finished=threading.Event();outcomes=[]
    def attempted():
        with factory() as session:
            try:
                persist(session,card(990131),line)
            except BadRequest:
                outcomes.append('blocked')
            except Exception:
                outcomes.append('failed')
            else:
                outcomes.append('issued')
            finally:
                finished.set()
    worker=threading.Thread(target=attempted,daemon=True);worker.start()
    bypassed=finished.wait(0.1)
    transaction.commit();blocker.close()
    worker.join(5)
    if bypassed or not finished.is_set() or outcomes!=['blocked']:
        raise RuntimeError('COLLECTION_LOCK_NOT_SHARED')
    with engine.connect() as connection:
        if connection.scalar(text('SELECT COUNT(*) FROM gift_vouchers'))!=1 or connection.scalar(text('SELECT COUNT(*) FROM gift_issuance_lines'))!=1:
            raise RuntimeError('PARTIAL_GIFT_WRITE')
        if connection.scalar(text('SELECT @@SESSION.sql_mode'))!=before:
            raise RuntimeError('SQL_MODE_CHANGED')
    engine.dispose()
    print(json.dumps({'checks':7,'strictModeUnchanged':True,'vouchers':1,'lines':1,'funded':0}))


if __name__=='__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('GIFT_CARD_NATIVE_FIXTURE_FAILED\n')
        raise SystemExit(1) from None
