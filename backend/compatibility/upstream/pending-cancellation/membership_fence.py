"""Exact native source membership revision-fence contract, shared by producers."""

import hashlib
import re
from pathlib import Path

CONTRACT = "pos-membership-native-revision-v1"
ROOT = Path(__file__).resolve().parent
NAMES = (
    "pos_rewrite_mem_eav_insert",
    "pos_rewrite_mem_eav_update",
    "pos_rewrite_mem_eav_delete",
    "pos_rewrite_mem_user_email",
)


def statements():
    source = (ROOT / "membership-fence.sql").read_text()
    return [
        item.strip()
        for item in re.sub(r"^DELIMITER.*$", "", source, flags=re.M).split("$$")
        if item.strip()
    ]


def definitions():
    result = []
    for statement in statements():
        match = re.search(
            r"CREATE TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW\n(BEGIN.*END)$",
            statement,
            re.S,
        )
        if match is None:
            raise RuntimeError("Membership fence definition changed")
        name, event, table, body = match.groups()
        result.append(
            {
                "name": name,
                "event": event,
                "table": table,
                "timing": "AFTER",
                "hash": hashlib.sha256(body.encode()).hexdigest(),
            }
        )
    if tuple(item["name"] for item in result) != NAMES:
        raise RuntimeError("Membership fence set changed")
    return result
