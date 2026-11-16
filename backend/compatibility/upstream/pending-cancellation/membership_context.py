"""POS-only fresh membership reader candidate; no cache/log/credential transport.

Install only with the pinned customer-context candidate. Ordinary API callers
retain the original callable. The private POS path requires explicit deployment
of this contract and current writer reads under the source transaction.
"""
import os
from types import SimpleNamespace

CONTRACT = 'pos-membership-fresh-reader-v1'
PRIVATE_CONTEXT = 'pos_rewrite_fresh_customer'


def _fail(falcon, unavailable=False):
    error = falcon.HTTPServiceUnavailable if unavailable else falcon.HTTPForbidden
    raise error('Fresh membership context could not be verified.') from None


def fresh_membership_token(req, resp, session, user_id, email, legacy, fetch_one, falcon):
    binding = req.context.get(PRIVATE_CONTEXT)
    if binding is None:
        return legacy(session, user_id, email)
    if os.environ.get('POS_MEMBERSHIP_FRESH_READER_CONTRACT') != CONTRACT:
        _fail(falcon, True)
    if (not isinstance(binding, dict) or binding.get('loaded') is not True or
            binding.get('subject') != str(user_id) or not isinstance(email, str) or not email):
        _fail(falcon)
    try:
        user = fetch_one(session, '''
            SELECT id,email,status,is_block,is_disabled FROM users
            WHERE id=:user_id FOR SHARE
        ''', params={'user_id': user_id}, to_dict=True)
        if (not user or str(user.get('id')) != str(user_id) or user.get('email') != email or
                type(user.get('status')) is not int or user['status'] != 1 or
                any(flag not in user or (user[flag] is not None and
                    (type(user[flag]) is not int or user[flag] != 0))
                    for flag in ('is_block', 'is_disabled'))):
            _fail(falcon)
        version = fetch_one(session, '''
            SELECT revision FROM pos_rewrite_membership_versions
            WHERE customer_id=:user_id FOR SHARE
        ''', params={'user_id': user_id}, to_dict=True)
        revision = 0 if version is None else version.get('revision')
        if type(revision) is not int or not 0 <= revision <= 18446744073709551615:
            _fail(falcon)
        # Preserve the literal source active-member predicate. Expiry/pricelist
        # calculations continue through their original source implementations.
        member = fetch_one(session, '''
            SELECT entity FROM user_eav WHERE entity=:email AND
            attribute='EXCLUSIVE_MEMBER' AND is_active=1 LIMIT 1 FOR SHARE
        ''', params={'email': email}, to_dict=True)
    except Exception:
        _fail(falcon, True)
    binding['membership_revision'] = str(revision)
    if resp is not None:
        resp.set_header('X-POS-Membership-Context', CONTRACT)
        resp.set_header('X-POS-Membership-Revision', str(revision))
        resp.set_header('Cache-Control', 'private, no-store')
    return bool(member)


def fresh_membership_from_context(context, session, user_id, email, legacy, fetch_one, falcon):
    # CartFactory has the same request context but no HTTP response parameter.
    return fresh_membership_token(SimpleNamespace(context=context), None, session,
                                  user_id, email, legacy, fetch_one, falcon)
