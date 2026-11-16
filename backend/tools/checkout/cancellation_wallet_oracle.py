"""Read-only differential original/candidate wallet cancellation evidence."""
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

sys.dont_write_bytecode = True

candidate = Path(__file__).resolve().parents[2] / 'compatibility/upstream/pending-cancellation/wallet_candidate.py'
spec = importlib.util.spec_from_file_location('pending_cancel_wallet', candidate)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
vectors = []
for kind in ('money', 'points'):
    returned, key = ('tss_money_return', 'tss_money_id') if kind == 'money' else ('tss_point_return', 'tss_point_id')
    for name, amounts, expiries, requested in [
        ('one-earning', [5.0], ['2027-02-01'], 5.0),
        ('two-same-expiry', [2.0, 3.0], ['2027-02-01', '2027-02-01'], 5.0),
        ('two-expiries', [2.0, 3.0], ['2027-02-01', '2027-05-01'], 5.0),
        ('expired-earning', [5.0], ['2026-11-16'], 5.0),
        ('incomplete-mapping', [3.0], ['2027-02-01'], 5.0),
        ('no-mapping', [], [], 5.0),
    ]:
        mappings = [{'id': index + 1, key: index + 100, 'used_amount': amount, returned: 0.0} for index, amount in enumerate(amounts)]
        histories = {index + 100: {'is_expired': 0, 'expiry': datetime.fromisoformat(expiry), 'platform': 'MISC_COMPENSATION'} for index, expiry in enumerate(expiries)}
        snapshot = {'mappings': mappings, 'histories': histories, 'requested': requested, 'user': {'tss_money': 100.0, 'tss_points': 200.0, 'cashback': 7.0}}
        before = module.run(kind, snapshot)
        try:
            after = module.run(kind, snapshot, corrected=True)
        except module.Rejected as error:
            after = {'rejected': str(error)}
        vectors.append({'kind': kind, 'name': name, 'original': before, 'candidate': after})
print(json.dumps({'sourceCommit': module.COMMIT, 'cases': vectors}, default=str))
