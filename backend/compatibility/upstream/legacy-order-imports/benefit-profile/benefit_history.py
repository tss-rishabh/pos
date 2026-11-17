"""Verified, bounded BQ result replay for exact pinned coupon SELECTs.

No SDK, HTTP, file or database history fallback. The surrounding source transaction
sees current control rows through its supplied same-writer read-only facade.
"""
from datetime import datetime
import hashlib
import hmac
import json
import re
import time
from uuid import UUID
from zoneinfo import ZoneInfo
from sqlalchemy import text
from benefit_source import BenefitReview


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def seal(kind, value, key):
    if not isinstance(key, str) or not re.fullmatch(r'[!-~]{32,4096}', key):
        raise BenefitReview()
    payload = '{"kind":' + json.dumps('legacy-order-imports.source.benefit.' + kind + '.v1') + ',"input":' + canonical(value) + '}'
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def qualify(value, expected, key, now_ms=None):
    now_ms = int(time.time()*1000) if now_ms is None else now_ms
    try:
        if type(now_ms) is not int or not 0 < now_ms <= 9007199254740991: raise ValueError()
        if set(expected) != {'contract','operationId','requestHash','planHash','customerId','couponId','configurationHash','asOf','sourceTimeZone'} or expected['contract'] != 'pos-csv-coupon-history-v1':
            raise ValueError()
        if str(UUID(expected['operationId'])) != expected['operationId']: raise ValueError()
        for name in ('requestHash','planHash','configurationHash'):
            if not re.fullmatch(r'[a-f0-9]{64}',expected[name]): raise ValueError()
        for name in ('customerId','couponId'):
            if not re.fullmatch(r'[1-9][0-9]{0,18}',expected[name]) or int(expected[name]) > 9223372036854775807: raise ValueError()
        if datetime.strptime(expected['asOf'],'%Y-%m-%d %H:%M:%S').strftime('%Y-%m-%d %H:%M:%S') != expected['asOf']: raise ValueError()
        ZoneInfo(expected['sourceTimeZone'])
        if not isinstance(value, dict) or len(canonical(value).encode()) > 262144:
            raise ValueError()
        fields = {'scope', 'reader', 'generationId', 'complete', 'fetchedAt', 'publication', 'globalUsage',
                  'birthdayTodayUsage', 'customerOrderCount', 'monthlyJoinedUsage', 'lotCounts', 'signature'}
        if set(value) != fields or value['scope'] != expected or value['reader'] != 'bigquery' or value['complete'] is not True:
            raise ValueError()
        if (not re.fullmatch(r'[a-f0-9]{64}', value['generationId']) or type(value['fetchedAt']) is not int or
            not value['fetchedAt'] <= now_ms <= value['fetchedAt']+60000):
            raise ValueError()
        for name in ('globalUsage', 'birthdayTodayUsage', 'customerOrderCount', 'monthlyJoinedUsage'):
            if not isinstance(value[name], str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', value[name]): raise ValueError()
        publication = value['publication']
        if set(publication) != {'sourceCaptureHash','controlHeadHash','queryContract','seal'} or publication['queryContract'] != 'pos-source-coupon-selects-2960-v1':
            raise ValueError()
        if any(not re.fullmatch(r'[a-f0-9]{64}', publication[name]) for name in ('sourceCaptureHash','controlHeadHash','seal')):
            raise ValueError()
        lots = value['lotCounts']
        if not isinstance(lots, list) or len(lots) > 1000 or len({row['couponId'] for row in lots}) != len(lots): raise ValueError()
        for row in lots:
            if set(row) != {'couponId','sameCode','noTimesAllowed','uniqueNoTimesAllowed','usedCount'} or type(row['sameCode']) is not bool:
                raise ValueError()
            for name in ('couponId','noTimesAllowed','uniqueNoTimesAllowed','usedCount'):
                if not isinstance(row[name], str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', row[name]): raise ValueError()
            if int(row['couponId']) <= 0: raise ValueError()
        body = {k:v for k,v in value.items() if k != 'signature'}
        if not isinstance(value['signature'], str) or not hmac.compare_digest(seal('coupon-history', body, key), value['signature']): raise ValueError()
    except (ValueError, TypeError, KeyError, OverflowError):
        raise BenefitReview('ORDER_IMPORT_COUPON_HISTORY_UNQUALIFIED') from None
    return json.loads(canonical(value))


class Row(dict):
    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)
    def __getattr__(self, key): return self[key]


class Rows:
    def __init__(self, rows): self.rows = [Row(row) for row in rows]
    def fetchone(self): return self.rows[0] if self.rows else None
    def first(self): return self.fetchone()
    def fetchall(self): return self.rows
    def __iter__(self): return iter(self.rows)


class CouponHistoryReplay:
    def __init__(self, qualified, current, current_coupon, coupon_users):
        self.facts, self.current, self.coupon, self.coupon_users = qualified, current, current_coupon, coupon_users
        self.scope = qualified['scope']
        self.calls = []
        # Duplicate rows are ambiguous in source fetchOne. Never pick an arbitrary
        # user-specific allowance from a nonunique mapping.
        if self.coupon.get('user_specific') == 1 and len(coupon_users) > 1:
            raise BenefitReview('ORDER_IMPORT_COUPON_USER_AMBIGUOUS')

    def execute(self, query, parameters=None, *, params=None):
        if params is not None:
            if parameters is not None: raise BenefitReview()
            parameters = params
        q = ' '.join(str(query).split())
        normalized = q.lower()
        uid, cid = self.scope['customerId'], self.scope['couponId']
        point = datetime.strptime(self.scope['asOf'], '%Y-%m-%d %H:%M:%S')
        patterns = [
            (rf"select count\(id\) from orders where date\(created_at\) = '{point.date()}' and order_status not in \(0,17\) and user_id={uid} and coupon_used={cid}", 'birthdayTodayUsage', 'count'),
            (rf'select count\(1\) as usage_count from orders o where o.order_status not in \(0,4,7,15,17,22,31,33\) and o.coupon_used = {cid}', 'globalUsage', 'usage_count'),
            (rf'select count\(id\) as order_count from orders where user_id = {uid} and order_status not in \(0, 17\)', 'customerOrderCount', 'order_count'),
            (rf'select count\(ocl.id\) as coupon_count from order_coupon_log ocl join orders o on ocl.user_id = o.user_id and ocl.coupon_id = o.coupon_used and o.order_status not in \(0 , 17\) where month\(ocl.created_at\) = {point.month} and year\(ocl.created_at\) = {point.year} and ocl.user_id = {uid} and ocl.coupon_id = {cid} and ocl.status = 1;', 'monthlyJoinedUsage', 'coupon_count'),
        ]
        for pattern, fact, column in patterns:
            if re.fullmatch(pattern, normalized):
                self.calls.append(fact)
                return Rows([{column: int(self.facts[fact])}])
        user_join = rf'select \* from coupons_users cu left join orders o on cu.user_id = o.user_id and cu.c_id = o.coupon_used and o.order_status not in \(0 , 17\) where cu.user_id = {uid} and cu.c_id = {cid};'
        if re.fullmatch(user_join, normalized):
            self.calls.append('currentCouponUser')
            return Rows(self.coupon_users)
        lot = self.coupon.get('coupon_lot_no')
        if lot:
            expected = f"select c.voucher_code, c.no_times_allowed, c.unique_no_times_allowed, c.coupon_lot_no, count(cl.coupon_id) as used_count from order_coupon_log cl join coupons c on c.id = cl.coupon_id join orders o on cl.user_id = o.user_id and cl.coupon_id = o.coupon_used and o.order_status not in (0 , 17) where c.coupon_lot_no = '{str(lot).lower()}' and cl.user_id = {uid} and cl.status = 1 group by cl.coupon_id"
            if normalized == expected:
                self.calls.append('lotCounts')
                return Rows([{'voucher_code': self.coupon['voucher_code'] if row['sameCode'] else self.coupon['voucher_code']+'!',
                    'no_times_allowed': int(row['noTimesAllowed']), 'unique_no_times_allowed': int(row['uniqueNoTimesAllowed']),
                    'coupon_lot_no': lot, 'used_count': int(row['usedCount'])} for row in self.facts['lotCounts']])
        if re.search(r'\b(orders|order_coupon_log)\b', normalized):
            raise BenefitReview('ORDER_IMPORT_COUPON_HISTORY_QUERY_UNQUALIFIED')
        if not normalized.startswith('select '):
            raise BenefitReview('ORDER_IMPORT_COUPON_HISTORY_MUTATION')
        # Match only the pinned current-control SELECTs. Safe replacements bind
        # source's interpolated coupon text literally, without executing quotes.
        params = parameters or {}
        code_query = f'select user_type, default_country_id from coupons where voucher_code = "{self.coupon["voucher_code"]}";'
        if q == code_query:
            query = text('SELECT user_type,default_country_id FROM coupons WHERE voucher_code=:benefit_code')
            params = {'benefit_code':self.coupon['voucher_code']}
            maximum = 1
        else:
            current_patterns = [
                rf'select birthdate, email from users where id={uid}',
                rf"select no_times_allowed as num from tss.coupons where id='{cid}';",
                "select status, value from tss_settings where platform='auto_apply_coupon'",
                "select status from tss_settings where platform='birthday_coupon'",
                "select \\* from coupons join tss_settings on coupons.id = tss_settings.value where tss_settings.platform='birthday_coupon';",
            ]
            maximum = 1
            coupon_select = "select id as coupon_id, voucher_type as type, disc_apply_items as min_quantity, min_order_amt as min_amount, voucher_code, voucher_val as discount, voucher_valid_for as valid_for, id, platform, voucher_percentage_max_val, for_new_user, user_specific, buyable_quantity, free_quantity, is_applicable_on_discounted_products, voucher_mxn_type, no_times_allowed, coupon_lot_no, message from coupons where is_deleted = 0 and voucher_type != 3 and (convert_tz(now(), 'utc', 'asia/kolkata') between start_date and end_date) and voucher_code = :coupon"
            if normalized == coupon_select:
                if params != {'coupon':self.coupon['voucher_code']}:
                    raise BenefitReview()
            elif normalized == 'select country_id from coupon_countries where coupon_id=:coupon_id':
                if str(params.get('coupon_id')) != cid: raise BenefitReview()
                maximum = 1000
            elif re.fullmatch(rf'select (?:cat_id from has_coupons where coupon_id = {cid}|prod_id from coupons_products where c_id={cid})',normalized):
                maximum = 1000
            elif re.fullmatch(rf'select (?:art_id|cat_id) from (?:buyable_coupon_artist|free_coupon_artist|buyable_coupon_category|free_coupon_category) where c_id = "{cid}";',normalized):
                maximum = 1000
            elif not any(re.fullmatch(pattern,normalized) for pattern in current_patterns):
                raise BenefitReview('ORDER_IMPORT_COUPON_CURRENT_QUERY_UNQUALIFIED')
        # Current locking reads prevent an earlier RR snapshot from hiding
        # changed coupon/user controls. Historical facts never reach this path.
        statement = str(query).rstrip().rstrip(';') + f' LIMIT {maximum+1} FOR SHARE'
        result = self.current.execute(text(statement),params)
        rows = result.mappings().fetchmany(maximum+1) if hasattr(result,'mappings') else result.fetchall()
        if hasattr(result,'close'): result.close()
        if len(rows) > maximum:
            raise BenefitReview('ORDER_IMPORT_COUPON_CURRENT_ROWS_AMBIGUOUS')
        return Rows([dict(row) for row in rows])

    def fetch_one(self, session, query, params=None, to_dict=False):
        if session is not self: raise BenefitReview()
        row = self.execute(query, params).fetchone()
        return dict(row) if row is not None and to_dict else row

    def fetch(self, session, query, params=None, to_dict=False):
        if session is not self: raise BenefitReview()
        rows = self.execute(query, params).fetchall()
        return [dict(row) for row in rows] if to_dict else rows
