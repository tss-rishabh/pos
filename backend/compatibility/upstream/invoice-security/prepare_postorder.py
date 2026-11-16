"""Build the pinned isolated feedback service. Default operation is read-only."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
COMMIT = "a941f4e84ed485c10169132a3972b8db74ab31bc"
SOURCE_HASHES = {
    "src/controllers/nps/index.ts": "0d96dc57d11313090d2fb15c36280d15e9934bfa3dabd142dc80fa8059dd624e",
    "src/controllers/nps/helper.ts": "40a12592f557d51dad3cc155f90073d48f4910f3ec08773fca24b4ad456afc62",
    "src/db/mysql.ts": "14315107c6b0542437266e71b60558c6e4ede9184926b02f9285f256e95e1a96",
}


def sources(source_root=None):
    repository = Path(source_root) if source_root else ROOT.parents[4] / "backend-tss-post-order"
    original, candidates = {}, {}
    for path, digest in SOURCE_HASHES.items():
        value = subprocess.check_output(["git", "show", f"{COMMIT}:{path}"], cwd=repository, text=True)
        if hashlib.sha256(value.encode()).hexdigest() != digest:
            raise RuntimeError("Pinned feedback source changed")
        old = 'import logger from "../../utils/logger.ts";' if "/nps/" in path else "import logger from '../utils/logger.ts';"
        new = 'import logger from "../../utils/PosFeedbackPrivacy.ts";' if "/nps/" in path else "import logger from '../utils/PosFeedbackPrivacy.ts';"
        if value.count(old) != 1:
            raise RuntimeError("Feedback logger boundary changed")
        original[path], candidates[path] = value, value.replace(old, new, 1)
    additions = {
        "pos_feedback_factory.ts": (ROOT / "postorder_factory.ts").read_text(),
        "pos_feedback_main.ts": (ROOT / "postorder_main.ts").read_text(),
        "src/utils/PosFeedbackPrivacy.ts": (ROOT / "PosFeedbackPrivacy.ts").read_text(),
        "src/utils/PosInvoiceFeedback.ts": (ROOT / "PosInvoiceFeedback.ts").read_text(),
        "src/utils/PosInvoiceFeedbackProof.ts": (ROOT.parents[2] / "src/modules/checkout/feedback-proof.ts").read_text(),
        "pos_feedback_public/index.html": (ROOT / "feedback.html").read_text(),
        "pos_feedback_public/feedback.css": (ROOT / "feedback.css").read_text(),
        "pos_feedback_public/feedback.js": subprocess.check_output(["node", str(ROOT / "compile-client.cjs")], text=True),
    }
    return original, candidates, additions


def build(source_root=None, write=False):
    original, candidates, additions = sources(source_root)
    patch = ""
    for path, value in candidates.items():
        patch += "".join(difflib.unified_diff(original[path].splitlines(True), value.splitlines(True),
                                            fromfile="a/" + path, tofile="b/" + path))
    for path, value in additions.items():
        patch += "".join(difflib.unified_diff([], value.splitlines(True), fromfile="/dev/null", tofile="b/" + path))
    manifest = {
        "contract": "pos-feedback-proof-v1", "enabled": False,
        "sourceCommit": COMMIT, "isolatedEntrypoint": "pos_feedback_main.ts",
        "sourceSha256": SOURCE_HASHES,
        "candidateSha256": {path: hashlib.sha256(value.encode()).hexdigest() for path, value in candidates.items()},
        "addedSha256": {path: hashlib.sha256(value.encode()).hexdigest() for path, value in additions.items()},
        "patch": "post-order-feedback-security.patch", "patchSha256": hashlib.sha256(patch.encode()).hexdigest(),
    }
    for path, value in {ROOT / manifest["patch"]: patch, ROOT / "postorder-manifest.json": json.dumps(manifest, indent=2) + "\n",
                        ROOT / "feedback-client.js": additions["pos_feedback_public/feedback.js"]}.items():
        if write:
            path.write_text(value)
        elif not path.exists() or path.read_text() != value:
            raise RuntimeError("Saved feedback correction differs from reviewed inputs")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--write", action="store_true")
    options = parser.parse_args()
    print(json.dumps(build(options.source_root, options.write)))
