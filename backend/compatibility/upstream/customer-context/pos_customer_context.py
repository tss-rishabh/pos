"""Private POS context; no Redis reads/writes, logs, or mutation side effects."""
import hmac
import os
import re

import falcon

CONTRACT = "pos-customer-context-v1"
KEY_ENVIRONMENT = "TSS_POS_CUSTOMER_CONTEXT_KEY"
PATHS = frozenset("/api/v2/" + segment for segment in (
    "cart", "pos/cart", "pos/product", "pos/order", "validatecheckout", "processorder",
    "coupon", "wallet", "giftvoucher", "pg", "store-discount-pg"))
CONTEXT = "pos_rewrite_fresh_customer"
USER_SQL = """
    SELECT id, firstname, lastname, email, telephone, is_two_fa,
           is_block, tss_money, cashback, tss_points, is_cod_enable,
           fb_id, gender, birthdate, anniversary, customer_type, gstin, status,
           is_disabled
    FROM users WHERE id = :user_id
"""


def _identifier(value):
    return (isinstance(value, str) and
            re.fullmatch(r"[1-9][0-9]{0,19}", value) is not None and
            int(value) <= 18446744073709551615)


def prepare_private_pos_context(req):
    """A purpose key is accepted only on these exact authenticated POS paths."""
    key = req.get_header("X-POS-Customer-Context-Key")
    contract = req.get_header("X-POS-Customer-Context")
    subject = req.get_header("X-POS-Customer-ID")
    if key is None and contract is None and subject is None:
        return False
    if req.path not in PATHS or req.method != "POST":
        raise falcon.HTTPForbidden("Private customer context is unavailable here.")
    expected = os.environ.get(KEY_ENVIRONMENT, "")
    if re.fullmatch(r"[\x21-\x7e]{32,4096}", expected) is None:
        raise falcon.HTTPServiceUnavailable("Fresh customer context is unavailable.")
    if (not isinstance(key, str) or
            re.fullmatch(r"[\x21-\x7e]{32,4096}", key) is None or
            not hmac.compare_digest(expected, key) or contract != CONTRACT or
            not _identifier(subject)):
        raise falcon.HTTPForbidden("Private customer context could not be verified.")
    if not req.auth or req.auth == "null":
        raise falcon.HTTPUnauthorized("Checkout authentication is required.")
    req.context[CONTEXT] = {"subject": subject, "loaded": False}
    return True


def load_private_pos_user(req, user_id, fetch_one):
    binding = req.context.get(CONTEXT)
    if not binding or str(user_id) != binding["subject"]:
        raise falcon.HTTPForbidden("Private customer identity does not match.")
    session = req.context.get("session")
    if session is None:
        raise falcon.HTTPServiceUnavailable("Fresh customer context is unavailable.")
    try:
        user = fetch_one(session, USER_SQL, params={"user_id": user_id}, to_dict=True)
    except Exception:
        raise falcon.HTTPServiceUnavailable("Fresh customer context is unavailable.") from None
    if (not user or str(user.get("id")) != binding["subject"] or
            type(user.get("status")) is not int or user["status"] != 1 or
            (user.get("is_block") is not None and
             (type(user["is_block"]) is not int or user["is_block"] != 0)) or
            "is_disabled" not in user or
            (user["is_disabled"] is not None and
             (type(user["is_disabled"]) is not int or user["is_disabled"] != 0))):
        raise falcon.HTTPUnauthorized("This customer account is unavailable.")
    binding["loaded"] = True
    return user


def complete_private_pos_context(req, resp, user_id):
    binding = req.context.get(CONTEXT)
    if not binding:
        return
    if not binding["loaded"] or binding["subject"] != str(user_id):
        raise falcon.HTTPServiceUnavailable("Fresh customer context is unavailable.")
    resp.set_header("X-POS-Customer-Context", CONTRACT)
    resp.set_header("X-POS-Customer-ID", binding["subject"])
    resp.set_header("Cache-Control", "private, no-store")


def validate_private_pos_payload(req):
    binding = req.context.get(CONTEXT)
    if not binding:
        return
    data = req.context.get("data")
    if (not binding["loaded"] or not isinstance(data, dict) or
            data.get("is_pos") is not True or
            type(data.get("store_id")) is not int or
            not _identifier(str(data["store_id"]))):
        raise falcon.HTTPBadRequest("A scoped POS request is required.")
