"""Read-only literal-source constructor fixture; no service/database writes."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'compatibility/upstream/offline-cash-pricing'))
from test_source_template import CashExecutor

executor = CashExecutor(line_items='--quantity-mode' not in sys.argv,
    quantities=(3, 2) if '--remainder-basket' in sys.argv else (3, 1))
print(json.dumps({
    'template': executor.template(),
    'envelope': json.loads(executor.row['receipt_json']),
    'authorization': json.loads(executor.row['authorization_json']),
    'snapshot': json.loads(executor.row['snapshot_json']),
    'serverKey': executor.server_key,
    'deviceKey': json.loads(executor.row['public_key_json']),
}, ensure_ascii=False, allow_nan=False))
