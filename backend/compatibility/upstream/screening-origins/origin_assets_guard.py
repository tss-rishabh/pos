"""New-work fence until the origin-specific asset producer is installed.

An original member/voucher write is not ordinary no-assets merely because the
optional producer is disabled. This guard runs before the outer source commit.
"""
from native import rows
from origin_contracts import fail

STATE="LOWER(SHA2(CAST(JSON_OBJECT('attribute',attribute,'value',value,'active',is_active,'created_at',UNIX_TIMESTAMP(created_at),'updated_at',UNIX_TIMESTAMP(updated_at)) AS CHAR CHARACTER SET utf8mb4),256))"


def membership(session,email):
    found=rows(session,'SELECT attribute,'+STATE+" AS hash FROM user_eav WHERE entity=:email AND attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') ORDER BY attribute LIMIT 3 FOR SHARE",{'email':email},4)
    if len(found) not in (0,2) or found and {row['attribute'] for row in found}!={'EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY'}:fail('SCREENING_ORIGIN_MEMBERSHIP_RECONCILIATION_REQUIRED')
    return found


def no_new_assets(frame,lines):
    gifts=rows(frame.session,'SELECT id FROM gift_vouchers WHERE order_id=:id LIMIT 1 FOR SHARE',{'id':frame.order_id},2)
    after=membership(frame.session,frame.customer['email'])
    if (gifts or any(row['gv_id'] not in (None,0) or str(row['prod_id']) in frame.owner.member_product_ids for row in lines)
            or after!=frame.member_before):fail('SCREENING_ORIGIN_ASSET_PROFILE_REQUIRED')
