"""Verify a separately reviewable patch; --write affects only this directory."""
import argparse
import ast
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
SOURCE_PATH = "middleware/AuthHandler.py"
SOURCE_SHA256 = "ba10581b1e3a0a20be5871777910ebbcebcec9483bdf06bfa7042b151635c241"
CONTRACT = "pos-customer-context-v1"


def _replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError("Pinned customer-context source context changed")
    return source.replace(old, new, 1)


def candidate(source):
    if hashlib.sha256(source.encode()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Pinned customer-context source digest changed")
    result = _replace_once(source, "logger = get_logger()", """from middleware.PosCustomerContext import (
    prepare_private_pos_context, load_private_pos_user,
    complete_private_pos_context, validate_private_pos_payload,
)

logger = get_logger()""")
    result = _replace_once(result, "        # For public endpoints with no auth header, skip entirely", """        private_pos_context = prepare_private_pos_context(req)

        # For public endpoints with no auth header, skip entirely""")
    start = result.index("        # Try Redis cache first for user data (5-10 min TTL)")
    end = result.index("\n        if not udata:\n            if is_public:", start)
    original_lookup = result[start:end]
    indented = "\n".join("    " + line if line else line for line in original_lookup.split("\n"))
    result = result[:start] + """        if private_pos_context:
            udata = load_private_pos_user(req, user_id, fetchOne)
        else:
""" + indented + result[end:]
    result = _replace_once(result, "    def _handle_gmetri(self, req, resp):", """        complete_private_pos_context(req, resp, user_id)

    def process_resource(self, req, resp, resource, params):
        validate_private_pos_payload(req)

    def _handle_gmetri(self, req, resp):""")
    ast.parse(result)
    return result


def build(source_root=None, write=False):
    repository = Path(source_root) if source_root else Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT', str(ROOT.parents[4] / "backend-tss-api_v2")))
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
    if actual != COMMIT:
        raise RuntimeError("API-v2 is not at the reviewed customer-context commit")
    source = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE_PATH}"], cwd=repository, text=True)
    after = candidate(source)
    helper = (ROOT / "pos_customer_context.py").read_text()
    ast.parse(helper)
    patch = "".join(difflib.unified_diff(source.splitlines(True), after.splitlines(True),
                                        fromfile="a/" + SOURCE_PATH, tofile="b/" + SOURCE_PATH))
    patch += "".join(difflib.unified_diff([], helper.splitlines(True), fromfile="/dev/null",
                                         tofile="b/middleware/PosCustomerContext.py"))
    manifest = {
        "contract": CONTRACT, "enabled": False,
        "source": {"commit": COMMIT, "path": SOURCE_PATH, "sha256": SOURCE_SHA256},
        "candidateSha256": hashlib.sha256(after.encode()).hexdigest(),
        "helperSha256": hashlib.sha256(helper.encode()).hexdigest(),
        "patch": "api-v2-customer-context.patch",
        "patchSha256": hashlib.sha256(patch.encode()).hexdigest(),
    }
    artifacts = {ROOT / manifest["patch"]: patch,
                 ROOT / "manifest.json": json.dumps(manifest, indent=2) + "\n"}
    for path, content in artifacts.items():
        if write:
            path.write_text(content)
        elif not path.exists() or path.read_text() != content:
            raise RuntimeError("Saved customer-context patch differs from its reviewed inputs")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--write", action="store_true")
    options = parser.parse_args()
    print(json.dumps(build(options.source_root, options.write)))
