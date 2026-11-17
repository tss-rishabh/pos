"""Execute the pinned source method against an isolated in-memory intent recorder.
No imports from Django, providers, Redis or a database; never writes source/artifacts.
"""
import ast
import hashlib
import json
import pathlib
import subprocess
import sys
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[4] / "backend-pos-web"
REVISION = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
raw = subprocess.check_output(["git", "-C", str(ROOT), "show", REVISION + ":order/views.py"], text=True)
tree = ast.parse(raw)
node = next(value for value in tree.body if isinstance(value, ast.ClassDef) and value.name == "AjaxPaymentStatusView")
method = next(value for value in node.body if isinstance(value, ast.FunctionDef) and value.name == "post")
source = ast.get_source_segment(raw, method)

def run(case):
    data = {
        "Order": [dict(id=91, pay_amt=100.0, payment_statuses=4, order_statuses=3)],
        "OrderStore": [dict(order_id=91, store=SimpleNamespace(id=1), is_manually_paid=1, offline_payment=100.0, online_payment=0.0)],
        "OrderStatus": [dict(id=3, order_status="DELIVERED")],
        "HasProduct": [dict(id=8, order_id=91, status=case.get("lineStatus", "DELIVERED"))],
        "Comments": [dict(order_id=91, status_id=3, comment="original delivered audit")],
    }
    effects = []
    class Query:
        def __init__(self, name, filters): self.name, self.filters = name, filters
        def selected(self): return [row for row in data[self.name] if all(row.get(key) == value for key, value in self.filters.items())]
        def first(self): return SimpleNamespace(**self.selected()[0]) if self.selected() else None
        def update(self, **values):
            selected = self.selected()
            for row in selected: row.update(values)
            return len(selected)
        def values(self, *fields): return [{field: row[field] for field in fields} for row in self.selected()]
        def delete(self):
            selected = self.selected()
            data[self.name][:] = [row for row in data[self.name] if row not in selected]
    class Manager:
        def __init__(self, name): self.name = name
        def filter(self, **values): return Query(self.name, values)
    class Record:
        def __init__(self, **values): self.values = values
        def save(self): data["Comments"].append(self.values)
    namespace = {name: SimpleNamespace(objects=Manager(name)) for name in data}
    Record.objects = Manager("Comments")
    namespace.update(
        Comments=Record, json=json,
        HttpResponse=lambda value, **_: json.loads(value),
        messages=SimpleNamespace(success=lambda *args: None, error=lambda *args: None),
        logger=SimpleNamespace(info=lambda *args: None),
        mark_stale=lambda *args: effects.append(["stale", *args]), order_close_date=lambda _: "2026-11-16",
        Helpers=SimpleNamespace(
            push_order_kinesis=lambda order: effects.append(["kinesis", order]),
            push_for_em=lambda order: effects.append(["engagement", order]),
            transaction_logger=lambda *args: effects.append(["transaction", *args]),
        ),
    )
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), "<pinned-payment-status>", "exec"), namespace)
    request = SimpleNamespace(POST={"order_id": "91", "pay_type": "0", **case.get("input", {})}, user=SimpleNamespace(id=44))
    result = namespace["post"](SimpleNamespace(request=request), request)
    return dict(response=result, order=data["Order"][0], mapping={key: value for key, value in data["OrderStore"][0].items() if key != "store"},
                lines=data["HasProduct"], comments=data["Comments"], effects=effects)

cases = json.load(sys.stdin)
print(json.dumps(dict(sourceRevision=REVISION, methodHash=hashlib.sha256(source.encode()).hexdigest(), results=[run(case) for case in cases])))
