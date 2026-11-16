"""Compose a pinned private membership reader patch; default verification is read-only."""
import argparse
import ast
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
COMMIT = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
CONTRACT = 'pos-membership-fresh-reader-v1'


def customer_context():
    filename = ROOT.parent / 'customer-context' / 'prepare.py'
    spec = importlib.util.spec_from_file_location('pinned_pos_customer_context_prepare', filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(write=False):
    repository = ROOT.parents[4] / 'backend-tss-api_v2'
    pinned = customer_context()
    originals = {filename: subprocess.check_output(['git','show',COMMIT+':'+filename],cwd=repository,text=True) for filename in ('middleware/AuthHandler.py','middleware/CartMiddleware.py')}
    # This is an overlay on the independently verified fresh-customer candidate.
    before = {'middleware/AuthHandler.py': pinned.candidate(originals['middleware/AuthHandler.py']), 'middleware/CartMiddleware.py': originals['middleware/CartMiddleware.py']}
    after = {}
    for path, source in before.items():
        if path.endswith('AuthHandler.py'):
            old = "get_exclusive_token(req.context['session'], user_id, udata['email'])"
            if source.count(old) != 2:
                raise RuntimeError('Pinned AuthHandler membership call sites changed')
            result = source.replace(old, "fresh_membership_token(req, resp, req.context['session'], user_id, udata['email'], get_exclusive_token, fetchOne, falcon)")
            result = 'from middleware.PosMembershipContext import fresh_membership_token\n' + result
        else:
            old = 'get_exclusive_token(context[\'session\'], user.get(\'user_id\'), user.get("email"))'
            if source.count(old) != 2:
                raise RuntimeError('Pinned cart membership call sites changed')
            result = source.replace(old, 'fresh_membership_from_context(context, context[\'session\'], user.get(\'user_id\'), user.get("email"), get_exclusive_token, fetchOne, falcon)')
            result = 'import falcon\nfrom libs.db import fetchOne\nfrom middleware.PosMembershipContext import fresh_membership_from_context\n' + result
            old_error = '        except Exception as e:\n            logger.error'
            if result.count(old_error) != 1:
                raise RuntimeError('Pinned private cart error boundary changed')
            result = result.replace(old_error, '        except Exception as e:\n            if request.context.get(\'pos_rewrite_fresh_customer\') is not None:\n                raise falcon.HTTPServiceUnavailable(\'Fresh POS cart is unavailable.\') from None\n            logger.error', 1)
        tree = ast.parse(result)
        if any(isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='get_exclusive_token' for node in ast.walk(tree)):
            raise RuntimeError('A private-context cached membership call remains')
        after[path] = result
    helper = (ROOT / 'membership_context.py').read_text()
    ast.parse(helper)
    patch = ''.join(''.join(difflib.unified_diff(before[path].splitlines(True),after[path].splitlines(True),fromfile='a/'+path,tofile='b/'+path)) for path in before)
    patch += ''.join(difflib.unified_diff([],helper.splitlines(True),fromfile='/dev/null',tofile='b/middleware/PosMembershipContext.py'))
    manifest = {'contract':CONTRACT,'enabled':False,'sourceCommit':COMMIT,'sourceSha256':{path:hashlib.sha256(source.encode()).hexdigest() for path,source in originals.items()},'requiredCustomerContext':'pos-customer-context-v1','beforeSha256':{path:hashlib.sha256(source.encode()).hexdigest() for path,source in before.items()},'candidateSha256':{path:hashlib.sha256(source.encode()).hexdigest() for path,source in after.items()},'helperSha256':hashlib.sha256(helper.encode()).hexdigest(),'patch':'api-v2-membership-reader.patch','patchSha256':hashlib.sha256(patch.encode()).hexdigest()}
    outputs={ROOT/manifest['patch']:patch,ROOT/'membership-reader-manifest.json':json.dumps(manifest,indent=2)+'\n'}
    for path,content in outputs.items():
        if write:path.write_text(content)
        elif not path.exists() or path.read_text()!=content:raise RuntimeError('Saved membership reader differs from pinned reviewed inputs')
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');options=parser.parse_args()
    print(json.dumps(build(options.write)))
