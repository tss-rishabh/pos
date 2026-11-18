"""Execute pinned invoice calculator/grouping/template code on synthetic read results.

This is a literal source reducer/template oracle, not a claim to have executed
every SQL join or qualified a deployed tax service. No database/network is used.
"""
import ast
import base64
from copy import deepcopy
import datetime
import hashlib
from io import BytesIO
import json
import importlib.util
import math
from pathlib import Path
import subprocess
import sys
from types import ModuleType
from types import SimpleNamespace

import barcode
from barcode.writer import ImageWriter
import falcon
from jinja2 import DictLoader, Environment
from num2words import num2words

PIN = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
REPOSITORY = Path(__file__).resolve().parents[4] / "backend-tss-api_v2"


def source(path):
    return subprocess.check_output(["git", "show", f"{PIN}:{path}"], cwd=REPOSITORY, text=True)


class Result:
    def __init__(self, rows):
        self.rows = deepcopy(rows)

    def mappings(self):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def fetchone(self):
        return tuple(self.rows[0].values()) if self.rows else None

    def __iter__(self):
        return iter(self.rows)


class Reader:
    def __init__(self, order, rows, show_freebie=1):
        self.order = order
        self.rows = rows
        self.show_freebie = show_freebie
        self.statements = []
        self.history_reads = 0
        self.order_count = 2
        self.forbid_history = False

    def execute(self, query, parameters=None):
        query = str(query)
        normalized = " ".join(query.lower().split())
        if not normalized.startswith("select "):
            raise AssertionError("Read-only oracle received a non-SELECT")
        self.statements.append(normalized)
        if "count(*) as count from orders" in normalized:
            if self.forbid_history:
                raise AssertionError("A candidate MySQL lifetime count escaped")
            self.history_reads += 1
            return Result([{"count": self.order_count}])
        if "from orders" in normalized:
            return Result([self.order])
        if "from order_addons" in normalized:
            return Result([{"platform_fee": 2.5}])
        if "from has_products as hp" in normalized:
            return Result(self.rows)
        if "from gift_vouchers" in normalized:
            return Result([])
        if "from order_attributes" in normalized:
            return Result([{"priority_reason": "Fixture priority"}])
        if "from return_fee_configurations" in normalized:
            return Result([{"name": "Fixture platform fee"}])
        if "from tss_settings" in normalized:
            return Result([{"value": self.show_freebie}])
        if "from zones" in normalized:
            if "gst_state_code" in normalized:
                return Result([{"gst_state_code": "27" if self.order["zone_id"] == "Maharashtra" else "29"}])
            return Result([{"name": self.order["zone_id"]}])
        if "from countries" in normalized:
            return Result([{"name": "India"}])
        if "from courier_companies" in normalized:
            return Result([{"name": "Fixture courier"}])
        if "from payment_method" in normalized:
            return Result([{"name": "Prepaid"}])
        raise AssertionError("Unmodeled literal source SELECT")

    def query(self, _model):
        return self

    def filter(self, _condition):
        return self

    def first(self):
        return SimpleNamespace(firstname="Fixture", lastname="Person", address1="Fixture road", address2="", address3="", address4="", flat="10", city="Fixture city", postcode="000000", phone_no="0000000000", zone_id=1, country_id=1)


class Templates:
    def __init__(self, templates):
        self.environment = Environment(loader=DictLoader(templates))
        self.loader = SimpleNamespace(searchpath=["pinned/Invoicer"])
        self.environment.globals.update(image_domain="https://images.example.test", IMAGE_DOMAIN="https://images.example.test", IMAGE_URL="https://images.example.test", image_url="https://images.example.test")
        self.name = None
        self.context = None

    def get_template(self, name):
        parent = self
        template = self.environment.get_template(name)

        class Render:
            def render(self, context):
                parent.name = name
                parent.context = deepcopy(context)
                return template.render(context)
        return Render()


