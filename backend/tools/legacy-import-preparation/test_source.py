"""Literal pinned source control flow, no network/DB/credential availability."""
import io
import json
from copy import deepcopy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports'))
from protocol import digest,PREPARATION_CONTRACT,verify_preparation,verify_capability,ImportReview
from transaction import private_session,CURRENT,PrivateSessionProxy
from effects import CAPTURE
from membership_handoff import CURRENT_HISTORY,prepared_history,signed
from membership_history import signature
from order_preparation import NeedHistory,HistoryProbe
from cart_preparation import guard_history,HISTORY_QUERIES,BUILDING,PREVIEW_ONLY,read_only_preview,preview_effect,catalog_build,automatic_membership
from http_app import private_application
from source_fixture import pipeline,pinned_source

ROOT=Path(os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT'])
NOW=1794897003000
KEY='private-preview-fixture-auth-0123456789'
PROOF='private-preview-fixture-proof-0123456789'
HISTORY='private-preview-fixture-history-0123456789'
OP='6833dbdb-c3ca-4805-b0da-367dd111a359'
ATTEMPT='a1c42876-1ab7-4668-bec7-68fe4ff568b9'


def cap(plan):
    value={'contract':PREPARATION_CONTRACT,'purpose':'source-cart-preview','operationId':OP,'attemptId':ATTEMPT,
        'requestHash':'a'*64,'planHash':'b'*64,'namespace':'pos-import-v1:'+OP,
        'planDigest':digest(KEY,'plan',plan),'authorityHash':'c'*64,
        'scope':{'actorId':'1','operationId':OP,'storeId':'1','counterId':'2'},
        'authority':{'customerId':'77','contact':{'revision':'0','digest':'d'*64},
                     'actorVersion':'e'*64,'actorEpoch':'0','approvalId':None,'close':None},
        'issuedAt':NOW,'expiresAt':NOW+60000,'attemptExpiresAt':NOW+60000}
    return {**value,'signature':digest(KEY,'preparation-capability',value)}


class Result:
    def __init__(self,values):self.values=values
    def fetchall(self):return self.values
    def fetchone(self):return self.values[0] if self.values else None


class Session:
    def __init__(self):self.sql=[];self.flushes=0
    def execute(self,sql,params):
        value=' '.join(str(sql).split());self.sql.append(value)
        if 'products_gs1' in value:return Result([{'gtin':str(params['id'])}])
        if 'FROM tss.products' in value:return Result([{'prod_id':params['id']}])
        if 'user_upi_apps' in value:return Result([])
        raise AssertionError('No historical SQL or unclassified query is available')
    def flush(self):self.flushes+=1


def source(plan,user=None,history=None,mode='normal',batched=True,pricing=None):
    native=Session();trace=[];value=cap(plan)
    if not batched:value.update(contract='pos-legacy-order-import-source-v1',purpose='order')
    history=history or HistoryProbe(lambda:NOW,'Asia/Kolkata',value)
    h=CURRENT_HISTORY.set(history);effects=[];e=CAPTURE.set(effects)
    try:
        runtime=pipeline(ROOT,plan,trace,mode,pricing)
        with private_session(native) as session,patch.dict(os.environ,{'POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY':HISTORY}):
            runtime.preparation_pipeline(session,
                user or {'user_id':77,'is_exclusive':False},plan,value)
        native.products=[row['prod_id'] for row in runtime.last_cart.get(runtime.item_types.PRODUCTS)]
        native.snapshot=json.loads(runtime.last_cart.json())
        return native,trace,effects
    finally:
        CURRENT_HISTORY.reset(h);CAPTURE.reset(e)


def plan(lines):
    return {'kind':'offline','createdAt':'2020-01-01 12:00:00','lines':[
        {'productId':str(sku),'quantity':qty,'unitPrice':price} for sku,qty,price in lines]}


def handoff(value,eligible=True):
    value_cap=cap(value);probe=HistoryProbe(lambda:NOW,'Asia/Kolkata',value_cap)
    from membership_history import request
    scope=request({'capability':value_cap,'user':{'user_id':77}},probe.point)
    order={'id':'100','paymentMethod':14,'createdAt':'2026-11-16 12:00:00',
        'lines':[{'lineId':'101','productId':'11','isExclusiveOrder':1}]}
    document={'scope':scope,'reader':'bigquery','generationId':'f'*64,'complete':True,'fetchedAt':NOW,
        'lastDeliveredOrder':order if eligible else None,'recentDeliveredOrders':[order] if eligible else []}
    document['signature']=signature(document,HISTORY)
    pre={'contract':'pos-csv-membership-prefetch-v1','scope':scope,'sourceTimeZone':'Asia/Kolkata',
        'generationId':'f'*64,'documentHash':signed('membership-document',document,HISTORY),'expiresAt':NOW+57000}
    supplied={'document':document,'capability':{**pre,'signature':signed('membership-prefetch',pre,HISTORY)}}
    value_cap['membershipHistoryHash']=digest(KEY,'membership-history',supplied)
    return prepared_history(supplied,value_cap,KEY,HISTORY,['10','12'],'Asia/Kolkata',lambda:NOW)


def normalized(snapshot):
    return {'products':sorted(snapshot['products']['items'],key=lambda row:row['prod_id']),
        'meta':sorted(snapshot['meta']['items'],key=lambda row:row['name'])}


def hp_refunds(snapshot,line_items):
    # Actual pinned HP constructor and approved per-HP refund projection; all
    # catalog/pricelist reads are explicit synthetic values, never native SQL.
    from types import SimpleNamespace
    import ast
    from decimal import Decimal,ROUND_DOWN
    import math
    from source_refunds import source_refund_projection,RefundProjection
    from source_calculator import parse_source
    raw=(ROOT/'libs/OrderHelper.py').read_bytes();tree=parse_source(raw,'<pinned-HP-helper>')
    function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='build_has_products_model')
    helper=parse_source((ROOT/'libs/helper.py').read_bytes(),'<pinned-HP-allocation>')
    alloc=[node for node in helper.body if isinstance(node,ast.FunctionDef) and node.name in {'round_down','allocate_amount_per_unit'}]
    rows=snapshot['products']['items'];products={row['prod_id']:row for row in rows}
    def fetch(_session,query,to_dict=False):
        if 'WHERE p.id =' in query:
            sku=int(query.split('WHERE p.id =')[-1].strip())
            return {'parent_id':sku,'normal_price':products[sku]['price'],'special_price':0,'cog':0}
        if 'FROM pricelist pl' in query:return {'exclusive_price':0}
        raise AssertionError('Unclassified constructor read')
    calc=next(row for row in snapshot['meta']['items'] if row['name']=='calculations')
    header={'user_id':77,'pay_amt':calc['total'],'coupon_used':222 if calc['coupon_discount'] else 0,
        'coupon_amt_used':calc['coupon_discount'],'tss_money_used':0,'tss_points_used':0,
        'cashback_used':0,'voucher_used':0,'voucher_amt_used':0,'payment_method':14,'flag_id':19,'store_disc_pg':0}
    namespace={'HasProductModel':lambda **kwargs:{'status':'INCOMPLETE',**kwargs},'Session':None,'fetchOne':fetch,
        'settings':SimpleNamespace(EXCLUSIVE_PRICELISTS=[1],IS_LINE_ITEM_ENABLED=line_items),
        'logger':__import__('source_runtime').SilentLogger(),'Decimal':Decimal,'ROUND_DOWN':ROUND_DOWN,'math':math}
    exec(compile(ast.Module(body=[*alloc,function],type_ignores=[]),'<pinned-hp-comparison>','exec'),namespace)
    lines=[]
    for product in rows:lines.extend(namespace['build_has_products_model'](SimpleNamespace(id=0,**header),deepcopy(product),False,is_pos=True,calc=calc))
    class CouponProjection(RefundProjection):
        def fetch_one(self,session,query,to_dict=False):
            if session is not self or query!='Select voucher_type from coupons where id = 222' or not to_dict:
                raise AssertionError('Unclassified refund coupon read')
            return {'voucher_type':1}
    with patch('source_refunds.RefundProjection',CouponProjection):
        mutated,audits,_cancel,_coherent=source_refund_projection(ROOT,header,lines,profile='pos-refund-per-hp-v1')
    def key(row):return (row['prod_id'],row['qty'],row['price'],row['amount_to_be_refunded'])
    return {'lines':sorted(({k:v for k,v in row.items() if k!='id'} for row in mutated),key=key),
        'audits':sorted(({'productId':mutated[row['lineIndex']]['prod_id'],**{k:v for k,v in row.items() if k!='lineIndex'}} for row in audits),key=lambda row:json.dumps(row,sort_keys=True))}


