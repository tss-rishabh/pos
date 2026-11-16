"""Build an additive pinned online-invoice artifact; only --write saves files."""
import argparse
import ast
import difflib
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / "invoice-security"
COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"


def base_builder():
    spec = importlib.util.spec_from_file_location("reviewed_invoice_security_build", BASE / "prepare.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(source_root=None, write=False):
    repository = Path(source_root) if source_root else ROOT.parents[4] / "backend-tss-api_v2"
    base = base_builder().build(repository)
    templates = {}
    for name in ("index-shop.html", "old-index.html", "new-index.html"):
        path = "templates/Invoicer/" + name
        value = subprocess.check_output(["git", "show", f"{COMMIT}:{path}"], cwd=repository)
        templates[path] = hashlib.sha256(value).hexdigest()
    resource = (ROOT / "online_resource.py").read_text()
    native_source = (ROOT.parents[2] / "src/modules/invoice-documents/native.ts").read_text()
    native = (ROOT / "native.py").read_text()
    for identifier, placeholder in (("invoiceHeaderNativeSql", "HEADER_SQL"), ("invoiceLineNativeSql", "LINE_SQL")):
        match = re.search(r"export const " + identifier + r'\s*=\s*("(?:[^"\\]|\\.)*")', native_source)
        if match is None:
            raise RuntimeError("Native invoice SQL contract is not a static reviewed literal")
        native = native.replace('"@@' + placeholder + '@@"', repr(json.loads(match.group(1))))
    original = subprocess.check_output(["git", "show", f"{COMMIT}:controllers/InvoiceController.py"], cwd=repository, text=True)
    current_functions = {"generate_invoice", "get_dynamic_platform_fee_name", "get_has_products", "get_bought_gift_vouchers", "get_priority_reason", "get_country_name_and_zone_name", "get_zone_code", "get_courier_name", "get_payment_method", "get_applied_gift_vouchers", "check_show_freebie"}
    statements = []
    count_statement = None
    for function in ast.parse(original).body:
        if isinstance(function, ast.FunctionDef) and function.name in current_functions:
            for node in ast.walk(function):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.lstrip().lower().startswith("select "):
                    if "COUNT(*) as count" in node.value:
                        if count_statement is not None:
                            raise RuntimeError("Ambiguous pinned invoice lifetime count")
                        count_statement = node.value
                    else:
                        statements.append(node.value)
    if count_statement is None:
        raise RuntimeError("Pinned invoice count statement is missing")
    history = ((ROOT / "history.py").read_text().replace('"@@COUNT_SQL@@"', repr(count_statement)).replace("[]  # @@CURRENT_SQL@@", repr(statements)))
    selected_controller = base_builder().candidate(original)
    def replace_once(old, new):
        nonlocal selected_controller
        if selected_controller.count(old) != 1:
            raise RuntimeError("Pinned selected invoice source changed")
        selected_controller = selected_controller.replace(old, new, 1)
    replace_once("class PosInvoiceShop:", "from pos_invoice_documents_scoped import selected_ids, selected_rows, selected_is_split, selected_store_id\n\nclass PosInvoiceShop:")
    replace_once('has_product_ids_param = req.get_param("has_product_ids")', 'has_product_ids_param = ",".join(selected_ids())')
    replace_once("rows = group_invoice_items(rows)\n    return rows", "rows = selected_rows(rows)\n    rows = group_invoice_items(rows)\n    return rows")
    replace_once("additional = do_tss_hacks_pos(context, pos_shop_invoice=True)", "if is_split:\n                order.store_disc_pg = sum(float(item.get(\"store_disc_pg\") or 0) for item in has_products)\n            additional = do_tss_hacks_pos(context, pos_shop_invoice=True)")
    replace_once("is_split = bool(has_product_ids_filter) and not set(has_product_ids_filter).issuperset(all_original_ids)", "is_split = selected_is_split()")
    cashback_function = next(node for node in ast.parse(original).body if isinstance(node, ast.FunctionDef) and node.name == "order_point_cashback_eligibility_check")
    cashback_literal = next(node for node in ast.walk(cashback_function) if isinstance(node, ast.Constant) and isinstance(node.value, str) and "SELECT round(sum(hp_point_credited)" in node.value)
    cashback_segment = ast.get_source_segment(original, cashback_literal)
    replace_once(cashback_segment, "f" + cashback_segment.replace("WHERE order_id = :order_id", "WHERE order_id = :order_id AND has_product_id IN ({','.join(selected_ids())})"))
    replace_once("store_id = order_store_obj.store_id if order_store_obj else None", "store_id = order_store_obj.store_id if order_store_obj else int(selected_store_id())")
    replace_once("where gift_vouchers.order_id = %d", "where gift_vouchers.order_id = %d AND hp.order_id = %d AND hp.id IN (%s)")
    replace_once("gv_query = gv_query % (order_id)", "gv_query = gv_query % (order_id, order_id, ','.join(selected_ids()))")
    scoped = (ROOT / "scoped.py").read_text()
    express_resource = (ROOT / "express_resource.py").read_text()
    factory = ((ROOT / "factory.py").read_text()
               .replace("@@BASE_FACTORY_SHA256@@", base["factorySha256"])
               .replace("@@RESOURCE_SHA256@@", hashlib.sha256(resource.encode()).hexdigest())
               .replace("@@HISTORY_SHA256@@", hashlib.sha256(history.encode()).hexdigest())
               .replace("@@NATIVE_SHA256@@", hashlib.sha256(native.encode()).hexdigest())
               .replace("@@SCOPED_SHA256@@", hashlib.sha256(scoped.encode()).hexdigest())
               .replace("@@EXPRESS_RESOURCE_SHA256@@", hashlib.sha256(express_resource.encode()).hexdigest())
               .replace("@@EXPRESS_CONTROLLER_SHA256@@", hashlib.sha256(selected_controller.encode()).hexdigest())
               .replace("{}  # @@TEMPLATE_SHA256@@", repr(templates)))
    config = (BASE / "gunicorn_config.py").read_text().replace(
        'wsgi_app = "pos_invoice_factory:create_app()"',
        'wsgi_app = "pos_invoice_documents_factory:create_app()"')
    additions = {"pos_invoice_documents.py": resource,
                 "pos_invoice_documents_history.py": history,
                 "pos_invoice_documents_native.py": native,
                 "pos_invoice_documents_scoped.py": scoped,
                 "pos_invoice_documents_express.py": express_resource,
                 "controllers/PosExpressInvoiceController.py": selected_controller,
                 "pos_invoice_documents_factory.py": factory,
                 "pos_invoice_documents_gunicorn_config.py": config}
    patch = ""
    for name, value in additions.items():
        ast.parse(value)
        patch += "".join(difflib.unified_diff([], value.splitlines(True), fromfile="/dev/null", tofile="b/" + name))
    manifest = {
        "contract": "pos-invoice-security-v1", "kind": "online", "enabled": False,
        "sourceCommit": COMMIT, "basePatchSha256": base["patchSha256"],
        "controllerSha256": base["candidateSha256"], "helperSha256": base["helperSha256"],
        "baseFactorySha256": base["factorySha256"], "templates": templates,
        "addedSha256": {name: hashlib.sha256(value.encode()).hexdigest() for name, value in additions.items()},
        "patch": "api-v2-invoice-documents.patch", "patchSha256": hashlib.sha256(patch.encode()).hexdigest(),
    }
    artifacts = {ROOT / manifest["patch"]: patch, ROOT / "manifest.json": json.dumps(manifest, indent=2) + "\n"}
    for path, value in artifacts.items():
        if write:
            path.write_text(value)
        elif not path.exists() or path.read_text() != value:
            raise RuntimeError("Online invoice candidate differs from reviewed inputs")
    return manifest


def generated_files(source_root=None):
    """Return verified additive file bytes to isolated test/runtime builders."""
    manifest = build(source_root)
    patch = (ROOT / manifest["patch"]).read_text()
    result = {}
    for block in patch.split("--- /dev/null\n")[1:]:
        lines = block.splitlines(True)
        name = lines[0].removeprefix("+++ b/").strip()
        value = "".join(line[1:] for line in lines[2:] if line.startswith("+"))
        if hashlib.sha256(value.encode()).hexdigest() != manifest["addedSha256"].get(name):
            raise RuntimeError("Additive invoice file digest changed")
        result[name] = value
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--write", action="store_true")
    options = parser.parse_args()
    print(json.dumps(build(options.source_root, options.write)))
