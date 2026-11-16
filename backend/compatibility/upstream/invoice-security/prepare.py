"""Build a pinned invoice correction; only --write updates target artifacts."""
import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
SOURCE_PATH = "controllers/InvoiceController.py"
SOURCE_SHA256 = "bbff2ee49dc13fd389613cb1f4a7f811578f5810d19c938a314883f5c4eec969"


def _replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError("Pinned invoice source context changed")
    return source.replace(old, new, 1)


def candidate(source):
    if hashlib.sha256(source.encode()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Pinned invoice source digest changed")
    output = _replace_once(source, "from controllers.AuthController import (create_token)", "")
    output = _replace_once(output, "from utils.logger import get_logger", """from controllers.PosInvoiceSecurity import (
    require_invoice_scope, feedback_url, stamp_invoice_response,
    safe_invoice_logger, clear_invoice_scope,
)""")
    output = _replace_once(output, "logger = get_logger()", "logger = safe_invoice_logger()")
    output = _replace_once(output, "            redis_object.set(key, value)\n", "            # Private invoice rendering never populates shared Redis.\n")
    output = _replace_once(output, '        pos_token = req.get_param("pos_token")', '        scope = require_invoice_scope(req, "store")')
    output = _replace_once(output, """        if pos_token != settings.POS_INVOICE_KEY:
            raise falcon.HTTPUnauthorized(
                title="Unauthorized",
                description="You are not authorized for this POS invoice."
            )
""", "")
    output = _replace_once(output, """            jwt_token, _ = create_token(session, order.user_id, None)
            token = jwt_token.decode("utf-8")
            nps_url = f"{settings.NPS_HOST_URL}?orderId={order_id}&token={token}"
""", """            nps_url = feedback_url(order_id)
""")
    output = _replace_once(output, """            # resp.set_header("Access-Control-Allow-Credentials", "true")
            resp.content_type = "text/html; charset=utf-8"

        except Exception as err:
            logger.error(f"POS Invoice Error: {str(err)}")
            raise falcon.HTTPBadRequest(
                title="Invoice Error",
                description=str(err)
            )
""", """            resp.content_type = "text/html; charset=utf-8"
            stamp_invoice_response(resp, html, scope)

        except falcon.HTTPError:
            raise
        except Exception:
            logger.error("source-error")
            raise falcon.HTTPBadRequest(
                title="Invoice Error",
                description="The private invoice could not be generated."
            )
        finally:
            clear_invoice_scope()
""")
    tree = ast.parse(output)
    if any(isinstance(node, ast.Name) and node.id in {"create_token", "create_token512", "user_token_log"} for node in ast.walk(tree)):
        raise RuntimeError("Customer token helpers remain in invoice candidate")
    return output


def build(source_root=None, write=False):
    repository = Path(source_root) if source_root else ROOT.parents[4] / "backend-tss-api_v2"
    source = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE_PATH}"], cwd=repository, text=True)
    output = candidate(source)
    helper = (ROOT / "pos_invoice_security.py").read_text()
    ast.parse(helper)
    factory = ((ROOT / "factory.py").read_text()
               .replace("@@CONTROLLER_SHA256@@", hashlib.sha256(output.encode()).hexdigest())
               .replace("@@HELPER_SHA256@@", hashlib.sha256(helper.encode()).hexdigest()))
    ast.parse(factory)
    verifier = (ROOT.parents[2] / "src/modules/checkout/feedback-proof.ts").read_text()
    patch = "".join(difflib.unified_diff(source.splitlines(True), output.splitlines(True),
                                       fromfile="a/" + SOURCE_PATH, tofile="b/" + SOURCE_PATH))
    patch += "".join(difflib.unified_diff([], helper.splitlines(True), fromfile="/dev/null", tofile="b/controllers/PosInvoiceSecurity.py"))
    patch += "".join(difflib.unified_diff([], factory.splitlines(True), fromfile="/dev/null", tofile="b/pos_invoice_factory.py"))
    additions = {
        "pos_invoice_gunicorn.py": (ROOT / "closed_gunicorn.py").read_text(),
        "pos_invoice_gunicorn_config.py": (ROOT / "gunicorn_config.py").read_text(),
    }
    for path, value in additions.items():
        ast.parse(value)
        patch += "".join(difflib.unified_diff([], value.splitlines(True), fromfile="/dev/null", tofile="b/" + path))
    manifest = {
        "contract": "pos-invoice-security-v1", "feedbackContract": "pos-feedback-proof-v1", "enabled": False,
        "source": {"commit": COMMIT, "path": SOURCE_PATH, "sha256": SOURCE_SHA256},
        "candidateSha256": hashlib.sha256(output.encode()).hexdigest(),
        "helperSha256": hashlib.sha256(helper.encode()).hexdigest(),
        "factorySha256": hashlib.sha256(factory.encode()).hexdigest(),
        "feedbackVerifierSha256": hashlib.sha256(verifier.encode()).hexdigest(),
        "addedSha256": {path: hashlib.sha256(value.encode()).hexdigest() for path, value in additions.items()},
        "runtimeSha256": {name: hashlib.sha256((ROOT / "runtime" / name).read_bytes()).hexdigest() for name in ("pyproject.toml", "uv.lock")},
        "patch": "api-v2-invoice-security.patch", "patchSha256": hashlib.sha256(patch.encode()).hexdigest(),
    }
    artifacts = {ROOT / manifest["patch"]: patch, ROOT / "manifest.json": json.dumps(manifest, indent=2) + "\n",
                 ROOT / "feedback-proof.ts": verifier}
    for path, content in artifacts.items():
        if write:
            path.write_text(content)
        elif not path.exists() or path.read_text() != content:
            raise RuntimeError("Saved invoice candidate differs from reviewed inputs")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--write", action="store_true")
    options = parser.parse_args()
    print(json.dumps(build(options.source_root, options.write)))
