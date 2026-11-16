"""Execute only the pinned profile methods against recording ORM/SQL seams."""
import ast
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import re
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[4] / "backend-pos-web/users/views.py"
SOURCE_SHA256 = "23e3ff32bc197de469f072da53a86eb1ff1bccc669d6f060e8c7c4852ff2f9e0"


def verify():
    raw = SOURCE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Profile source is not the pinned baseline")
    tree = ast.parse(raw, str(SOURCE))
    selected = [node for node in tree.body if isinstance(node, ast.ClassDef) and
                node.name in ("AjaxUpdateEndUserDataView", "AjaxUserUpdateView")]
    if len(selected) != 2:
        raise RuntimeError("Pinned profile methods are unavailable")
    namespace = {"View": type("View", (), {}), "LoginRequiredMixin": type("LoginRequiredMixin", (), {}),
                 "json": json, "HttpResponse": lambda value, **kwargs: json.loads(value),
                 "JsonResponse": lambda value: value}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"), namespace)
    property_vectors = 0
    for property_name, value, field in (("birthday", "2000-02-29", "birthdate"),
                                         ("BIRTHDAY", "1999-01-01", "birthdate"),
                                         ("anniversary", "2020-12-31", "anniversary"),
                                         ("gender", "F", "gender"), ("gender", "M", "gender"),
                                         ("gender", "O", "gender")):
        original = {"birthdate": "1980-01-01", "anniversary": "2000-01-01", "gender": "F",
                    "email": "fixture@example.test", "telephone": "9876543210", "tss_money": 100,
                    "cashback": 7, "tss_points": 10, "customer_type": "B2C", "gstin": ""}
        saved = []
        user = SimpleNamespace(**original)
        user.save = lambda: saved.append({key: getattr(user, key) for key in original})
        queryset = SimpleNamespace(exists=lambda: True, first=lambda: user)
        namespace["MUser"] = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: queryset))
        result = namespace["AjaxUpdateEndUserDataView"]().post(SimpleNamespace(POST={
            "user_id": "777", "user_property": property_name, "property_value": value}))
        if result["status"] != 200 or saved != [{**original, field: value}]:
            raise RuntimeError("Pinned property mapping differs")
        property_vectors += 1
    sql_vectors = 0
    for customer_type, gstin in (("B2C", ""), ("B2B", "27ABCDE1234F1Z5")):
        statements = []
        namespace["connections"] = {"mysql_db": SimpleNamespace(cursor=lambda: SimpleNamespace(execute=statements.append))}
        with redirect_stdout(io.StringIO()):
            result = namespace["AjaxUserUpdateView"]().post(SimpleNamespace(POST={
                "user_id": "777", "name": "Unused name", "email": "unused@example.test",
                "telephone": "9000000000", "customer_type": customer_type, "gstin": gstin}))
        if result["status"] != 200 or len(statements) != 1:
            raise RuntimeError("Pinned business profile update differs")
        parsed = re.fullmatch(r'\s*UPDATE users SET customer_type = "([^"]*)", gstin = "([^"]*)" WHERE id = "([^"]*)";\s*', statements[0])
        if not parsed or parsed.groups() != (customer_type, gstin, "777"):
            raise RuntimeError("Pinned business field mapping differs")
        sql_vectors += 1
    return {"sourceSha256": SOURCE_SHA256, "propertyVectors": property_vectors, "businessVectors": sql_vectors}


if __name__ == "__main__":
    print(json.dumps(verify()))
