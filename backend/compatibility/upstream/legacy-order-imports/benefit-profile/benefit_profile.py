"""Opt-in source candidate. Root composes its explicit methods into a private
CSV runtime; importing this file never selects a profile or changes a source app.
"""
import copy
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from decimal import Decimal
from datetime import datetime, date
from types import SimpleNamespace
from sqlalchemy import text
from benefit_source import BenefitReview, compile_coupon, source_pos_wrappers
from benefit_history import CouponHistoryReplay, qualify, seal
from benefit_claims import SqlBirthdayCache
from benefit_receipts import current_coupon_control, current_coupon_assignments
from protocol import ImportReview
from correction_profile import CalculatedImportReview, effective_tender

COUPON_CONTRACT = 'pos-csv-automatic-coupon-v1'
COMPLEMENTARY_CONTRACT = 'pos-csv-pos-complementary-v1'
CURRENT_BENEFIT_SCOPE = ContextVar('pos_csv_benefit_scope',default=None)


@contextmanager
def benefit_scope(plan, *, coupon=None, complementary=None):
    if (CURRENT_BENEFIT_SCOPE.get() is not None or
        complementary not in (None,COMPLEMENTARY_CONTRACT) or
        (coupon is not None and not isinstance(coupon,CouponCandidate)) or
        (coupon is None and complementary is None)):
        raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
    token=CURRENT_BENEFIT_SCOPE.set({'plan':plan,'coupon':coupon,'complementary':complementary})
    try:yield
    finally:CURRENT_BENEFIT_SCOPE.reset(token)


class SilentLogger:
    def __getattr__(self, _name): return lambda *_args, **_kwargs: None


