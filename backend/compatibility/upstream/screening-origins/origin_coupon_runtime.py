"""Pure opt-in coupon composition factory for the genuine origin owner.

Root/Hyper own application bootstrap and resource mounting. No source main,
connection, Redis operation, HTTP request or historical read occurs here.
"""
import re
from origin_contracts import unsafe
from origin_coupon_source import SourceCoupons,install
from origin_coupon_http import OriginCouponHistoryHttp
from origin_coupon_controls import OriginCouponControls,private_application,CONTRACT as CONTROLS

CONTRACT='pos-screening-origin-coupon-v1'


def configured_coupons(environment,*,root,origin_key,history_source_key,source_cache,coupon_settings,
                       prepaid,source_time_zone,sessions,other_keys=(),clock=None,point_factory=None):
    selected=environment.get('POS_SCREENING_ORIGIN_COUPON_CONTRACT')
    if selected in (None,''):return None
    if selected!=CONTRACT:unsafe('SCREENING_ORIGIN_COUPON_CONFIGURATION')
    url=environment.get('POS_SCREENING_ORIGIN_COUPON_HISTORY_URL')
    if not isinstance(url,str):unsafe('SCREENING_ORIGIN_COUPON_CONFIGURATION')
    controls=environment.get('POS_SCREENING_ORIGIN_COUPON_CONTROLS_CONTRACT')
    controls_key=environment.get('POS_SCREENING_ORIGIN_COUPON_CONTROLS_KEY','')
    if controls not in (None,'',CONTROLS):unsafe('SCREENING_ORIGIN_COUPON_CONFIGURATION')
    if controls:
        if (not isinstance(controls_key,str) or not re.fullmatch(r'[!-~]{32,4096}',controls_key)
                or controls_key in (origin_key,history_source_key) or controls_key in other_keys):unsafe('SCREENING_ORIGIN_COUPON_CONFIGURATION')
    source=SourceCoupons(root,origin_key,history_source_key,source_cache,coupon_settings,prepaid,source_time_zone,
        clock=clock,point_factory=point_factory)
    history=OriginCouponHistoryHttp(url,origin_key,ca_file=environment.get('POS_SCREENING_ORIGIN_COUPON_HISTORY_CA_FILE') or None)
    resource=OriginCouponControls(sessions,source) if controls else None
    return {'coupons':source,'history_provider':history,'install':install,
            'mount_controls':None if resource is None else lambda emit_stream,fallback=None:private_application(resource,controls_key,emit_stream,fallback)}
