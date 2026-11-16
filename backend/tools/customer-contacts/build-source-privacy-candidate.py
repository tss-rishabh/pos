"""Build and dry-apply a narrow pinned source patch in temporary copies only."""

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

backend = Path(__file__).resolve().parents[2]
owned = backend / "compatibility/customer-contacts"
source = backend.parent.parent / "backend-tss-api_v2"
manifest = json.loads((owned / "source-manifest.json").read_text())
commit = manifest["sourceCommit"]
original = subprocess.run(
    ["git", "show", commit + ":tasks.py"], cwd=source, check=True, capture_output=True
).stdout
expected = next(
    item["sha256"] for item in manifest["files"] if item["path"] == "tasks.py"
)
if hashlib.sha256(original).hexdigest() != expected:
    raise ValueError("SOURCE_BASELINE_CHANGED")
modified = original
anchor = b"from utils.logger import get_logger\r\n"
if modified.count(anchor) != 1:
    raise ValueError("SOURCE_IMPORT_ANCHOR_CHANGED")
modified = modified.replace(
    anchor,
    anchor + b"from pos_contact_task_privacy import register_private_contact_tasks\r\n",
)
modified += b'\r\n# Purpose-only contact tasks: existing source task exports remain unchanged.\r\nregister_private_contact_tasks(app, {\r\n    "clevertap-profile": update_user_profile,\r\n    "moengage-attributes": sync_user_attributes_moengage_task,\r\n    "support-flags": update_customer_support_flagging_task,\r\n}, requests)\r\n'

helper = (owned / "payload/pos_contact_task_privacy.py").read_bytes()
with tempfile.TemporaryDirectory(prefix="pos_contact_privacy_candidate_") as directory:
    root = Path(directory)
    old = root / "old"
    new = root / "new"
    check = root / "check"
    old.mkdir()
    new.mkdir()
    check.mkdir()
    (old / "tasks.py").write_bytes(original)
    (new / "tasks.py").write_bytes(modified)
    (new / "pos_contact_task_privacy.py").write_bytes(helper)
    diff = subprocess.run(
        ["git", "diff", "--no-index", "--", "old", "new"],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if diff.returncode != 1:
        raise ValueError("SOURCE_DIFF_FAILED")
    patch = (
        diff.stdout.replace(b"a/old/", b"a/")
        .replace(b"b/new/", b"b/")
        .replace(b"a/new/", b"a/")
    )
    patch_path = owned / "patches/customer-contact-task-privacy.patch"
    patch_path.write_bytes(patch)
    (check / "tasks.py").write_bytes(original)
    subprocess.run(
        ["git", "init", "--quiet"], cwd=check, check=True, capture_output=True
    )
    subprocess.run(
        ["git", "apply", "--check", str(patch_path)],
        cwd=check,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "apply", "--whitespace=nowarn", str(patch_path)],
        cwd=check,
        check=True,
        capture_output=True,
    )
    if (check / "tasks.py").read_bytes() != modified or (
        check / "pos_contact_task_privacy.py"
    ).read_bytes() != helper:
        raise ValueError("SOURCE_DRY_APPLY_MISMATCH")
record = {
    "sourceCommit": commit,
    "sourceFile": "tasks.py",
    "beforeSha256": hashlib.sha256(original).hexdigest(),
    "afterSha256": hashlib.sha256(modified).hexdigest(),
    "newFile": "pos_contact_task_privacy.py",
    "newFileSha256": hashlib.sha256(helper).hexdigest(),
    "patchFile": "patches/customer-contact-task-privacy.patch",
    "patchSha256": hashlib.sha256(patch).hexdigest(),
    "dryApply": "passed-in-temporary-copy-only",
    "deployment": "not-applied",
    "resources": ["clevertap-profile", "moengage-attributes", "support-flags"],
}
(owned / "privacy-candidate-manifest.json").write_text(
    json.dumps(record, indent=2) + "\n"
)
print(
    json.dumps({"dryApply": record["dryApply"], "patchSha256": record["patchSha256"]})
)
