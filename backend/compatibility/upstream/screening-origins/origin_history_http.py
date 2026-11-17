"""Source private history caller; no native Session/lock crosses this request."""
import json
from urllib.parse import urlsplit
import requests
from origin_contracts import canonical,digest,fail


class History:
    def __init__(self,url,key,clock):
        parsed=urlsplit(url)
        if (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path!='/internal/screening-origins/history'):fail('SCREENING_ORIGIN_HISTORY_CONFIGURATION')
        self.url,self.key,self.clock=url,key,clock
    def read(self,command,witness):
        now=self.clock()
        data={'command':command,'commandProof':digest(self.key,'command',command),'witness':witness,'issuedAt':now,'expiresAt':min(now+30000,command['expiresAt'])}
        body=canonical({'data':data,'proofHash':digest(self.key,'history-request',data)}).encode()
        try:
            result=requests.post(self.url,data=body,headers={'Content-Type':'application/json'},timeout=(5,20),allow_redirects=False,verify=True)
            if result.status_code!=200 or len(result.content)>16000:fail('SCREENING_ORIGIN_HISTORY_UNAVAILABLE')
            value=result.json()
        except Exception:fail('SCREENING_ORIGIN_HISTORY_UNAVAILABLE')
        from origin_history import qualified
        return qualified(value,self.key,command,self.clock())
