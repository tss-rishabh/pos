"""Cross-origin quota reader. No origin capability/issuer is shared."""
from pathlib import Path
import os
import sys


def pending(session,customer):
    root=Path(__file__).resolve().parent.parent
    for directory in ('public-screening-writer','screening-origins'):
        location=str(root/directory)
        if location not in sys.path:sys.path.insert(0,location)
    from origin_ledger import pending as read
    return read(session,customer,os.environ.get('POS_SCREENING_ORIGIN_PROOF_KEY',''))