def line(identifier=101, **changes):
    return {"rowid": identifier, "order_id": 9007199254740993, "prod_id": 66, "sub_prod_id": 0,
            "qty": 1, "price": 105.0, "normal_price": 110.0, "special_price": 105.0,
            "exclusive_price": 100.0, "is_exclusive_order": 0, "disc": 5.0,
            "hp_tss_points_used": 0, "store_disc_pg": 0, "product": "Fixture shirt",
            "wc": "FIXTURE", "id": 66, "parent_prod_id": 0, "prod_type": 1,
            "is_crowd_funded": 0, "images": "", "attr_val": "XL", "category": "T-Shirt Dresses",
            "hsn": "6109", "custom_text": "", "gift_voucher": "", "gv_type": "", "gv_end_date": None,
            "order_platform_id": 1, "wallet_disc": 0, "voucher_disc": 0, "gst": 5.0,
            "prod_gst": 5.0, "pre_gst_amt": 95.24, "exclusive_saving": 1.25,
            "show_on_invoice": 1, "line_item_status": "DELIVERED", **changes}


def run():
    original = source("controllers/InvoiceController.py")
    tree = ast.parse(original)
    templates = {"Invoicer/" + name: source("templates/Invoicer/" + name) for name in ("index-shop.html", "old-index.html", "new-index.html")}
    cases = []
    issuer_contexts = []
    build_path = Path(__file__).resolve().parents[2] / "compatibility/upstream/invoice-documents/prepare.py"
    spec = importlib.util.spec_from_file_location("reviewed_invoice_document_build", build_path)
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    generated = build.generated_files()
    native = ModuleType("pos_invoice_documents_native")
    exec(compile(generated["pos_invoice_documents_native.py"], "reviewed-native", "exec"), native.__dict__)
    sys.modules["pos_invoice_documents_native"] = native
    history = ModuleType("reviewed_invoice_history_oracle")
    exec(compile(generated["pos_invoice_documents_history.py"], "reviewed-history", "exec"), history.__dict__)
    scenarios = [
        ("old-maharashtra", 2, "Maharashtra", [line()], 1),
        ("old-interstate", 2, "Karnataka", [line()], 1),
        ("new-maharashtra", 3, "Maharashtra", [line()], 1),
        ("new-interstate", 3, "Karnataka", [line()], 1),
        ("new-duplicate-unit-rows", 3, "Maharashtra", [line(), line(102)], 1),
        ("new-distinct-customization", 3, "Karnataka", [line(), line(102, custom_text="Fixture custom")], 1),
        ("new-hidden-freebie", 3, "Maharashtra", [line(), line(102, prod_id=77, prod_type=4, show_on_invoice=0)], 0),
        ("unknown-calculation-source-fallback", 0, "Karnataka", [line()], 1),
    ]
    for name, calculation, zone, rows, show_freebie in scenarios:
        order = {"id": 9007199254740993, "user_id": 777, "has_address_id": 1, "is_new_calculation": calculation,
                 "pay_amt": 123.75, "fraction_value": 0.25, "cod_charges": 5, "gifting_charges": 2,
                 "shipping_amt": 10, "hl_charges": 3, "express_charges": 4, "coupon_amt_used": 0,
                 "tss_points_used": 0, "tss_money_used": 0, "voucher_amt_used": 0, "voucher_used": 0,
                 "coupon_used": 0, "parent_order_id": 0, "zone_id": zone, "courier": 1,
                 "payment_method": 3, "ref_flag": 0, "created_at": datetime.datetime(2026, 11, 16, 10, 0, 0),
                 "order_ref_no": "FIXTURE-INVOICE"}
        reader, renderer = Reader(order, rows, show_freebie), Templates(templates)
        if name == "unknown-calculation-source-fallback":
            reader.order_count = 0
        logger = SimpleNamespace(**{key: lambda *_args, **_kwargs: None for key in ("debug", "info", "warning", "error")})
        namespace = {"math": math, "num2words": num2words, "SessionR": reader, "text": lambda value: value,
                     "logger": logger, "template_env": renderer, "falcon": falcon,
                     "FREEBIE_PRODUCT_TYPE": 4, "settings": SimpleNamespace(SKIP_COMPLEMENTARY_PRODUCT_STATUSES=["CANCELLED"]),
                     "redis_object": SimpleNamespace(get=lambda _key: str(show_freebie).encode()),
                     "Address": type("Address", (), {"id": 0,"__tablename__":"has_addresses"}), "barcode": barcode,
                     "ImageWriter": ImageWriter, "BytesIO": BytesIO, "base64": base64}
        definitions = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))], type_ignores=[])
        exec(compile(definitions, "pinned/InvoiceController.py", "exec"), namespace)
        html = namespace["generate_invoice"](order["id"], skip_auth=True)
        context = deepcopy(renderer.context)
        reader.forbid_history = True
        before_reads = reader.history_reads
        namespace["SessionR"] = history.InvoiceHistoryReader(reader)
        token = history._active.set({"orderId":str(order["id"]),"customerId":str(order["user_id"]),"orderCount":str(reader.order_count)})
        try:
            candidate_html = namespace["generate_invoice"](order["id"],skip_auth=True)
        finally:
            history._active.reset(token)
        if candidate_html != html or reader.history_reads != before_reads:
            raise AssertionError("Frozen warehouse count changed the literal source output")
        if name in ("old-maharashtra", "new-maharashtra"):
            hashes = []
            for context_store_id in ("1", "2"):
                token = history._active.set({"orderId":str(order["id"]), "customerId":str(order["user_id"]), "orderCount":str(reader.order_count), "storeId":context_store_id})
                try:
                    rendered = namespace["generate_invoice"](order["id"],skip_auth=True)
                finally:
                    history._active.reset(token)
                if rendered != html:
                    raise AssertionError("A context store changed the pinned global invoice issuer/output")
                hashes.append(hashlib.sha256(rendered.encode()).hexdigest())
            if any("from stores" in query.lower() or "join stores" in query.lower() for query in reader.statements):
                raise AssertionError("Context store issuer must not be read")
            issuer_contexts.append({"template":renderer.name,"contextStoreIds":["1","2"],"htmlSha256":hashes,"sourceIssuerRetained": all(label in html for label in ("GSTIN Number:","PAN:","CIN:"))})
        cases.append({"name": name, "template": renderer.name, "calculation": calculation,
                      "additional": context["additional"], "lines": context["has_products"],
                      "html": html, "htmlSha256": hashlib.sha256(html.encode()).hexdigest(),
                      "orderCount":context["order_count"],"candidateHtmlSha256":hashlib.sha256(candidate_html.encode()).hexdigest(),"candidateMysqlHistoryReads":reader.history_reads-before_reads,
                      "readOnlySelectCount": len(reader.statements)})
    # Concrete original grouping-before-selection hazard: the same SKU's entire
    # aggregate passes when only one source HP ID belongs to the selected store.
    grouped = namespace["group_invoice_items"]([line(201, qty=1, price=50), line(202, qty=2, price=100)])
    selected = [item for item in grouped if set([item["rowid"]] + (item.get("row_ids") or [])) & {201}]
    return {"sourceCommit": PIN, "controllerSha256": hashlib.sha256(original.encode()).hexdigest(),
            "templateSha256": {name: hashlib.sha256(value.encode()).hexdigest() for name, value in templates.items()},
            "scope": "literal source reducers/templates on controlled SELECT results; not native join/provider qualification",
            "cases": cases, "issuerContexts":issuer_contexts, "splitSelectionHazard": {"requestedHpIds": [201], "sourceQuantity": selected[0]["qty"], "sourcePrice": selected[0]["price"], "selectedRawQuantity": 1, "selectedRawPrice": 50}}


if __name__ == "__main__":
    print(json.dumps(run(), default=str))
