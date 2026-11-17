"""Bounded source→private BQ coupon bridge; GET does not create an Order."""
import json
import re
import ssl
from urllib.parse import urlsplit
from urllib.request import Request,build_opener,HTTPSHandler,HTTPRedirectHandler
from origin_contracts import canonical,digest,unsafe


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*_args,**_kwargs):return None


class OriginCouponHistoryHttp:
    def __init__(self,url,key,*,ca_file=None,timeout=20,opener=None):
        value=urlsplit(url)
        if (value.scheme!='https' or not value.hostname or value.username or value.password or value.query or value.fragment
                or value.path!='/internal/screening-origins/coupon-history' or not re.fullmatch(r'[!-~]{32,4096}',key)
                or type(timeout) not in (int,float) or not 0<timeout<=25):unsafe('SCREENING_ORIGIN_COUPON_HTTP_CONFIGURATION')
        self.url,self.key,self.ca_file,self.timeout=url,key,ca_file,timeout;self.opener=opener
    def read(self,value):
        from transaction import CURRENT
        if CURRENT.get() is not None:unsafe('SCREENING_ORIGIN_COUPON_SQL_SCOPE')
        body=canonical({'data':value,'proofHash':digest(self.key,'coupon-history-request',value)}).encode()
        if len(body)>32000:unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
        request=Request(self.url,data=body,method='POST',headers={'Content-Type':'application/json','Accept':'application/json','Cache-Control':'no-store'})
        try:
            opener=self.opener or build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context(cafile=self.ca_file)))
            with opener.open(request,timeout=self.timeout) as response:
                if response.status!=200:unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
                data=response.read(262145)
                if len(data)>262144:unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
            result=json.loads(data)
            if not isinstance(result,dict):unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
            return result
        except Exception:
            unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
