"""Pure server preview shape; no source initialization or financial authority."""
from uuid import UUID
from origin_contracts import HASH,ORIGINS,identifier,point,unsafe

CONTRACT='pos-screening-origin-preview-v1'
PURPOSES=('cart-mutation','order-cart-hydration','csk-cart-build')
FIELDS={'contract','previewId','purpose','origin','customerId','actorId','storeId','counterId',
        'authorityHash','namespaceHash','requestHash','cartHash','issuedAt','expiresAt'}


def preview(value):
    try:
        if (not isinstance(value,dict) or set(value)!=FIELDS or value['contract']!=CONTRACT
                or value['origin'] not in ORIGINS or value['purpose'] not in PURPOSES
                or not isinstance(value['previewId'],str) or str(UUID(value['previewId']))!=value['previewId']
                or value['purpose']=='csk-cart-build' and value['origin']!='external-system'):raise ValueError()
        for name in ('customerId',):
            if not isinstance(value[name],str) or identifier(value[name])!=value[name]:raise ValueError()
        staff=value['origin'] in ('legacy-django','mpos')
        for name in ('actorId','storeId','counterId'):
            if staff:
                if not isinstance(value[name],str) or identifier(value[name])!=value[name]:raise ValueError()
            elif value[name] is not None:raise ValueError()
        if (any(not isinstance(value[name],str) or not HASH.fullmatch(value[name])
                for name in ('authorityHash','namespaceHash','requestHash','cartHash'))
                or not point(value['issuedAt']) or not point(value['expiresAt'])
                or not value['issuedAt']<value['expiresAt']<=value['issuedAt']+60000):raise ValueError()
    except Exception:unsafe('SCREENING_ORIGIN_PREVIEW_UNQUALIFIED')
    return value
