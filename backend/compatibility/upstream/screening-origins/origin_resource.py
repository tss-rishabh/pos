"""Source-authenticated nonce prepare/read resources, with history outside SQL."""
import copy
import json
from sqlalchemy import text
from origin_contracts import PROOF,UUID,canonical,digest,fingerprint,identifier,fail
from origin_auth import source_origin,authority_hash
from origin_ledger import insert,read,save as save_command,creation,projection
from native import rows
from origin_frame import request_hash,namespace,cart_native_hash,tickets
import origin_history


def response(resp,value):
    resp.text=canonical(value)
    resp.set_header('Cache-Control','no-store')

def current_ticket_quantity(session,name,customer):
    # Current owned cart facts only. No meta/Product initializer is allowed to
    # consult old coupon/member history before its qualified preparation.
    found=rows(session,"SELECT user_id,quantity FROM cart_items WHERE cart_id=:cart AND prod_id=390238 AND status='active' LIMIT 3 FOR SHARE",{'cart':name},4)
    if len(found)>2 or any(str(row['user_id'])!=customer or type(row['quantity']) is not int or row['quantity'] not in (1,2) for row in found):fail('SCREENING_ORIGIN_CART_CHANGED')
    quantity=sum(row['quantity'] for row in found)
    if quantity not in (0,1,2):fail('SCREENING_ORIGIN_LIMIT')
    return quantity


