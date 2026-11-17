"""Public-purpose membership/gift evidence, before any paid completion.

All source mutations stay inside the existing public frame. A descriptor is
immutable causal evidence, not a new payment or a proof inferred from status.
"""
import copy
import hmac
import hashlib
import importlib
import json
import re
import sys
from contextlib import contextmanager
from pathlib import Path
from functools import wraps
from sqlalchemy import text
from public_membership import PublicMembershipProfile,qualified_free_membership,CONTRACT
from public_gifts import PublicGiftProfile
from native_authority import rows,value_json
from protocol import canonical,digest
from writer_protocol import fail


class PublicBenefits:
    def __init__(self,root,settings,namespace,proof_key,environment=None,history=None):
        import os
        env=os.environ if environment is None else environment
        if env.get('POS_PUBLIC_SCREENING_BENEFITS_CONTRACT')!=CONTRACT:fail('SCREENING_BENEFITS_UNAVAILABLE')
        self.root,self.settings,self.proof_key=Path(root).resolve(),settings,proof_key
        if hashlib.sha256((self.root/'controllers/user/exclusive_user_cache.py').read_bytes()).hexdigest()!=\
                'ad1f7cc15d8a12f5ca17799febfd885897dec25e56bb578aa90f74831c546814':
            fail('SCREENING_WRITER_SOURCE_UNVERIFIED')
        if proof_key==env.get('POS_MEMBERSHIP_PROOF_KEY'):fail('SCREENING_BENEFITS_UNAVAILABLE')
        self.membership=PublicMembershipProfile(root,settings,namespace)
        from public_benefit_cache import install_kind
        install_kind()
        self.gifts=PublicGiftProfile();self.history=history
        namespace['build_gift_voucher_model']=self.gifts.constructor(namespace['build_gift_voucher_model'])
        namespace['PosOrder']=self.membership.order_class(namespace)

    def install(self,modules,runtime_root=None):
        from public_membership import ACTIVE
        cart=importlib.import_module('controllers.cart.Cart')
        original=cart.AddFreeMembership
        wrapped=qualified_free_membership(self.root,dict(vars(cart)),original)
        self.free_membership=wrapped
        runtime_root=Path(runtime_root or self.root).resolve()
        for module in modules:
            filename=getattr(module,'__file__',None)
            if not filename:continue
            try:inside=Path(filename).resolve().is_relative_to(runtime_root)
            except (OSError,ValueError):inside=False
            if inside and getattr(module,'AddFreeMembership',None) is original:
                module.AddFreeMembership=wrapped
            token=getattr(module,'get_exclusive_token',None)
            if inside and callable(token):
                @wraps(token)
                def fresh(*args,_original=token,**kwargs):
                    current=ACTIVE.get()
                    if current is None:return _original(*args,**kwargs)
                    if (kwargs or len(args)!=3 or str(args[1])!=current.cap['customerId']
                            or args[2]!=current.user['email']):fail('SCREENING_MEMBERSHIP_PROOF_REQUIRED')
                    return current.user['is_exclusive']
                module.get_exclusive_token=fresh

    def before_order(self,req):
        from public_membership import ACTIVE
        current=ACTIVE.get()
        if current is None:return
        user=req.context.get('user');marker=req.context.get('pos_rewrite_fresh_customer')
        if (not isinstance(user,dict) or str(user.get('user_id'))!=current.cap['customerId']
                or not isinstance(marker,dict) or marker.get('subject')!=current.cap['customerId'] or marker.get('loaded') is not True):fail()
        user['is_exclusive']=current.user['is_exclusive']
        cart=req.context['cart'];cart.context['user']=user
        cart.re_init()
        serialized=cart.json()
        response=json.loads(serialized) if isinstance(serialized,str) else serialized
        # Re-run the exact automatic eligibility process once at final public
        # admission. It mutates only this owned, nonpersisted Cart. after_validate
        # still requires the user-approved quote byte scope before any Order.
        self.free_membership(req.context['session'],cart,response,{'payload':{'operation':'get'}},user).process()

    @contextmanager
    def scope(self,session,cap,user,preview=False,history=None):
        if cap.get('benefitsContract')!=CONTRACT:fail('SCREENING_BENEFITS_UNAVAILABLE')
        supplied=history
        if supplied is None and not preview:
            from public_membership_history import retained
            supplied=retained(session,cap,self.proof_key)
        with self.membership.scope(session,cap,user,supplied,preview) as member:
            yield Invocation(self,session,cap,user,member)


class Invocation:
    def __init__(self,profile,session,cap,user,membership):
        self.profile,self.session,self.cap,self.user=profile,session,cap,user
        self.membership=membership;self.gifts=None

    def admit(self,cart,types,payload):
        self.membership.admit(cart,types)
        self.gifts=self.profile.gifts.admit(self.session,self.cap,cart,types,payload)

    def capture(self,order_id,now):
        if self.gifts is None:fail('SCREENING_BENEFIT_PROOF_REQUIRED')
        member=self.membership.capture(order_id)
        gifts=self.profile.gifts.capture(self.session,self.cap,order_id,self.gifts)
        value={name:self.cap[name] for name in ('operationId','checkoutId','actorId','customerId','storeId','counterId','requestHash','cartHash')}
        value.update(contract=CONTRACT,orderId=str(order_id),membership=member,gifts=gifts,createdAt=now)
        signature=digest(self.profile.proof_key,'public-screening-benefits',value)
        self.session.execute(text('INSERT INTO pos_rewrite_public_screening_benefits(operation_id,order_id,data,proof_hash) VALUES(:op,:order,:data,:proof)'),
            {'op':value['operationId'],'order':value['orderId'],'data':canonical(value),'proof':signature})
        if member is not None:
            import os
            from public_benefit_cache import pending,TASK
            from effects import collector_record
            queue=os.environ.get('POS_PUBLIC_SCREENING_MEMBERSHIP_CACHE_QUEUE','')
            if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',queue):fail('SCREENING_BENEFIT_CACHE_UNAVAILABLE')
            pending(self.session,value['operationId'],signature,self.profile.proof_key,now)
            collector_record({'call':{'name':TASK,'args':[value['operationId'],signature],'kwargs':{},'options':{'queue':queue}}})
        return signature


def read(session,creation,key):
    expected=creation.get('benefitsHash')
    if expected is None:return None
    found=rows(session,'SELECT order_id,data,proof_hash FROM pos_rewrite_public_screening_benefits WHERE operation_id=:id AND OCTET_LENGTH(data)<=64000 FOR SHARE',
               {'id':creation['operationId']},1)
    if len(found)!=1:fail('SCREENING_BENEFIT_PROOF_REQUIRED')
    row=found[0];value=value_json(row['data'])
    required={'contract','operationId','checkoutId','actorId','customerId','storeId','counterId','requestHash','cartHash','orderId','membership','gifts','createdAt'}
    if (not isinstance(value,dict) or set(value)!=required or value['contract']!=CONTRACT
            or any(value[name]!=creation[name] for name in ('operationId','checkoutId','actorId','customerId','storeId','counterId','requestHash','cartHash','orderId'))
            or str(row['order_id'])!=value['orderId'] or row['proof_hash']!=expected
            or not isinstance(expected,str) or not re.fullmatch(r'[a-f0-9]{64}',expected)
            or not hmac.compare_digest(expected,digest(key,'public-screening-benefits',value))):fail('SCREENING_BENEFIT_PROOF_REQUIRED')
    return copy.deepcopy(value)
