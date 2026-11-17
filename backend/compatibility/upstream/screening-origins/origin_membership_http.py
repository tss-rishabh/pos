"""Bounded service-only membership transport, outside every native SQL scope."""
from urllib.parse import urlsplit
import requests
from origin_contracts import canonical,command,digest,fail


class MembershipHistory:
    def __init__(self,url,key,clock):
        parsed=urlsplit(url)
        if (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path!='/internal/screening-origins/membership-history'):
            fail('SCREENING_ORIGIN_MEMBERSHIP_CONFIGURATION')
        self.url,self.key,self.clock=url,key,clock

    def read(self,value,scope,head):
        from transaction import CURRENT
        if CURRENT.get() is not None:fail('SCREENING_ORIGIN_MEMBERSHIP_SQL_SCOPE')
        command(value)
        now=self.clock()
        data={'command':value,'commandProof':digest(self.key,'command',value),
              'scope':scope,'head':head,'issuedAt':now,'expiresAt':min(now+30000,value['expiresAt'])}
        return self._send(self.url,data,'membership-history-request')

    def preview(self,value,scope,head):
        from transaction import CURRENT
        from preview_contracts import preview
        if CURRENT.get() is not None:fail('SCREENING_ORIGIN_MEMBERSHIP_SQL_SCOPE')
        preview(value)
        now=self.clock()
        data={'preview':value,'previewProof':digest(self.key,'preview-context',value),
              'scope':scope,'head':head,'issuedAt':now,'expiresAt':min(now+30000,value['expiresAt'])}
        return self._send(self.url.removesuffix('membership-history')+'membership-preview',data,'membership-preview-request')

    def _send(self,url,data,purpose):
        body=canonical({'data':data,'proofHash':digest(self.key,purpose,data)}).encode()
        if len(body)>32000:fail('SCREENING_ORIGIN_MEMBERSHIP_UNAVAILABLE')
        try:
            with requests.Session() as client:
                client.trust_env=False
                with client.post(url,data=body,headers={'Content-Type':'application/json'},
                                 timeout=(5,20),allow_redirects=False,verify=True,stream=True) as response:
                    if response.status_code!=200:fail('SCREENING_ORIGIN_MEMBERSHIP_UNAVAILABLE')
                    parts=[];size=0
                    for chunk in response.iter_content(chunk_size=16384):
                        size+=len(chunk)
                        if size>2000000:fail('SCREENING_ORIGIN_MEMBERSHIP_UNAVAILABLE')
                        parts.append(chunk)
                    import json
                    result=json.loads(b''.join(parts))
                    if not isinstance(result,dict):fail('SCREENING_ORIGIN_MEMBERSHIP_UNAVAILABLE')
                    return result
        except Exception:fail('SCREENING_ORIGIN_MEMBERSHIP_UNAVAILABLE')