class CouponCandidate:
    def __init__(self, root, *, session, expected_history, document, history_key, source_key,
                 guard_key, guard_observation, guard_contract, now_ms, configuration_cache,
                 settings, item_types, validation_error):
        if len({history_key,source_key,guard_key}) != 3:
            raise BenefitReview('ORDER_IMPORT_BENEFIT_KEYS_UNQUALIFIED')
        self.facts = qualify(document, expected_history, history_key, now_ms)
        self.scope = self.facts['scope']
        self.applied = False
        self.attempts = 0
        current_coupon = current_coupon_control(session,self.scope['couponId'])
        current_coupon_users = current_coupon_assignments(session,self.scope['customerId'],self.scope['couponId'])
        config = {'cache': configuration_cache, 'settings': settings, 'couponInputHash':current_coupon['native_hash']}
        if seal('coupon-configuration', config, source_key) != self.scope['configurationHash']:
            raise BenefitReview('ORDER_IMPORT_COUPON_CONFIGURATION_CHANGED')
        if str(current_coupon['coupon_id']) != self.scope['couponId']:
            raise BenefitReview()
        self.cache = SqlBirthdayCache(session, self.scope, configuration_cache, source_key, guard_key,
            guard_observation, now_ms, guard_contract)
        self.replay = CouponHistoryReplay(self.facts, session, current_coupon, current_coupon_users)
        point = datetime.strptime(self.scope['asOf'], '%Y-%m-%d %H:%M:%S')
        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is not None: raise BenefitReview('ORDER_IMPORT_COUPON_CLOCK_UNQUALIFIED')
                return point
        class FrozenDate(date):
            @classmethod
            def today(cls): return point.date()
        # helper.py uses datetime.datetime, OrderHelper/MetaInitializers use the
        # datetime class directly. One facade preserves BOTH literal call sites.
        class SourceDateTime:
            datetime = FrozenDateTime
            @staticmethod
            def now(): return point
        self.namespace = compile_coupon(root, {
            'datetime': SourceDateTime, 'date': FrozenDate, 'json': __import__('json'), 'text': text,
            'Session': self.replay, 'SessionR': self.replay, 'redis_object': self.cache,
            'fetchOne': self.replay.fetch_one, 'fetch': self.replay.fetch,
            'logger': SilentLogger(), 'ValidationException': validation_error,
            'settings': SimpleNamespace(**copy.deepcopy(settings)),
            'ItemTypes': item_types,
            'BIRTHDAY_MESSAGE': settings['BIRTHDAY_MESSAGE'],
            'EMPLOYEE_COUPON_DOMAIN_MAP': settings['EMPLOYEE_COUPON_DOMAIN_MAP'],
            'REDIS_COUPON_EXPIRY_IN_SEC': settings['REDIS_COUPON_EXPIRY_IN_SEC'],
            'check_user_in_table': lambda *_args: self._welcome_offer_refused(),
        })
        self.item_types = item_types

    def _welcome_offer_refused(self):
        # A birthday code also configured as a welcome offer needs separate
        # original welcome-offer history. Never fabricate registration consent.
        raise BenefitReview('ORDER_IMPORT_WELCOME_COUPON_PROFILE_REQUIRED')

    def automatic(self, session, user, cart, platform):
        if session is not self.replay and session is not self.replay.current:
            raise BenefitReview()
        if not user or str(user['user_id']) != self.scope['customerId'] or cart.is_pos is not True:
            raise BenefitReview()
        # A fresh isolated cart cannot import an unrelated/shared user's meta.
        existing = cart.get_item(self.item_types.META, {'name':'coupon'})
        if existing and (not self.applied or str(existing.get('coupon_id', self.scope['couponId'])) != self.scope['couponId']):
            raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
        config = self.namespace['get_auto_apply_coupon'](self.replay)
        self.attempts += 1
        if config['value'] == 'birthday_coupon' and int(config['status']) == 1:
            self.namespace['auto_apply_birthday_coupon'](self.replay, user, cart, platform)
        meta = cart.get_item(self.item_types.META, {'name':'coupon'})
        if meta:
            if meta.get('coupon') != self.replay.coupon['voucher_code'] or self.cache.claim is None:
                raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
            self.applied = True
        return meta

    def get_valid_coupon(self, _session, code, platform, user, db_fetch=True, is_pos=False):
        if code != self.replay.coupon['voucher_code'] or not is_pos or not user or str(user['user_id']) != self.scope['customerId']:
            raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
        # The real source SELECT still enforces deletion, type!=3 and inclusive
        # CONVERT_TZ(now()) validity. No coupon row supplied by a browser.
        result = self.namespace['get_valid_coupon'](self.replay, code, platform, user, db_fetch=True, is_pos=True)
        if str(result['coupon_id']) != self.scope['couponId']:
            raise BenefitReview('ORDER_IMPORT_COUPON_CONFIGURATION_CHANGED')
        return result

    def apply_coupon(self, cart, coupon): return self.namespace['apply_coupon'](cart, coupon)
    def calculate_discount(self, cart, item): return self.namespace['calculate_coupon_discount'](cart, item)

    def admit(self, cart, types, plan):
        current=CURRENT_BENEFIT_SCOPE.get()
        if current is None or current['coupon'] is not self:raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
        return assert_benefit_profile(cart,types,self.namespace['settings'],plan,cart.get_item(types.META,{'name':'calculations'}))


