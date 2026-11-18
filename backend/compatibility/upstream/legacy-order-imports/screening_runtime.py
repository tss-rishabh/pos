"""Pure explicit installation of the existing private ticket profile.

This selects no production contract by default and performs no SQL, HTTP or
source imports while reading configuration. The actual native counter audit
and reservation/authority checks remain inside the owned financial transaction.
"""
import json
import re
from protocol import ImportReview

PROFILE='pos-csv-screening-2960-v1'
SCHEMA='pos-screening-schema-v1'
WRITERS='pos-screening-all-writers-v1'
COUNTER='pos-screening-current-counter-v1'
ACCOUNT=re.compile(r'[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}')


def refuse():raise ImportReview('ORDER_IMPORT_SCREENING_UNQUALIFIED') from None


def options(environment,auth_key,proof_key):
    if not environment.get('POS_LEGACY_IMPORT_SCREENING_CONTRACT'):return None
    fields={
        'profile':environment.get('POS_LEGACY_IMPORT_SCREENING_CONTRACT'),
        'schema':environment.get('POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT'),
        'writers':environment.get('POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT'),
    }
    line_items=environment.get('POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED')
    publication=environment.get('POS_SCREENING_COUNTER_PUBLICATION_KEY','')
    if (fields!={'profile':PROFILE,'schema':SCHEMA,'writers':WRITERS} or line_items not in ('0','1')
            or environment.get('POS_SCREENING_COUNTER_CONTRACT')!=COUNTER
            or not re.fullmatch(r'[!-~]{32,4096}',publication)
            or publication in (auth_key,proof_key,environment.get('POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY'))):refuse()
    required=('POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER','POS_SCREENING_ORIGIN_HISTORY_DEFINER',
              'POS_SCREENING_COUNTER_TRIGGER_DEFINER')
    optional=('POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER','POS_COUPON_HISTORY_DEFINER',
              'POS_SCREENING_COUNTER_PUBLISHER_GRANTEE')
    owners=[environment.get(name,'') for name in required]
    owners.extend(environment[name] for name in optional if environment.get(name))
    try:administrators=json.loads(environment.get('POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES','[]'))
    except Exception:refuse()
    if (any(not isinstance(owner,str) or not ACCOUNT.fullmatch(owner) for owner in owners)
            or len(set(owners))!=len(owners) or not isinstance(administrators,list) or len(administrators)>32
            or any(not isinstance(owner,str) or not ACCOUNT.fullmatch(owner) for owner in administrators)
            or len(set(administrators))!=len(administrators) or set(owners)&set(administrators)):refuse()
    return {**fields,'lineItemsEnabled':line_items=='1'}


def install(source,selection,auth_key,proof_key,clock):
    if selection is None:return source
    # Match the literal source's bool(settings.IS_LINE_ITEM_ENABLED), never a
    # browser flag or an inferred default. A disagreement blocks startup.
    if (not hasattr(source.settings,'IS_LINE_ITEM_ENABLED') or
            bool(source.settings.IS_LINE_ITEM_ENABLED)!=selection['lineItemsEnabled']):refuse()
    from screening_profile import ScreeningSourceRuntime
    return ScreeningSourceRuntime(source,auth_key,proof_key,clock,
        {name:selection[name] for name in ('profile','schema','writers')})
