"""Synthetic source execution for the Node protocol differential; no live IO."""
import json
from test_security import run_source_handler

if __name__ == "__main__":
    print(json.dumps(run_source_handler(), separators=(",", ":")))
