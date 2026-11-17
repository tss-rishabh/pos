"""Reproducible read-only source identity; writes only this branch's manifest."""
import hashlib
import json
import subprocess
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3]
ROOT = BACKEND.parent.parent
API = ROOT / 'backend-tss-api_v2'
POS = ROOT / 'backend-pos-web'
API_COMMIT = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
POS_COMMIT = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'


def pinned(repo, commit, paths):
    if subprocess.check_output(['git','rev-parse','HEAD'], cwd=repo, text=True).strip() != commit:
        raise RuntimeError('Source commit differs from the reviewed full-sync source')
    result = {}
    for name in paths:
        expected = subprocess.check_output(['git','show',commit+':'+name], cwd=repo)
        if (repo/name).read_bytes() != expected:
            raise RuntimeError('Source working tree differs from its pinned commit')
        result[name] = hashlib.sha256(expected).hexdigest()
    return result


paths = sorted(subprocess.check_output(['git','ls-files','--','*.py','requirements*.txt'], cwd=API, text=True).splitlines())
manifest = {'contract':'pos-ecommerce-full-sync-v1','apiCommit':API_COMMIT,
    'apiFiles':pinned(API,API_COMMIT,paths), 'posCommit':POS_COMMIT,
    'posFiles':pinned(POS,POS_COMMIT,['core/tasks.py'])}
(BACKEND/'compatibility/upstream/ecommerce-full-sync/source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Pinned '+str(len(paths))+' source/runtime Python and requirements files; no source changes')
