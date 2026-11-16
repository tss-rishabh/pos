"""Execute the literal pinned SMS handler with inert readers/signer/HTTP fakes.

No source module initialization, real recipient, token log or network is used.
This command emits synthetic vectors only and never rewrites artifacts.
"""
import ast
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[4] / "backend-tss-api_v2"
COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
source = subprocess.check_output(["git", "show", COMMIT + ":controllers/AuthController.py"], cwd=SOURCE, text=True)
tree = ast.parse(source)
handler = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "OmniChannelSms")
method = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == "on_post")
selection = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "check_for_sms")
code = compile(ast.Module(body=[method, selection], type_ignores=[]), "pinned-order-sms", "exec")
vectors = []
for name in ("", "Fixture", "Café ", "雪", "<script>fixture</script>"):
    for flag in (None, 0, 1):
        for short in (False, True):
            calls, signers = [], []
            class User:
                id = 0
            customer = SimpleNamespace(firstname=name, lastname="Customer", telephone="9000000000", is_two_fa=False)
            class Session:
                def execute(self, query, _parameters):
                    result = {"user_id": 77} if "from orders" in query else None if flag is None else {"is_nps_notification_checked": flag}
                    return SimpleNamespace(fetchone=lambda: result)
                def query(self, _model):
                    return self
                def filter(self, _condition):
                    return self
                def first(self):
                    return customer
            def signer(*_args):
                signers.append(True)
                return b"SYNTHETIC-LEGACY-CUSTOMER-JWT", None
            def send(url, params):
                calls.append({"url": url, "params": params.copy()})
                return SimpleNamespace(status_code=200)
            scope = {"json": json, "falcon": SimpleNamespace(HTTPBadRequest=ValueError, HTTP_400="400"), "User": User,
                     "create_token": signer, "create_token512": signer,
                     "settings": SimpleNamespace(NPS_HOST_URL="https://legacy-feedback.example.test/"),
                     "logger": SimpleNamespace(info=lambda *_: None, debug=lambda *_: None),
                     "GUPSHUP_SMS_USER_ID": "FIXTURE-SMS-USER", "GUPSHUP_SMS_PASSWORD": "FIXTURE-SMS-PASSWORD",
                     "requests": SimpleNamespace(get=send)}
            exec(code, scope)
            request = SimpleNamespace(context={"data": {"order_id": "9007199254740993"}, "session": Session()})
            response = SimpleNamespace()
            url = "https://feedback.example.test/invoice-feedback#feedback_proof=SYNTHETIC-PURPOSE-PROOF"
            self = SimpleNamespace(get_shorten_url=lambda _url: {"data": {"shorten_url": url}} if short else None)
            scope["on_post"](self, request, response)
            if len(calls) != 1:
                raise RuntimeError("Pinned SMS handler call contract changed")
            vectors.append({"orderId": "9007199254740993", "firstName": name, "lastName": "Customer",
                            "feedbackUrl": url if flag == 1 and short else None,
                            "message": calls[0]["params"]["msg"], "legacySignerCalls": len(signers),
                            "legacyMethod": "GET", "response": json.loads(response.body)})
print(json.dumps(vectors, ensure_ascii=False))