class OriginCommands:
    """POST prepares only; GET never creates/retries an order or source stage."""
    def __init__(self,owner):self.owner=owner
    def on_post(self,req,resp):
        body=req.context.get('data')
        if (not isinstance(body,dict) or set(body)!={'commandId','payload','params','kind'} or not isinstance(body['commandId'],str)
                or not UUID.fullmatch(body['commandId']) or body['kind'] not in ('customer','pos')
                or not isinstance(body['payload'],dict) or not isinstance(body['params'],dict)
                or len(canonical(body).encode())>500000):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        original=dict(req.context);parameters=dict(req.params)
        req.context['data']=copy.deepcopy(body['payload'])
        # Falcon's params mapping may be read-only. Bind the supplied params in
        # the same request digest without installing an arbitrary URL target.
        if dict(req.params)!=body['params']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
        try:
            coupon_snapshot=None
            if self.owner.coupons is not None:
                with self.owner.sessions() as session,session.begin():
                    session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                    _native,captured,_grant=source_origin(req,session,self.owner.key,self.owner.clock(),req.get_header('X-TSS-Screening-Origin') or 'customer')
                coupon_snapshot=self.owner.coupons.snapshot(captured['customerId'])
            with self.owner.sessions() as session,session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                native,principal,grant=source_origin(req,session,self.owner.key,self.owner.clock(),req.get_header('X-TSS-Screening-Origin') or 'customer')
                prior=read(session,body['commandId'],principal['customerId'],self.owner.key)
                if prior is not None:
                    if prior['origin']!=principal['origin'] or prior['requestHash']!=request_hash(req):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                    if prior['phase'] in ('BOUND','COUNTED'):
                        proof=creation(session,prior,self.owner.key);projection(session,prior)
                        return response(resp,{'commandId':prior['id'],'phase':prior['phase'],'orderId':proof['orderId'],'prepared':True})
                    if prior['phase']!='PREPARED':fail('SCREENING_ORIGIN_CLOSED_NO_ORDER')
                    value=prior
                else:
                    if body['kind']=='pos':
                        if principal['origin'] not in ('legacy-django','mpos'):fail('SCREENING_ORIGIN_STAFF_REQUIRED')
                    name=namespace(principal,req)
                    quantity=current_ticket_quantity(session,name,principal['customerId'])
                    if quantity==0:return response(resp,{'commandId':None,'prepared':False})
                    if quantity not in (1,2):fail('SCREENING_ORIGIN_LIMIT')
                    name=namespace(principal,req);cart_hash=cart_native_hash(session,name)
                    if grant is not None and (grant['requestHash']!=request_hash(req) or grant['cartHash']!=cart_hash):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                    now=self.owner.clock()
                    value={'contract':PROOF,'id':body['commandId'],'origin':principal['origin'],'customerId':principal['customerId'],
                        'actorId':principal['actorId'],'storeId':principal['storeId'],'counterId':principal['counterId'],
                        'namespaceHash':fingerprint(self.owner.key,'namespace',name),'requestHash':request_hash(req),'cartHash':cart_hash,
                        'referenceHash':fingerprint(self.owner.key,'reference',{'commandId':body['commandId'],'kind':body['kind']}),
                        'authorityHash':authority_hash(self.owner.key,principal),'quantity':quantity,'markerRows':quantity if self.owner.line_items else 1,
                        'lineItemsEnabled':self.owner.line_items,'phase':'PREPARED','orderId':None,'lines':[],'markers':[],
                        'creationHash':None,'closureHash':None,'version':1,'createdAt':now,'updatedAt':now,'expiresAt':now+600000}
                    insert(session,value,self.owner.key)
                if value['phase']=='PREPARED' and authority_hash(self.owner.key,principal)!=value['authorityHash']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                selections=[]
                if self.owner.coupons is not None:
                    selections=self.owner.coupons.prepare(session,value,body['kind'],namespace(principal,req),coupon_snapshot)
                if body['kind']=='customer':revision=origin_history.head(session,value['customerId'])
            # No SQL connection/lock is retained while reading BigQuery.
            documents=[]
            if self.owner.coupons is not None:
                documents=[self.owner.coupon_history_provider.read(self.owner.coupons.request(value,selection)) for selection in selections]
            document=None
            if body['kind']=='customer':
                if self.owner.history_provider is None:fail('SCREENING_ORIGIN_HISTORY_REQUIRED')
                document=self.owner.history_provider.read(value,revision)
            with self.owner.sessions() as session,session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                _native,principal,_grant=source_origin(req,session,self.owner.key,self.owner.clock(),value['origin'])
                current=read(session,value['id'],value['customerId'],self.owner.key)
                if current!=value or authority_hash(self.owner.key,principal)!=value['authorityHash'] or cart_native_hash(session,namespace(principal,req))!=value['cartHash']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                if document is not None:origin_history.save(session,value,document,self.owner.key,self.owner.clock())
                if self.owner.coupons is not None:self.owner.coupons.save(session,value,selections,documents,coupon_snapshot)
            return response(resp,{'commandId':value['id'],'phase':value['phase'],'orderId':None,'prepared':True,'expiresAt':value['expiresAt']})
        finally:req.context.clear();req.context.update(original)
    def on_get(self,req,resp,command_id):
        if not UUID.fullmatch(command_id):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        with self.owner.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,principal,_grant=source_origin(req,session,self.owner.key,self.owner.clock(),req.get_header('X-TSS-Screening-Origin') or 'customer')
            value=read(session,command_id,principal['customerId'],self.owner.key)
            if value is None:
                response(resp,{'commandId':command_id,'phase':None,'orderId':None});resp.status='404 Not Found';return
            if value['origin']!=principal['origin'] or any(value[name]!=principal[name] for name in ('actorId','storeId','counterId')):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
            result={'commandId':value['id'],'phase':value['phase'],'orderId':value['orderId']}
            if value['phase'] in ('BOUND','COUNTED'):
                proof=creation(session,value,self.owner.key);projection(session,value)
                result['result']={'order':int(proof['orderId']),'method':proof['method'],'isValid':True,'name':'placed_order'}
            response(resp,result)
    def close(self,req,resp,command_id):
        if not UUID.fullmatch(command_id) or req.context.get('data') not in (None,{}):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        key=self.owner.key
        with self.owner.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,principal,_grant=source_origin(req,session,key,self.owner.clock(),req.get_header('X-TSS-Screening-Origin') or 'customer')
            value=read(session,command_id,principal['customerId'],key)
            if value is None or value['origin']!=principal['origin'] or any(value[name]!=principal[name] for name in ('actorId','storeId','counterId')):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
            if value['phase']=='REJECTED':return response(resp,{'commandId':command_id,'phase':'REJECTED','noFinancialEffects':True,'closureHash':value['closureHash']})
            if value['phase']!='PREPARED' or value['orderId'] is not None:fail('SCREENING_ORIGIN_CANNOT_CLOSE')
            # This lock is the dispatch fence, not an absence heuristic. Every
            # selected source body must own this same customer/command before
            # any Order write and atomically retains its immutable creation.
            for table in ('pos_rewrite_screening_origin_creations','pos_rewrite_screening_origin_payments','pos_rewrite_screening_origin_effects'):
                if rows(session,'SELECT command_id FROM '+table+' WHERE command_id=:id FOR SHARE',{'id':command_id},2):fail('SCREENING_ORIGIN_CANNOT_CLOSE')
            now=self.owner.clock();proof={'contract':'pos-screening-origin-closure-v1','commandId':command_id,'origin':value['origin'],
                'customerId':value['customerId'],'requestHash':value['requestHash'],'cartHash':value['cartHash'],'authorityHash':value['authorityHash'],
                'code':'SCREENING_ORIGIN_OWNER_CLOSED_NO_ORDER','noFinancialEffects':True,'createdAt':now}
            closure=digest(key,'closure',proof)
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_closures(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),
                {'id':command_id,'data':canonical(proof),'proof':closure})
            save_command(session,{**value,'phase':'REJECTED','closureHash':closure},key,now)
        response(resp,{'commandId':command_id,'phase':'REJECTED','noFinancialEffects':True,'closureHash':closure})


class OriginClose:
    def __init__(self,commands):self.commands=commands
    def on_post(self,req,resp,command_id):return self.commands.close(req,resp,command_id)
