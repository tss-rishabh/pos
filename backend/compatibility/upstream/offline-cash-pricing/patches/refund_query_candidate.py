"""Verify a candidate refund query in a temporary source copy; never apply it live."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

SOURCE_COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
SOURCE_SHA256 = "821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad"
RELATIVE = Path("controllers/OrderController.py")
HERE = Path(__file__).resolve().parent
PATCH = HERE / "refund-by-hp-id.patch"
MANIFEST = HERE / "refund-by-hp-id.manifest.json"
OLD = (
    "                UPDATE has_products SET amount_to_be_refunded = {}, fraction_value = 0 WHERE order_id = {} and prod_id = {}\n"
    "            '''.format(amount_to_be_refunded, orderId, order_product['prod_id'])"
)
NEW = (
    "                UPDATE has_products SET amount_to_be_refunded = {}, fraction_value = 0 WHERE order_id = {} and prod_id = {} AND id = {}\n"
    "            '''.format(amount_to_be_refunded, orderId, order_product['prod_id'], order_product['id'])"
)


class CandidateError(Exception):
    pass


def sha256(contents):
    return hashlib.sha256(contents).hexdigest()


def candidate_bytes(original):
    if sha256(original) != SOURCE_SHA256:
        raise CandidateError("SOURCE_REVISION_UNVERIFIED")
    text = original.decode("utf-8")
    if text.count(OLD) != 1:
        raise CandidateError("SOURCE_QUERY_SHAPE_UNVERIFIED")
    return text.replace(OLD, NEW, 1).encode("utf-8")


def verified_manifest(original):
    manifest = json.loads(MANIFEST.read_text())
    if (
        manifest["source"]["commit"] != SOURCE_COMMIT
        or manifest["source"]["path"] != RELATIVE.as_posix()
        or manifest["source"]["sha256"] != SOURCE_SHA256
        or manifest["candidate"]["patch"] != PATCH.name
        or manifest["candidate"]["patch_sha256"] != sha256(PATCH.read_bytes())
        or manifest["candidate"]["sha256"] != sha256(candidate_bytes(original))
        or manifest["enabled"] is not False
        or manifest["response_identical"] is not False
    ):
        raise CandidateError("CANDIDATE_MANIFEST_INVALID")
    return manifest


def checked_git(arguments, directory):
    result = subprocess.run(
        ["git", "apply", *arguments, str(PATCH)],
        cwd=directory,
        capture_output=True,
        check=False,
        timeout=15,
    )
    if result.returncode != 0:
        raise CandidateError("TEMPORARY_PATCH_VERIFICATION_FAILED")


@contextmanager
def applied_candidate(source_root):
    """Only the temporary directory is writable. Validate source bytes again on exit."""
    source_file = Path(source_root) / RELATIVE
    original = source_file.read_bytes()
    manifest = verified_manifest(original)
    expected = candidate_bytes(original)
    try:
        with tempfile.TemporaryDirectory(
            prefix="pos-refund-query-candidate-"
        ) as directory:
            root = Path(directory)
            target = root / RELATIVE
            target.parent.mkdir(parents=True)
            target.write_bytes(original)
            checked_git(["--check", "--whitespace=error"], root)
            checked_git(["--whitespace=error"], root)
            if target.read_bytes() != expected:
                raise CandidateError("CANDIDATE_BYTES_INVALID")
            if {
                path.relative_to(root) for path in root.rglob("*") if path.is_file()
            } != {RELATIVE}:
                raise CandidateError("CANDIDATE_SCOPE_INVALID")
            checked_git(["--reverse", "--check", "--whitespace=error"], root)
            yield root, original, target.read_bytes(), manifest
    finally:
        if source_file.read_bytes() != original:
            raise CandidateError("SOURCE_CHANGED_DURING_VERIFICATION")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-root",
        type=Path,
        default=Path(__file__).resolve().parents[6] / "backend-tss-api_v2",
    )
    arguments = parser.parse_args()
    with applied_candidate(arguments.source_root) as (_, original, corrected, manifest):
        result = {
            "module": "offline-cash-refund-query",
            "resource": "candidate-patch",
            "eventId": "candidate-patch.verified",
            "sourceSha256": sha256(original),
            "candidateSha256": sha256(corrected),
            "patchSha256": manifest["candidate"]["patch_sha256"],
            "dryApplyVerified": True,
            "liveSourceModified": False,
            "enabled": False,
            "responseIdentical": False,
        }
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"error":"REFUND_QUERY_CANDIDATE_VERIFICATION_FAILED"}')
        raise SystemExit(1) from None
