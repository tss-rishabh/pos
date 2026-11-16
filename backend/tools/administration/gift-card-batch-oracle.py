"""Pinned gift batch generation only; no source application imports or network/storage effects."""

import ast
import csv
import hashlib
import io
import json
import random
import sys
from pathlib import Path
from types import SimpleNamespace

from hashids import Hashids


def main():
    backend = Path(__file__).resolve().parents[2]
    source = backend.parent.parent / "backend-pos-web"
    expected = {
        item["path"]: item["sha256"]
        for item in json.loads((backend / "parity/legacy-inventory.json").read_text())[
            "source_hashes"
        ]
    }
    name = "helpers/helpers.py"
    data = (source / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected[name]:
        raise ValueError("SOURCE_BASELINE_CHANGED")
    original = next(
        node
        for node in ast.parse(data.decode()).body
        if isinstance(node, ast.ClassDef) and node.name == "Helpers"
    )
    methods = [
        node
        for node in original.body
        if isinstance(node, ast.FunctionDef)
        and node.name in ["generate_gift_card", "create_gc_pin", "clean_email"]
    ]
    declaration = ast.ClassDef(
        name="Helpers", bases=[], keywords=[], body=methods, decorator_list=[]
    )
    module = ast.fix_missing_locations(ast.Module(body=[declaration], type_ignores=[]))
    payload = json.load(sys.stdin)
    results = []
    for case in payload["cases"]:
        calls = []
        generator = random.Random(case.get("seed", 14))

        def draw(minimum, maximum, *, random_source=generator, recorded_calls=calls):
            value = random_source.randint(minimum, maximum)
            recorded_calls.append(
                {"minimum": minimum, "maximum": maximum, "value": value}
            )
            return value

        namespace = {
            "Hashids": Hashids,
            "GC_SALTKEY": "fixture-gift-card-batch-salt",
            "random": SimpleNamespace(randint=draw),
            "logger": SimpleNamespace(exception=lambda *_: None),
            "re": __import__("re"),
        }
        exec(compile(module, "<pinned-source-gift-card-generation>", "exec"), namespace)  # noqa: S102 -- Only pinned repository AST methods execute; input never supplies code.
        helper = namespace["Helpers"]
        if case["operation"] == "generate":
            rows = helper.generate_gift_card(int(case["collectionId"]), case["size"])
            if rows is False:
                raise ValueError("SOURCE_GENERATION_FAILED")
            output = io.StringIO(newline="")
            csv.writer(output).writerows(rows)
            results.append(
                {
                    "randomCalls": calls,
                    "cards": [
                        {
                            "collectionId": str(row[0]),
                            "serial": row[1],
                            "code": row[2],
                            "pin": row[3],
                        }
                        for row in rows[1:]
                    ],
                    "csv": output.getvalue(),
                }
            )
        elif case["operation"] == "pin":
            results.append(helper.create_gc_pin(case["serial"]))
        elif case["operation"] == "email":
            results.append(helper.clean_email(case["email"]))
        else:
            raise ValueError("SOURCE_OPERATION_UNSUPPORTED")
    json.dump({"sourceSha256": expected[name], "cases": results}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- Static source tool failure never prints payload or provider details.
        json.dump({"error": "SOURCE_GIFT_BATCH_ORACLE_FAILED"}, sys.stdout)
        sys.exit(1)
