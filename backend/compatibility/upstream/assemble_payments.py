"""Assemble deployable payments source in a new owned directory.

No original checkout edits, service startup, dependency installation, test,
application compilation, schema change or deployment occurs. The only Go
execution is the owned standard-library AST source producer.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
PAYMENTS_COMMIT = '434f3e438d1cb48c64e5723222c6efda506db571'
CONTRACT = 'pos-composed-payments-source-v1'


def fail():
    raise RuntimeError('PAYMENTS_SOURCE_ASSEMBLY_UNAVAILABLE') from None


def run(arguments, cwd):
    # An output nested under a different Git repository must not cause apply
    # to silently skip paths or inherit another checkout's Git environment.
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith('GIT_')}
    environment.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                        'GIT_CEILING_DIRECTORIES': str(Path(cwd).parent)})
    return subprocess.run(arguments, cwd=cwd, check=True, capture_output=True,
                          env=environment, timeout=120).stdout


def document(path):
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        fail()
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def patch_inputs():
    exchange = document(ROOT / 'manifest.json')
    ordinary = document(ROOT / 'ordinary-manifest.json')
    imports = document(ROOT / 'legacy-order-imports/manifest.json')
    if (exchange.get('sources', {}).get('payments', {}).get('commit') != PAYMENTS_COMMIT
            or ordinary.get('sourceCommit') != PAYMENTS_COMMIT
            or imports.get('paymentsCommit') != PAYMENTS_COMMIT):
        fail()
    inputs = [
        ('patches/payments-pos-exchange.patch', exchange['patches']['payments-pos-exchange.patch']),
        ('patches/payments-pos-checkout.patch', ordinary['sha256']),
        ('legacy-order-imports/payments-import-overlay.patch', imports['patchSha256']),
    ]
    result = []
    for relative, expected in inputs:
        path = ROOT / relative
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
            fail()
        if digest(path.read_bytes()) != expected:
            fail()
        result.append((relative, path, expected))
    return result


def assemble_payments(reference, output, generate=None):
    """Produce a review/build input, never a parity or release certificate.

    Optional generate(args)->bytes supports a caller-owned network-disabled
    Go producer runner; upstream application packages are never executed.
    """
    reference = Path(reference).resolve(strict=True)
    requested = Path(output).absolute()
    parent = requested.parent.resolve(strict=True)
    target = parent / requested.name
    # Exclusive creation prevents replacing an existing checkout or result.
    if (requested.name in ('', '.', '..') or target.exists() or target.is_symlink()
            or reference == target or reference in target.parents or target in reference.parents):
        fail()
    head = run(['git', 'rev-parse', 'HEAD'], reference).decode().strip()
    if head != PAYMENTS_COMMIT:
        fail()
    inputs = patch_inputs()
    composer_path = ROOT / 'other-writer-origins/go/compose.py'
    if not composer_path.is_file():
        fail()
    spec = importlib.util.spec_from_file_location('pos_other_origin_payments_composer', composer_path)
    if spec is None or spec.loader is None:
        fail()
    composer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(composer)
    # Generate into a sibling temporary tree; failures leave no partial output.
    with tempfile.TemporaryDirectory(prefix='.pos-payments-assembly-', dir=parent) as temporary:
        staging = Path(temporary)
        tree = staging / 'source'
        tree.mkdir(mode=0o700)
        archive = staging / 'source.tar'
        run(['git', 'archive', '--format=tar', '--output=' + str(archive), PAYMENTS_COMMIT], reference)
        if archive.stat().st_size > 256000000:
            fail()
        with tarfile.open(archive) as source:
            members = source.getmembers()
            if len(members) > 100000 or sum(member.size for member in members) > 256000000:
                fail()
            for member in members:
                path = (tree / member.name).resolve()
                if tree not in path.parents or not (member.isfile() or member.isdir()):
                    fail()
                member.mode &= 0o777
            source.extractall(tree, members=members)
        for _relative, patch, _expected in inputs:
            run(['git', 'apply', str(patch)], tree)

        if generate is None:
            environment = {**os.environ, 'GOTOOLCHAIN': 'local', 'GOPROXY': 'off', 'GOSUMDB': 'off'}

            def generate(arguments):
                return subprocess.run([os.environ.get('POS_GO_BINARY', 'go'), 'run', *arguments],
                                      cwd=tree, env=environment, check=True, capture_output=True,
                                      timeout=120).stdout

        origins = composer.compose_payments(tree, reference, generate)
        files = {}
        for path in sorted(tree.rglob('*')):
            if path.is_symlink():
                fail()
            if path.is_file():
                files[str(path.relative_to(tree))] = digest(path.read_bytes())
        manifest = {
            'contract': CONTRACT, 'sourceCommit': PAYMENTS_COMMIT,
            'validation': 'pending-final-validation', 'selectedByDefault': False,
            'patches': {relative: expected for relative, _path, expected in inputs},
            'originComposerSha256': digest(composer_path.read_bytes()),
            'origins': origins, 'files': files,
        }
        (tree / 'pos-composed-payments-manifest.json').write_text(
            json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        # Recheck before publishing. rename refuses occupied nonempty directories.
        if target.exists() or target.is_symlink():
            fail()
        tree.rename(target)
        return manifest


def main():
    request_id = str(uuid4())

    class Arguments(argparse.ArgumentParser):
        def error(self, _message):
            fail()

    def event(action, **fields):
        return {'module': 'source-assembly', 'resource': 'payments',
                'eventId': 'source-assembly.payments.' + action,
                'eventInstanceId': str(uuid4()), 'requestId': request_id,
                'userId': None, 'timestamp': datetime.now(timezone.utc).isoformat(), **fields}

    try:
        parser = Arguments(description=__doc__)
        parser.add_argument('--source-root', required=True)
        parser.add_argument('--output', required=True)
        args = parser.parse_args()
        result = assemble_payments(args.source_root, args.output)
        print(json.dumps(event('completed', contract=CONTRACT, sourceCommit=PAYMENTS_COMMIT,
                               validation=result['validation'], files=len(result['files']))))
    except Exception:
        # Compiler/parser/driver diagnostics can contain source values or paths.
        print(json.dumps(event('failed', errorCode='PAYMENTS_SOURCE_ASSEMBLY_UNAVAILABLE')),
              file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
