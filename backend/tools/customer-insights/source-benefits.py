"""Execute pinned current-benefit helpers against synthetic ORM/HTTP seams only."""
import ast
import datetime
from decimal import Decimal, ROUND_DOWN
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4] / "backend-pos-web"
HELPER_SHA = "7a5010baca25487e2020950ea0e129c2a72e0ab664dc6cf3207c7d6bb12f88c0"
VIEW_SHA = "23e3ff32bc197de469f072da53a86eb1ff1bccc669d6f060e8c7c4852ff2f9e0"


class FixedDateTime(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 16, 10, 0, 0)


def verify():
    helper_path = ROOT / "helpers/helpers.py"
    view_path = ROOT / "users/views.py"
    helper_raw, view_raw = helper_path.read_bytes(), view_path.read_bytes()
    if hashlib.sha256(helper_raw).hexdigest() != HELPER_SHA or hashlib.sha256(view_raw).hexdigest() != VIEW_SHA:
        raise RuntimeError("Benefit source is not the pinned baseline")
    tree = ast.parse(helper_raw, str(helper_path))
    source_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Helpers")
    methods = [node for node in source_class.body if isinstance(node, ast.FunctionDef) and node.name in
               ("round_down", "get_exclusive_user", "expiry_after", "check_app_user_eligibility")]
    if len(methods) != 4:
        raise RuntimeError("Pinned benefit methods are unavailable")
    extracted = ast.ClassDef(name="Helpers", bases=[], keywords=[], body=methods, decorator_list=[])
    namespace = {"datetime": SimpleNamespace(datetime=FixedDateTime), "Decimal": Decimal, "ROUND_DOWN": ROUND_DOWN}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[extracted], type_ignores=[])), str(helper_path), "exec"), namespace)
    helpers = namespace["Helpers"]
    membership_cases = []
    for row in (None,
                {"value": "2060-01-02T03:04:05.123400", "active": 1},
                {"value": "2060-01-02 03:04:05", "active": 0},
                {"value": "2020-01-02T03:04:05", "active": 1},
                {"value": "2020-01-02T03:04:05", "active": 0},
                {"value": "2060-1-2T3:4:5.1", "active": 1},
                {"value": "2060-01-02 03:04:05.1", "active": 1},
                {"value": "2000-02-29T00:00:00", "active": -1},
                {"value": "2026-02-29T00:00:00", "active": 1},
                {"value": None, "active": 1},
                {"value": "0000-01-01T00:00:00", "active": 0}):
        record = None if row is None else SimpleNamespace(value=row["value"], is_active=row["active"])
        namespace["ExclusiveUser"] = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: SimpleNamespace(first=lambda: record)))
        result = helpers.get_exclusive_user("fixture@example.test")
        expiry = result["expiry"].isoformat() if result["expiry"] else None
        if expiry and "." in expiry:
            expiry = expiry.rstrip("0").rstrip(".")
        membership_cases.append({"input": row, "expected": {"active": result["member"], "expiry": expiry, "message": result["message"]}})
    wallet_cases = []
    for value in (-100.129, -0.1, 0, 0.999, 1, 1.009, 1.999, 25.509, 999999.999, 10000000.125):
        result = helpers.round_down(value) if value >= 1 else 0
        wallet_cases.append({"input": value, "expected": format(result, ".2f")})
    eligibility_cases = []
    for switched, storefront, campaigns, app_user in (
        (False, False, [], 0), (True, False, [{"is_app": True, "status": True}], 1),
        (True, True, [{"is_app": True, "status": True}], 1),
        (True, False, [{"is_app": True, "status": True}, {"is_app": True, "status": False}], 0),
        (True, False, [{"is_app": False, "status": True}], 0),
        (True, False, [{"is_app": 1, "status": 1}], 2), (True, False, [], 0)):
        calls = []
        namespace.update({
            "TEN_PER_SWITCH": switched, "STAGING_CMS_ENDPOINT": "https://cms.example.test",
            "requests": SimpleNamespace(get=lambda url: (calls.append(url) or SimpleNamespace(status_code=200, json=lambda: {"data": campaigns}))),
            "MUser": SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: SimpleNamespace(first=lambda: object() if storefront else None))),
            "connections": {"mysql_db": SimpleNamespace(cursor=lambda: SimpleNamespace(execute=lambda query: None, fetchone=lambda: [app_user]))},
            "logger": SimpleNamespace(exception=lambda *args: None),
        })
        eligible, app = helpers.check_app_user_eligibility(user_id=777)
        eligibility_cases.append({"switch": switched, "storefront": storefront, "campaigns": campaigns,
                                  "appUser": app_user, "expectedEligible": eligible, "expectedApp": bool(app), "providerCalls": len(calls)})
    return {"helperSha256": HELPER_SHA, "viewSha256": VIEW_SHA, "membershipCases": membership_cases,
            "walletCases": wallet_cases, "eligibilityCases": eligibility_cases}


if __name__ == "__main__":
    print(json.dumps(verify()))