class SourcePreview(unittest.TestCase):
    def test_over_2000_literal_short_circuit_runs_cart_validate_and_calculator_without_history(self):
        native,trace,effects=source(plan([(11,1,'2000.01')]))
        self.assertEqual(trace,['catalog','cart','cart','validate','calculator'])
        self.assertGreater(native.flushes,1)
        self.assertFalse(any('orders' in row or 'has_products' in row for row in native.sql))
        self.assertEqual(effects,[])

    def test_active_member_does_not_need_warehouse(self):
        native,trace,_=source(plan([(11,1,'25.49')]),{'user_id':77,'is_exclusive':True})
        self.assertEqual(trace[-2:],['validate','calculator'])
        self.assertEqual(native.products,[11])
        self.assertFalse(any('orders' in row for row in native.sql))

    def test_literal_execution_clock_is_lazy_and_mismatched_host_zone_is_not_guessed(self):
        value=plan([(11,1,'2300.00')]);value_cap=cap(value)
        def wrong_clock():return __import__('datetime').datetime(2026,11,17,6,30,3)
        probe=HistoryProbe(lambda:NOW,'Asia/Kolkata',value_cap,wrong_clock)
        source(value,history=probe)  # >2000 never samples the history clock.
        self.assertIsNone(probe._point)
        with self.assertRaises(ImportReview) as error:probe.execution_clock({'capability':value_cap,'user':{'user_id':77}})
        self.assertEqual(error.exception.code,'ORDER_IMPORT_MEMBERSHIP_CLOCK_INVALID')

    def test_read_only_preview_suppresses_known_direct_abandon_cart_producer_without_changing_other_invocations(self):
        calls=[]
        controlled=preview_effect(lambda *_args,**_kwargs:calls.append(True))
        with read_only_preview():
            controlled({'private':'not-a-log-field'},queue='fixture')
            self.assertEqual(calls,[])
        self.assertIs(PREVIEW_ONLY.get(),False)
        controlled();self.assertEqual(calls,[True])

    def test_parallel_preview_and_legacy_invocations_do_not_share_batch_or_effect_context(self):
        from threading import Barrier,Thread
        barrier=Barrier(2);observed=[]
        class Original:
            def process(self):return 'literal-process'
        wrapped=automatic_membership(Original)
        value=cap(plan([(11,1,'25.49')]))
        def preview():
            with read_only_preview(),catalog_build(value):
                barrier.wait(timeout=5)
                observed.append(('preview',wrapped().process(),PREVIEW_ONLY.get()))
                barrier.wait(timeout=5)
        def legacy():
            with catalog_build({}):
                barrier.wait(timeout=5)
                observed.append(('legacy',wrapped().process(),PREVIEW_ONLY.get()))
                barrier.wait(timeout=5)
        threads=[Thread(target=preview),Thread(target=legacy)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertCountEqual(observed,[('preview',None,True),('legacy','literal-process',False)])
        self.assertIsNone(BUILDING.get());self.assertIs(PREVIEW_ONLY.get(),False)

    def test_explicit_member_only_has_no_ordinary_items_and_no_history(self):
        native,trace,_=source(plan([(10,1,'100.00')]))
        self.assertEqual(trace[-2:],['validate','calculator'])
        self.assertFalse(any('orders' in row for row in native.sql))

    def test_2000_exactly_needs_history_at_trusted_execution_second_not_old_csv_day(self):
        with self.assertRaises(NeedHistory) as required:source(plan([(11,1,'2000.00')]))
        self.assertEqual(required.exception.scope['asOf'],'2026-11-17 12:00:03')
        self.assertEqual(required.exception.scope['cutoff'],'2026-10-03 12:00:03')
        self.assertEqual(required.exception.scope['customerId'],'77')
        self.assertIsNone(CURRENT.get());self.assertIsNone(CURRENT_HISTORY.get());self.assertIsNone(CAPTURE.get())

    def test_explicit_member_with_ordinary_items_preserves_literal_history_branch(self):
        with self.assertRaises(NeedHistory):source(plan([(10,1,'100.00'),(11,1,'25.49')]))

    def test_low_partial_cart_then_over_2000_final_cart_defers_only_automatic_process_without_querying_history(self):
        value=plan([(11,1,'1001.00'),(13,1,'1001.00')])
        native,trace,_=source(value)
        self.assertEqual(trace,['catalog','cart','catalog','cart','cart','validate','calculator'])
        self.assertEqual(native.products,[11,13,12])
        with patch.dict(os.environ,{'POS_LEGACY_IMPORT_PREPARATION_CONTRACT':PREPARATION_CONTRACT}):
            with self.assertRaises(NeedHistory):source(value,batched=False)
        self.assertIsNone(BUILDING.get())

    def test_exact_membership_history_fence_blocks_imported_session_aliases_before_native_execution(self):
        from sqlalchemy import create_engine,event,text
        from sqlalchemy.orm import Session as NativeSession
        engine=create_engine('sqlite:///:memory:')
        for query in HISTORY_QUERIES:
            called=[]
            def executed(*_args):called.append(True)
            event.listen(engine,'do_execute',executed)
            try:
                with NativeSession(engine) as native:
                    with self.assertRaises(ImportReview) as error:
                        with private_session(native) as current,guard_history(current):
                            # Bypass the yielded argument exactly as an imported
                            # legacy SessionR alias does. SQL listener still wins.
                            try:PrivateSessionProxy().execute(query,{'user_id':77,'order_id':100,'date_before':'2026-10-03 12:00:03'})
                            except ImportReview:pass
                    self.assertEqual(error.exception.code,'ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED')
                self.assertEqual(called,[])
            finally:event.remove(engine,'do_execute',executed)
        with engine.begin() as connection:
            connection.execute(text('CREATE TABLE orders(id INTEGER PRIMARY KEY)'))
            connection.execute(text('INSERT INTO orders VALUES(1)'))
        with NativeSession(engine) as native,private_session(native) as current,guard_history(current) as scoped:
            self.assertEqual(scoped.execute('SELECT id FROM orders WHERE id=:id',{'id':1}).fetchone()[0],1)
        engine.dispose()

    def test_final_order_batching_is_an_explicit_order_only_authenticated_capability(self):
        value=plan([(11,1,'25.49')]);preview=cap(value)
        supplied={name:preview[name] for name in ('operationId','requestHash','planHash','namespace','planDigest','scope','authority','issuedAt','expiresAt')}
        supplied.update(contract='pos-legacy-order-import-source-v1',phase='order',nonce=ATTEMPT,orderId=None,preparationContract=PREPARATION_CONTRACT)
        supplied['signature']=digest(KEY,'capability',supplied)
        self.assertEqual(verify_capability(KEY,supplied,OP,'order',value,NOW)['preparationContract'],PREPARATION_CONTRACT)
        for bad in ({**supplied,'preparationContract':'other'},{**supplied,'phase':'publication','orderId':'100'}):
            bad['signature']=digest(KEY,'capability',{key:item for key,item in bad.items() if key!='signature'})
            with self.assertRaises(ImportReview):verify_capability(KEY,bad,OP,bad['phase'],value,NOW)

    def test_actual_low_value_source_process_can_replace_paid_member_with_free_and_removes_original(self):
        # This vector documents the separate final profile substitution gap;
        # the preview must never hide the literal source replacement decision.
        value=plan([(10,1,'100.00'),(11,1,'25.49')]);value_cap=cap(value)
        probe=HistoryProbe(lambda:NOW,'Asia/Kolkata',value_cap)
        from membership_history import request
        scope=request({'capability':value_cap,'user':{'user_id':77}},probe.point)
        order={'id':'100','paymentMethod':14,'createdAt':'2026-11-16 12:00:00',
               'lines':[{'lineId':'101','productId':'11','isExclusiveOrder':1}]}
        document={'scope':scope,'reader':'bigquery','generationId':'f'*64,'complete':True,'fetchedAt':NOW,
                  'lastDeliveredOrder':order,'recentDeliveredOrders':[order]}
        document['signature']=signature(document,HISTORY)
        pre={'contract':'pos-csv-membership-prefetch-v1','scope':scope,'sourceTimeZone':'Asia/Kolkata',
             'generationId':'f'*64,'documentHash':signed('membership-document',document,HISTORY),'expiresAt':NOW+57000}
        handoff={'document':document,'capability':{**pre,'signature':signed('membership-prefetch',pre,HISTORY)}}
        value_cap['membershipHistoryHash']=digest(KEY,'membership-history',handoff)
        with prepared_history(handoff,value_cap,KEY,HISTORY,['10','12'],'Asia/Kolkata',lambda:NOW) as reader:
            native,trace,_=source(value,history=reader)
        self.assertEqual(trace[-2:],['validate','calculator'])
        self.assertEqual(native.products,[11,12])
        self.assertFalse(any('orders' in row for row in native.sql))

    def test_selected_batch_matches_qualified_original_calculations_products_hp_fields_and_approved_refunds(self):
        vectors=[
            ([(11,1,'1001.00'),(13,1,'1001.00')],None),
            ([(13,1,'1001.00'),(11,1,'1001.00')],None),
            ([(11,2,'1000.01')],None),
            ([(11,2,'25.49'),(13,3,'33.33')],None),
            ([(10,1,'100.00'),(11,2,'25.49')],None),
            ([(10,1,'100.00')],None),
            ([(11,2,'25.49')],{'user_id':77,'is_exclusive':True}),
        ]
        pricing_profiles=({},{'APP_DISCOUNT_PERCENT':5},{'couponPercent':10},{'couponPercent':100},
                          {'invoiceGst':5},{'invoiceGst':5,'couponPercent':10})
        selected=os.environ.get('SOURCE_PREPARATION_MATRIX_PROFILE')
        if selected is not None:
            if selected not in {str(index) for index in range(len(pricing_profiles))}:
                raise AssertionError('Unknown fixture matrix profile')
            pricing_profiles=(pricing_profiles[int(selected)],)
        for lines,user in vectors:
            for eligible in (False,True):
                for pricing in pricing_profiles:
                    with self.subTest(lines=lines,user=user,eligible=eligible,pricing=pricing):
                        value=plan(lines)
                        with handoff(value,eligible) as reader:
                            original,_,_=source(value,user,reader,batched=False,pricing=pricing)
                        with handoff(value,eligible) as reader:
                            batched,_,_=source(value,user,reader,pricing=pricing)
                        self.assertEqual(normalized(batched.snapshot),normalized(original.snapshot))
                        for line_items in (False,True):
                            self.assertEqual(hp_refunds(batched.snapshot,line_items),hp_refunds(original.snapshot,line_items))

    def test_preparation_capability_has_separate_purpose_and_rejects_mutation_expiry_and_plan_swap(self):
        value=plan([(11,1,'25.49')]);original=cap(value)
        self.assertEqual(verify_preparation(KEY,original,OP,value,NOW),original)
        for change in ({'purpose':'order'},{'attemptId':OP},{'authorityHash':'d'*64},
                       {'expiresAt':NOW},{'attemptExpiresAt':NOW},{'nonce':OP}):
            with self.assertRaises(ImportReview):verify_preparation(KEY,{**original,**change},OP,value,NOW)
        with self.assertRaises(ImportReview):verify_preparation(KEY,original,OP,plan([(11,1,'99.00')]),NOW)

    def test_signed_http_preview_has_no_query_or_raw_log_values_and_wrong_auth_never_calls_receiver(self):
        calls=[]
        fake=type('Receiver',(),{'preparation':lambda _self,op,body:calls.append(op) or {'preview':True}})()
        body={'plan':plan([(11,1,'25.49')]),'capability':cap(plan([(11,1,'25.49')]))}
        raw=json.dumps(body).encode();logs=io.StringIO();app=private_application(fake,KEY,logs)
        env={'PATH_INFO':'/internal/pos/legacy-order-imports/'+OP+'/preparation','REQUEST_METHOD':'POST',
            'CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),'QUERY_STRING':'',
            'HTTP_X_POS_LEGACY_IMPORT_KEY':KEY,'HTTP_X_POS_OPERATOR_ID':'1','wsgi.input':io.BytesIO(raw)}
        status=[];self.assertEqual(json.loads(b''.join(app(env,lambda value,_headers:status.append(value)))),{'preview':True})
        self.assertEqual(status,['200 OK']);self.assertEqual(calls,[OP])
        self.assertEqual(json.loads(logs.getvalue())['eventId'],'legacy-order-imports.order-preparation.previewed')
        self.assertNotIn(KEY,logs.getvalue());self.assertNotIn(OP,logs.getvalue())
        for change in ({'HTTP_X_POS_LEGACY_IMPORT_KEY':'wrong'},{'QUERY_STRING':'untrusted=contact'}, {'HTTP_X_POS_OPERATOR_ID':'2'}):
            local={**env,**change,'wsgi.input':io.BytesIO(raw)};status=[]
            app(local,lambda value,_headers:status.append(value));self.assertEqual(status,['409 Conflict'])
        self.assertEqual(calls,[OP])


if __name__=='__main__':
    with pinned_source(ROOT) as selected:
        ROOT=selected
        if os.environ.get('SOURCE_PREPARATION_MATRIX_ONLY')=='true':
            suite=unittest.defaultTestLoader.loadTestsFromName(
                'test_selected_batch_matches_qualified_original_calculations_products_hp_fields_and_approved_refunds',SourcePreview)
            result=unittest.TextTestRunner(verbosity=2).run(suite)
            sys.exit(0 if result.wasSuccessful() else 1)
        elif os.environ.get('SOURCE_PREPARATION_SKIP_MATRIX')=='true':
            names=[name for name in unittest.defaultTestLoader.getTestCaseNames(SourcePreview) if not name.startswith('test_selected_batch_')]
            result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(SourcePreview(name) for name in names))
            sys.exit(0 if result.wasSuccessful() else 1)
        else:unittest.main()
