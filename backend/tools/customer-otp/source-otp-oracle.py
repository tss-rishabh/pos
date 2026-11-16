"""Execute pinned OTP methods with synthetic in-memory dependencies; no I/O providers."""

import ast
import hashlib
import json
import subprocess
import sys
from types import SimpleNamespace

COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
FILES = {
    "controllers/AuthController.py": "c81a9d9752b115d74c27dc32d0472356cf0f3834a808d947cbd30038bd604b85",
    "libs/helper.py": "4070e7da46499c8041c6831777b0403b2ffbf9d30911551da2da9ef0575b7766",
    "settings.py": "10f18f0098b02363e66853945ebe8c971fafd5d32c2d29648d5ef8f8faf80917",
}


def source(root, name):
    data = subprocess.check_output(["git", "-C", root, "show", COMMIT + ":" + name])
    if hashlib.sha256(data).hexdigest() != FILES[name]:
        raise ValueError("Source OTP artifact mismatch")
    return data.decode()


class Rejected(Exception):
    pass


class Redis:
    def __init__(self):
        self.values = {}
        self.sets = []

    def exists(self, key):
        return key in self.values

    def get(self, key):
        value = self.values.get(key)
        return None if value is None else str(value).encode()

    def delete(self, key):
        self.values.pop(key, None)

    def set(self, *args, **kwargs):
        self.sets.append((args, kwargs))
        self.values[args[0]] = args[1]


def execute(root):
    sources = {name: source(root, name) for name in FILES}
    calls, fallback, delays = [], [], []
    user = SimpleNamespace(email="otp.fixture@example.test", telephone="9876543210")
    redis = Redis()

    class Column:
        def __eq__(self, _other):
            return True

    class Query:
        def filter(self, _predicate):
            return self

        def first(self):
            return user

    def request(method, *args, **kwargs):
        calls.append((method, args, kwargs))
        return SimpleNamespace(status_code=200, text="success | synthetic-message")

    namespace = {
        "json": json,
        "User": SimpleNamespace(id=Column()),
        "r": SimpleNamespace(randint=lambda _start, _end: 1),
        "redis_object": redis,
        "MOBILE_OTP_FOR_EMPLOYEE": False,
        "GUPSHUP_SMS_USER_ID": "synthetic-user",
        "GUPSHUP_SMS_PASSWORD": "synthetic-password",
        "MJML_HOST": "https://mail.fixture.test/",
        "logger": SimpleNamespace(info=lambda *_: None, debug=lambda *_: None),
        "mask_phone_number": lambda _phone: "private",
        "requests": SimpleNamespace(
            get=lambda *args, **kwargs: request("GET", *args, **kwargs),
            post=lambda *args, **kwargs: request("POST", *args, **kwargs),
        ),
        "falcon": SimpleNamespace(HTTPBadRequest=Rejected, HTTP_200="200 OK"),
        "spawn_whatsapp_otp_fallback": lambda *args, **kwargs: fallback.append((args, kwargs)),
    }
    tree = ast.parse(sources["controllers/AuthController.py"])
    names = {"OmniChannelSendOtp", "OmniChannelVerifyOtp"}
    nodes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in names]
    if len(nodes) != 2:
        raise ValueError("Source OTP methods missing")
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "pinned-auth-otp", "exec"), namespace)  # noqa: S102 -- hash-verified source AST, fake dependencies only
    session = SimpleNamespace(query=lambda _model: Query())
    req = SimpleNamespace(context={"data": {"user_id": 7, "store_id": 999}, "session": session})
    resp = SimpleNamespace(body=None, status=None)
    namespace["OmniChannelSendOtp"]().on_post(req, resp)
    payload = json.loads(resp.body)
    code = redis.values["omnichannel7"]
    wrong_attempts = 0
    for _ in range(20):
        req.context["data"] = {"user_id": 7, "otp": 9999, "store_id": 123}
        try:
            namespace["OmniChannelVerifyOtp"]().on_post(req, resp)
        except Rejected:
            wrong_attempts += 1
    req.context["data"] = {"user_id": 7, "otp": int(code), "store_id": 123}
    namespace["OmniChannelVerifyOtp"]().on_post(req, resp)
    accepted = json.loads(resp.body)["message"] == "OTP verified successfully!"
    namespace["OmniChannelVerifyOtp"]().on_post(req, resp)
    replay_accepted = json.loads(resp.body)["message"] == "OTP verified successfully!"
    helper = ast.parse(sources["libs/helper.py"])
    worker = next(node for node in helper.body if isinstance(node, ast.FunctionDef)
                  and node.name == "_whatsapp_fallback_worker")
    namespace.update({
        "time": SimpleNamespace(sleep=lambda value: delays.append(value)),
        "WHATSAPP_OTP_FALLBACK_DELAY_TIME": 20,
        "_send_otp_via_whatsapp": lambda *_args: fallback.append("after-verify"),
    })
    exec(compile(ast.Module(body=[worker], type_ignores=[]), "pinned-otp-fallback", "exec"), namespace)  # noqa: S102 -- hash-verified source AST, fake dependencies only
    namespace["_whatsapp_fallback_worker"](code, user.telephone, redis_key="omnichannel7")
    return {
        "sourceCommit": COMMIT,
        "digits": len(code),
        "mobile": payload["mobile"],
        "email": payload["email"],
        "smsMethod": calls[0][0],
        "smsQueryKeys": sorted(calls[0][2]["params"]),
        "redisExpirySupplied": bool(redis.sets[0][1]) or len(redis.sets[0][0]) > 2,
        "wrongAttemptsBeforeCorrect": wrong_attempts,
        "correctAfterTwentyWrong": accepted,
        "foreignStoreAccepted": accepted,
        "proofReplayAccepted": replay_accepted,
        "globalCodeRetainedAfterVerify": redis.exists("omnichannel7"),
        "fallbackDelay": delays,
        "fallbackStillSendsAfterVerify": "after-verify" in fallback,
        "emailTemplate": json.loads(calls[1][2]["data"])["template"],
    }


if __name__ == "__main__":
    try:
        print(json.dumps(execute(sys.argv[1]), separators=(",", ":")))
    except Exception:  # noqa: BLE001 -- source diagnostics may contain private values
        print(json.dumps({"error": "SOURCE_OTP_ORACLE_FAILED"}))
        sys.exit(1)
