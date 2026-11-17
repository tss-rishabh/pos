"""Legacy authenticated POS caller: prepare exact nonce, then original POST.

No lost creation is reposted. The original browser nonce must survive retries;
absence requires explicit review rather than generating a server-side retry ID.
"""
import json
import base64
import time
from urllib.parse import urlsplit,urlunsplit
import requests
from origin_contracts import UUID,canonical,fail
from legacy_staff import issue,key,payment_grant
from origin_contracts import digest


def api_url(order_url,suffix):
    parsed=urlsplit(order_url)
    if (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not parsed.path.endswith('/pos/order')):fail('SCREENING_ORIGIN_TRANSPORT_UNQUALIFIED')
    return urlunsplit((parsed.scheme,parsed.netloc,parsed.path[:-len('/pos/order')]+suffix,'',''))


def headers(request,token,payload,order_url):
    command=request.META.get('HTTP_X_TSS_SCREENING_COMMAND') or request.POST.get('screening_command')
    # The explicit nonce collector is installed on source create_order.html.
    # Plain sales retain the legacy call and are not assigned a fake nonce.
    if command is None:return {}
    if not isinstance(command,str) or not UUID.fullmatch(command):fail('SCREENING_ORIGIN_REQUEST_INVALID')
    authorization={'Authorization':token,'Content-Type':'application/json',**issue(request,token,payload)}
    status=requests.get(api_url(order_url,'/screening-commands/'+command),headers=authorization,timeout=(5,20),allow_redirects=False)
    if status.status_code==200:
        value=status.json()
        if value.get('commandId')!=command:fail()
        if value.get('phase') in ('BOUND','COUNTED'):
            # Original caller receives a response-compatible immutable result;
            # it must not call the source order POST again after recovery.
            return {'headers':authorization,'recovered':value.get('result'),'commandId':command}
        if value.get('phase')!='PREPARED':fail('SCREENING_ORIGIN_RECONCILIATION_REQUIRED')
    elif status.status_code!=404:fail('SCREENING_ORIGIN_RECONCILIATION_REQUIRED')
    prepared=requests.post(api_url(order_url,'/screening-commands'),json={'commandId':command,'payload':payload,'params':{},'kind':'pos'},
                           headers=authorization,timeout=(5,30),allow_redirects=False)
    if prepared.status_code!=200:fail('SCREENING_ORIGIN_PREPARATION_REQUIRED')
    value=prepared.json()
    if value.get('prepared') is not True:return {}
    if value.get('commandId')!=command:fail()
    authorization['X-TSS-Screening-Command']=command
    return {'headers':authorization,'recovered':None,'commandId':command}


def response(result):
    # Only the original four source fields; no cookies/customer data fabricated.
    if not isinstance(result,dict) or set(result)!={'order','method','isValid','name'}:fail()
    value=requests.Response();value.status_code=200;value._content=canonical(result).encode();value.headers['Content-Type']='application/json'
    return value


def payment(request,token,body,payment_url):
    command=request.META.get('HTTP_X_TSS_SCREENING_COMMAND') or request.POST.get('screening_command')
    if command is None:return requests.post(payment_url,json=body,headers={'Content-Type':'application/json','Authorization':token})
    if not UUID.fullmatch(command):fail('SCREENING_ORIGIN_REQUEST_INVALID')
    extra,creation,creation_hash=payment_grant(request,token,command)
    if str(body.get('order'))!=creation['orderId'] or body.get('method')!=creation['method']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
    parsed=urlsplit(payment_url)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:fail('SCREENING_ORIGIN_TRANSPORT_UNQUALIFIED')
    base=parsed.path.rsplit('/',1)[0]
    target=urlunsplit((parsed.scheme,parsed.netloc,base+'/screening-origins/'+command+'/payment','',''))
    secret=key();now=int(time.time()*1000)
    data={'contract':'pos-screening-origin-payment-submission-v1','commandId':command,'orderId':creation['orderId'],
        'customerId':creation['customerId'],'creationHash':creation_hash,'requestHash':creation['requestHash'],
        'referenceHash':creation['referenceHash'],'authorityHash':creation['authorityHash'],
        'paymentRequestHash':digest(secret,'payment-request',body),'issuedAt':now,'expiresAt':now+60000}
    def envelope(purpose):
        return base64.urlsafe_b64encode(canonical({'data':data,'proofHash':digest(secret,purpose,data)}).encode()).decode().rstrip('=')
    headers={'Authorization':token,'Content-Type':'application/json',**extra,'X-TSS-Screening-Command':command,
             'X-TSS-Screening-Payment-Authorization':envelope('payment-read')}
    prior=requests.get(target,headers=headers,timeout=(5,20),allow_redirects=False)
    if prior.status_code==200:return prior
    if prior.status_code!=404:fail('SCREENING_ORIGIN_PAYMENT_RECONCILIATION_REQUIRED')
    headers['X-TSS-Screening-Payment-Authorization']=envelope('payment-submission')
    return requests.post(target,json=body,headers=headers,timeout=(5,30),allow_redirects=False)
