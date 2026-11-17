"""Source-authenticated nonce prepare/read resources, with history outside SQL."""
import copy
import json
from sqlalchemy import text
from origin_contracts import PROOF,UUID,canonical,digest,fingerprint,identifier,fail
from origin_auth import source_origin,authority_hash
from origin_ledger import insert,read,creation,projection
from origin_frame import request_hash,namespace,cart_native_hash,tickets
import origin_history


def response(resp,value):
    resp.text=canonical(value)
    resp.set_header('Cache-Control','no-store')


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
                    # Current namespace is rehydrated with the original source
                    # serializer. This resource never runs PosOrder or payments.
                    from middleware.CartMiddleware import CartFactory,PosCartFactory
                    from receiver import source_user
                    user=source_user(native,str(native['id']),bool(req.context.get('user',{}).get('is_exclusive')))
                    context={**req.context,'session':session,'user':user}
                    if body['kind']=='pos':
                        if principal['origin'] not in ('legacy-django','mpos'):fail('SCREENING_ORIGIN_STAFF_REQUIRED')
                        cart=PosCartFactory.instantiate(None,user,context,store_id=principal['storeId'],is_pos=True)
                    else:cart=CartFactory.instantiate(None,user,context)
                    quantity=tickets(cart)
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
                if body['kind']=='customer':revision=origin_history.head(session,value['customerId'])
            # No SQL connection/lock is retained while reading BigQuery.
            if body['kind']=='customer':
                if self.owner.history_provider is None:fail('SCREENING_ORIGIN_HISTORY_REQUIRED')
                document=self.owner.history_provider.read(value,revision)
                with self.owner.sessions() as session,session.begin():
                    session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                    _native,principal,_grant=source_origin(req,session,self.owner.key,self.owner.clock(),value['origin'])
                    current=read(session,value['id'],value['customerId'],self.owner.key)
                    if current!=value or authority_hash(self.owner.key,principal)!=value['authorityHash'] or cart_native_hash(session,namespace(principal,req))!=value['cartHash']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                    previous=session.execute(text('SELECT data,proof_hash FROM pos_rewrite_screening_origin_histories WHERE command_id=:id FOR UPDATE'),{'id':value['id']}).mappings().first()
                    origin_history.save(session,value,document,self.owner.key,self.owner.clock())
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