def admit_benefit_cart(cart, types, settings, plan, coupon=None):
    """Narrow cart admission hook, not the core native order verifier.

    Membership additions are obtained ONLY from the existing active private
    membership context. There is no caller-supplied extraRows parameter. Node
    independently authenticates its descriptor and exhaustive actual HP ownership.
    """
    if cart.is_pos is not True: raise BenefitReview()
    products, gifts = cart.get(types.PRODUCTS), cart.get(types.GIFT_VOUCHERS)
    complementary = cart.get(types.COMPLEMENTARY_PRODUCTS)
    meta = cart.get_item(types.META, {'name':'pos_freebies'})
    selections = meta.get('items', {}) if meta else {}
    declarations = {row['productId']:row for row in plan['lines']}
    if gifts or len(declarations) != len(plan['lines']) or not set(selections) <= set(declarations): raise BenefitReview()
    if any(type(value) is not int or value != 1 for value in selections.values()): raise BenefitReview()
    seen = set()
    for row in complementary:
        pid = str(row['prod_id'])
        if pid not in selections or pid in seen or row.get('prod_type') != 4 or row.get('is_valid') is not True or row.get('quantity') != 1 or row.get('freebie_sale_id') != 0:
            raise BenefitReview('ORDER_IMPORT_UNOWNED_COMPLEMENTARY_LINE')
        seen.add(pid)
    if seen != set(selections): raise BenefitReview('ORDER_IMPORT_COMPLEMENTARY_INCOMPLETE')
    expected = {pid:row['quantity'] for pid,row in declarations.items() if pid not in selections}
    module = sys.modules.get('membership_profile')
    context = module.CONTEXT.get() if module is not None else None
    member_ids = {str(key) for key in getattr(settings,'EXCLUSIVE_PRODUCT',{})} | {str(key) for key in getattr(settings,'EXCLUSIVE_UPGRADE_PRODUCT',{})}
    has_member = any(str(row.get('prod_id')) in member_ids for row in products)
    if has_member and context is None:
        raise BenefitReview('ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED')
    membership_additional = context['profile'].admit(cart,types,plan) if context is not None else ()
    replacement=context.get('replacement') if context is not None else None
    if replacement is not None:
        # Root's literal remove_exclusive_membership hook owns this evidence.
        # Do not infer a replacement from missing cart rows or selected flags.
        original=replacement.get('originalLine')
        if (not isinstance(original,dict) or original not in plan['lines']
                or original['productId'] in selections
                or expected.get(original['productId'])!=original['quantity']):raise BenefitReview()
        del expected[original['productId']]
    for row in membership_additional:
        if row['productId'] in expected or row['productId'] in selections or row['quantity'] != 1 or row['unitPrice'] != '0.00':
            raise BenefitReview()
        expected[row['productId']] = 1
    actual = {}
    for row in products:
        pid = str(row['prod_id'])
        if pid not in expected: raise BenefitReview('ORDER_IMPORT_UNOWNED_ADDITIONAL_LINE')
        actual[pid] = actual.get(pid, 0)+int(row['quantity'])
    if expected != actual: raise BenefitReview()
    calc = cart.get_item(types.META, {'name':'calculations'})
    if not calc or any(calc.get(name,0) not in (None,0) for name in
        ('used_tss_money','used_tss_points','used_reward_points','gift_voucher_value','used_pg_discount','used_store_discount_pg')):
        raise BenefitReview('ORDER_IMPORT_UNBOUND_WALLET_BENEFIT')
    applied = cart.get_item(types.META, {'name':'coupon'})
    if applied or calc.get('coupon_discount',0):
        if not coupon or not coupon.applied or not coupon.cache.claim or not applied or str(applied.get('coupon_id')) != coupon.scope['couponId']:
            raise BenefitReview('ORDER_IMPORT_UNBOUND_COUPON_META')
    return {'posSelections': copy.deepcopy(selections), 'couponApplied': bool(applied),
            'originalStockLines': [{'productId':row['productId'],'quantity':row['quantity']} for row in plan['lines']]}


def complementary_wrapper(root, session, item_types, wrapper_base):
    return source_pos_wrappers(root, {'SessionR':session, 'ItemTypes':item_types,
                                      'Wrapper':wrapper_base, 'json':__import__('json')})


def assert_benefit_profile(cart,types,settings,plan,calculations):
    """Same base admission ABI as profiles.assert_plain_profile. Screening's
    reviewed wrapper can remove exactly its owned rejection, not other guards.
    The original tender gate remains AFTER all selected profile qualification.
    """
    products=cart.get(types.PRODUCTS)
    if any(str(row['prod_id'])=='390238' for row in products):
        raise ImportReview('ORDER_IMPORT_SCREENING_PROFILE_REQUIRED')
    current=CURRENT_BENEFIT_SCOPE.get()
    if current is None or current['plan'] is not plan:
        raise BenefitReview('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED')
    if calculations is not cart.get_item(types.META,{'name':'calculations'}):raise BenefitReview()
    result=admit_benefit_cart(cart,types,settings,plan,current['coupon'])
    if result['posSelections'] and current['complementary'] != COMPLEMENTARY_CONTRACT:
        raise BenefitReview('ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED')
    if plan['kind']=='offline' and Decimal(str(calculations['total']))!=Decimal(effective_tender(plan)):
        raise CalculatedImportReview(calculations['total'])
    return result
