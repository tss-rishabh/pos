"""Actual legacy GET recovery and MPos purpose-grant HTTP resources."""
import hmac
import json
import time
from django.http import JsonResponse
from django.views import View
from legacy_staff import authenticated,key,database,actor,scope,one,rows,issue,assert_request_epoch
from origin_contracts import UUID,digest,fail
from legacy_execution import work,opened

def same_origin(request):
    # The new cookie-authenticated MPos resources use real browser CSRF and an
    # exact secure origin; the legacy csrf_exempt password view is not reused.
    from urllib.parse import urlsplit
    actual=urlsplit(request.build_absolute_uri('/'))
    supplied=request.META.get('HTTP_ORIGIN')
    if actual.scheme!='https' or supplied!=actual.scheme+'://'+actual.netloc:fail('SCREENING_ORIGIN_AUTH_REQUIRED')


class MPosScreeningGrant(View):
    # Django's ordinary CSRF middleware remains active; unlike MPosLogin this
    # new cookie-authenticated grant resource is never csrf_exempt.
    def get(self,request):
        try:
            from django.middleware.csrf import get_token
            secret=key();origin,actor_id,_session,_record=authenticated(request,secret,int(time.time()*1000))
            if origin!='mpos' or not request.is_secure():fail('SCREENING_ORIGIN_AUTH_REQUIRED')
            result=JsonResponse({'origin':'mpos','actorId':actor_id,'csrfToken':get_token(request)})
            result['Cache-Control']='no-store';result['Vary']='Cookie';return result
        except Exception:return JsonResponse({'code':'SCREENING_ORIGIN_GRANT_UNAVAILABLE'},status=409)
    def post(self,request):
        try:
            same_origin(request)
            value=json.loads(request.body)
            if not isinstance(value,dict) or set(value)!={'payload'} or not isinstance(value['payload'],dict):fail()
            secret=key();origin,_actor,_session,_record=authenticated(request,secret,int(time.time()*1000))
            if origin!='mpos':fail('SCREENING_ORIGIN_AUTH_REQUIRED')
            token=request.META.get('HTTP_AUTHORIZATION','')
            granted=issue(request,token,value['payload'])
            result=JsonResponse({'origin':granted['X-TSS-Screening-Origin'],'grantId':granted['X-TSS-Screening-Staff-Grant']})
            result['Cache-Control']='no-store';return result
        except Exception:return JsonResponse({'code':'SCREENING_ORIGIN_GRANT_UNAVAILABLE'},status=409)


class MPosScreeningPayment(View):
    def post(self,request,command_id):
        try:
            from django.http import HttpResponse
            from django.conf import settings
            from legacy_client import payment
            command_id=str(command_id);same_origin(request)
            if not UUID.fullmatch(command_id) or request.META.get('HTTP_X_TSS_SCREENING_COMMAND')!=command_id:fail()
            body=json.loads(request.body)
            if not isinstance(body,dict) or not {'order','method'}.issubset(body) or len(request.body)>16000:fail()
            # payment() freshly verifies actual MPos session + original actor,
            # source creation + current scope before the GET-first Go resource.
            token=request.META.get('HTTP_AUTHORIZATION','')
            result=payment(request,token,body,settings.PAYMENT_URL+'orders')
            if len(result.content)>1000000:fail()
            response=HttpResponse(result.content,status=result.status_code,content_type='application/json')
            response['Cache-Control']='no-store';return response
        except Exception:return JsonResponse({'code':'SCREENING_ORIGIN_PAYMENT_RECONCILIATION_REQUIRED'},status=409)


class LegacyScreeningRecovery(View):
    def get(self,request,command_id):
        command_id=str(command_id)
        if not UUID.fullmatch(command_id):return JsonResponse({'code':'SCREENING_ORIGIN_REQUEST_INVALID'},status=400)
        try:
            from django.db import transaction
            secret=key();origin,actor_id,_session,_record=authenticated(request,secret,int(time.time()*1000))
            alias,connection=database()
            with transaction.atomic(using=alias),connection.cursor() as cursor:
                native,_identity=actor(cursor,actor_id,secret)
                assert_request_epoch(request,native,origin)
                prior=work(cursor,command_id,secret,lock=False)
                if prior is None:return JsonResponse({'commandId':command_id,'state':'missing'},status=404)
                row,value=prior
                if value['actorId']!=actor_id or value['origin']!=origin:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
                sources=rows(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_creations WHERE command_id=%s',(command_id,))
                source=None
                if sources:
                    source=json.loads(sources[0]['data']) if isinstance(sources[0]['data'],str) else sources[0]['data']
                    if source.get('actorId')!=actor_id or source.get('origin')!=origin or not hmac.compare_digest(digest(secret,'creation',source),sources[0]['proof_hash']):fail()
                    scope(cursor,native,source['storeId'],source['counterId'])
                cash=rows(cursor,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_legacy_cash WHERE command_id=%s',(command_id,))
                if cash:
                    proof=json.loads(cash[0]['data']) if isinstance(cash[0]['data'],str) else cash[0]['data']
                    if proof.get('actorId')!=actor_id or proof.get('orderId')!=value['orderId'] or not hmac.compare_digest(digest(secret,'legacy-cash',proof),cash[0]['proof_hash']):fail()
                    result=JsonResponse({'commandId':command_id,'state':'cash-completed','orderId':proof['orderId']})
                elif value['state']=='COMPLETE' and row['response_payload'] and source is not None:
                    decoded=json.loads(opened(secret,command_id,row['response_payload']))
                    # A completed HTTP view can contain its swallowed source
                    # failure. Only an exact successful original result can be
                    # acknowledged as completion; error text remains private.
                    completed=(decoded.get('status')==200 and decoded.get('order_id') is not None and
                               str(decoded['order_id'])==source['orderId']==value['orderId'])
                    result=JsonResponse({'commandId':command_id,'state':'complete' if completed else 'reconciling','orderId':source['orderId']})
                else:result=JsonResponse({'commandId':command_id,'state':'reconciling','orderId':value['orderId']})
                result['Cache-Control']='no-store';return result
        except Exception:return JsonResponse({'code':'SCREENING_ORIGIN_RECOVERY_UNAVAILABLE'},status=409)


def urls():
    from django.urls import path
    return [path('screening-origins/mpos/grants',MPosScreeningGrant.as_view(),name='screening-mpos-grant'),
            path('screening-origins/mpos/payments/<uuid:command_id>',MPosScreeningPayment.as_view(),name='screening-mpos-payment'),
            path('screening-origins/commands/<uuid:command_id>',LegacyScreeningRecovery.as_view(),name='screening-command-recovery')]
