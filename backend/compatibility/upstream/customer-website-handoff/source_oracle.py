"""Execute only pinned pure source functions with synthetic identities/secrets.

No source Django settings, databases, Redis, logger or provider is imported.
Only safe summaries, never a JWT/key/full unsafe URL, leave this process.
"""
import ast
import datetime
import hashlib
import json
import pathlib
import subprocess
import types
from urllib.parse import parse_qs, urlparse

import jwt

PIN = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
SOURCE = pathlib.Path(__file__).resolve().parents[5] / "backend-pos-web"


def source_file(path):
    return subprocess.check_output(["git", "-C", str(SOURCE), "show", PIN + ":" + path], text=True)


def extract(text, owner, names):
    cls = next(value for value in ast.parse(text).body if isinstance(value, ast.ClassDef) and value.name == owner)
    selected = []
    for name in names:
        method = next(value for value in cls.body if isinstance(value, (ast.FunctionDef, ast.AsyncFunctionDef)) and value.name == name)
        if owner != "Helpers":
            method.decorator_list = []
        selected.append(method)
    return ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name=owner, bases=[], keywords=[], body=selected, decorator_list=[])], type_ignores=[]))


class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 1, 2, 3, 4, 5, tzinfo=tz)


class Manager:
    def __init__(self):
        self.two_fa = False
        self.shadow = True

    def filter(self, **fields):
        if "pos_admin_id" in fields:
            return types.SimpleNamespace(first=lambda: types.SimpleNamespace(id=88) if self.shadow else None)
        return types.SimpleNamespace(first=lambda: types.SimpleNamespace(is_two_fa=int(self.two_fa)))


def main():
    helper, view = source_file("helpers/helpers.py"), source_file("order/views.py")
    manager = Manager()
    scope = {
        "jwt": jwt, "datetime": types.SimpleNamespace(datetime=Clock), "timedelta": datetime.timedelta,
        "SECRET_KEY": "synthetic-source-hs256-fixture-secret-" * 2,
        "SECRET_KEY_512": "synthetic-source-hs512-fixture-secret-" * 2,
        "JWT_EXPIRY_DAY": 1, "JWT_CUSTOM_EXPIRY_MIN": 5,
        "WEB_URL": "https://website.fixture.test", "WEB_LOGIN_API_KEY": "synthetic-not-production",
        "MUser": types.SimpleNamespace(objects=manager),
    }
    exec(compile(extract(helper,"Helpers",["encodeJwt","encodeJwt512","create_token"]), "pinned/helpers.py", "exec"),scope)
    exec(compile(extract(view,"AjaxOnlineOrderView",["create_token"]), "pinned/views.py", "exec"),scope)
    handler = scope["AjaxOnlineOrderView"]()
    handler.request = types.SimpleNamespace(user=types.SimpleNamespace(id=1))
    vectors=[]
    for two_fa, shadow in [(False,True),(True,True),(False,False)]:
        manager.two_fa, manager.shadow = two_fa, shadow
        result = urlparse(handler.create_token("7","1"))
        query = parse_qs(result.query)
        encoded = query["token"][0]
        token = encoded[3:] if two_fa else encoded
        payload = jwt.decode(token, options={"verify_signature":False})
        vectors.append({"twoFactor":two_fa,"algorithm":jwt.get_unverified_header(token)["alg"],
            "prefix":encoded.startswith("2f."),"customerId":payload["sub"],
            "expirySeconds":payload["exp"]-payload["iat"],"path":result.path,
            "queryKeys":sorted(query),"storeId":query["pos_store_id"][0],
            "operatorCustomerId":query["pos_user_id"][0]})
    print(json.dumps({"pin":PIN,"sourceHashes":{
        "helpers/helpers.py":hashlib.sha256(helper.encode()).hexdigest(),
        "order/views.py":hashlib.sha256(view.encode()).hexdigest()},"vectors":vectors}))


if __name__ == "__main__":
    main()
