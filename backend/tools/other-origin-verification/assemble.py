"""Owned orchestration of existing bounded Go origin verification runners.

No source checkout, shared module cache, shared build cache, or live service is
written. Raw runner diagnostics stay in the private invocation directory.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]
UPSTREAM = BACKEND / 'compatibility/upstream'
ORIGINS = UPSTREAM / 'other-writer-origins/go'
PIN = '434f3e438d1cb48c64e5723222c6efda506db571'
GO = 'golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d'
MYSQL = 'mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902'
LABEL = 'pos-rewrite.other-origin-verification'


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def capture(arguments, **options):
    return subprocess.check_output(arguments, stderr=subprocess.DEVNULL, **options)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    path.chmod(0o600)


def source_state(source):
    require(capture(['git', '-C', str(source), 'rev-parse', 'HEAD']).decode().strip() == PIN,
            'PINNED_PAYMENTS_SOURCE_REQUIRED')
    require(not capture(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no']),
            'CLEAN_PAYMENTS_SOURCE_REQUIRED')
    names = capture(['git', '-C', str(source), 'ls-files', '-z']).decode().split('\0')
    return {name: digest(source / name) for name in names if name}


def producer_state():
    # Include all producer/fixture/installer inputs, not just the AST producer.
    roots = [UPSTREAM, BACKEND / 'tests/native-head-metadata',
             BACKEND / 'src', BACKEND / 'migrations', HERE]
    names = capture(['git', '-C', str(BACKEND.parent), 'ls-files', '-z']).decode().split('\0')
    selected = {name: digest(BACKEND.parent / name) for name in names if name and
                any((BACKEND.parent / name).is_relative_to(root) for root in roots)}
    # Include this wrapper while authoring, before its new files are tracked.
    for path in HERE.iterdir():
        if path.is_file() and not path.is_symlink():
            selected[str(path.relative_to(BACKEND.parent))] = digest(path)
    for name in ('package.json', 'package-lock.json', 'tsconfig.json'):
        selected['backend/' + name] = digest(BACKEND / name)
    return selected


def preflight():
    paths = []
    for name in ('POS_ORIGIN_PAYMENTS_SOURCE_ROOT', 'POS_ORIGIN_GO_MODULE_CACHE_SOURCE'):
        raw = os.environ.get(name, '')
        require(bool(raw) and Path(raw).is_absolute(), name + '_REQUIRED')
        requested = Path(raw)
        require(requested.exists(), name + '_UNAVAILABLE')
        require(not requested.is_symlink(), name + '_MUST_NOT_BE_SYMLINK')
        path = requested.resolve(strict=True)
        require(path.is_dir(), name + '_MUST_BE_DIRECTORY')
        paths.append(path)
    source, modules = paths
    require(modules.stat().st_uid == os.getuid(), 'CALLER_OWNED_MODULE_CACHE_REQUIRED')
    require((modules / 'cache/download').is_dir(), 'COMPLETE_OFFLINE_MODULE_CACHE_REQUIRED')
    require(source != modules and source not in modules.parents and modules not in source.parents,
            'INDEPENDENT_SOURCE_AND_MODULE_CACHE_REQUIRED')
    require(not any(path.is_symlink() for path in modules.rglob('*')),
            'MODULE_CACHE_SYMLINK_NOT_ALLOWED')
    docker = shutil.which('docker')
    require(bool(docker), 'DOCKER_EXECUTABLE_REQUIRED')
    for image in (GO, MYSQL):
        try:
            capture([docker, 'image', 'inspect', image])
        except subprocess.CalledProcessError:
            raise RuntimeError('CACHED_PINNED_GO_IMAGE_REQUIRED' if image == GO else
                               'CACHED_PINNED_MYSQL_IMAGE_REQUIRED') from None
    require(shutil.which('node') is not None and
            capture(['node', '-p', 'process.versions.node']).decode().strip().split('.')[0] == '24',
            'NODE_24_REQUIRED')
    for path in ('node_modules/tsx/dist/loader.mjs', 'node_modules/mysql2/package.json'):
        require((BACKEND / path).is_file(), 'EXISTING_PRIVATE_BACKEND_DEPENDENCIES_REQUIRED')
    return source, modules, docker, source_state(source), producer_state()


def docker_proxy():
    """Label and journal runner resources; never accept another image or pull.

    The unchanged runners call this executable through their private PATH.
    Removal records anonymous volumes before an existing runner removes a MySQL
    container. Final cleanup independently verifies ownership and absence.
    """
    real = os.environ['ORIGIN_REAL_DOCKER']
    nonce = os.environ['ORIGIN_OWNER_NONCE']
    ledger = Path(os.environ['ORIGIN_RESOURCE_LEDGER'])
    args = sys.argv[2:]
    require(bool(args), 'DOCKER_COMMAND_REQUIRED')

    def journal(kind, identifier):
        if not re.fullmatch(r'[0-9a-f]{64}', identifier):
            return
        data = json.loads(capture([real, 'inspect', identifier]))[0]
        require(data.get('Config', {}).get('Labels', {}).get(LABEL) == nonce,
                'REFUSE_UNOWNED_CONTAINER')
        entry = {'kind': kind, 'id': identifier, 'volumes': [mount['Name'] for mount in
                 data.get('Mounts', []) if mount.get('Type') == 'volume']}
        with ledger.open('a') as output:
            output.write(json.dumps(entry) + '\n')

    if args[0] in ('run', 'create'):
        require(GO in args or MYSQL in args, 'UNPINNED_CONTAINER_IMAGE_REFUSED')
        args[1:1] = ['--label', LABEL + '=' + nonce]
        if not any(value == '--pull' or value.startswith('--pull=') for value in args):
            args.insert(1, '--pull=never')
        # All old runners inherit these offline toolchain controls, even those
        # that predate explicit GOTOOLCHAIN/GOSUMDB settings.
        if GO in args:
            args[1:1] = ['-e', 'GOTOOLCHAIN=local', '-e', 'GOPROXY=off',
                         '-e', 'GOSUMDB=off', '-e', 'GOWORK=off']
            if os.environ.get('ORIGIN_HEAD_RUNTIME') == '1':
                args[1:1] = ['-e', 'ENV=POS_ORIGIN_HEAD_FIXTURE',
                             '-e', 'DB=root@tcp(mysql:3306)/native_head_go_validation?parseTime=true']
        if args[0] == 'create' or '-d' in args or '--detach' in args:
            output = subprocess.check_output([real, *args])
            journal('container', output.decode().strip())
            sys.stdout.buffer.write(output)
            return
    elif args[:2] == ['network', 'create']:
        args[2:2] = ['--label', LABEL + '=' + nonce]
        if '--internal' not in args:
            args.insert(2, '--internal')
        output = subprocess.check_output([real, *args])
        identifier = output.decode().strip()
        with ledger.open('a') as stream:
            stream.write(json.dumps({'kind': 'network', 'id': identifier}) + '\n')
        sys.stdout.buffer.write(output)
        return
    elif args[0] == 'rm':
        for name in args[1:]:
            if not name.startswith('-'):
                try:
                    identifier = capture([real, 'inspect', '--format', '{{.Id}}', name]).decode().strip()
                except subprocess.CalledProcessError:
                    continue
                journal('container', identifier)
        if not any(value in ('-v', '--volumes') or value.startswith('-') and 'v' in value[1:]
                   for value in args[1:]):
            args.insert(1, '--volumes')
    result = subprocess.run([real, *args], check=False)
    sys.exit(result.returncode)


def cleanup(docker, nonce, ledger):
    records = [json.loads(line) for line in ledger.read_text().splitlines()] if ledger.exists() else []
    containers = capture([docker, 'ps', '-aq', '--no-trunc', '--filter', 'label=' + LABEL + '=' + nonce]).decode().split()
    volumes = {volume for row in records for volume in row.get('volumes', [])}
    for identifier in containers:
        data = json.loads(capture([docker, 'inspect', identifier]))[0]
        require(data['Config']['Labels'].get(LABEL) == nonce, 'CLEANUP_OWNER_MISMATCH')
        volumes.update(mount['Name'] for mount in data.get('Mounts', []) if mount.get('Type') == 'volume')
        records.append({'kind': 'container', 'id': identifier})
        subprocess.run([docker, 'rm', '-fv', identifier], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    networks = capture([docker, 'network', 'ls', '-q', '--no-trunc', '--filter', 'label=' + LABEL + '=' + nonce]).decode().split()
    for identifier in networks:
        data = json.loads(capture([docker, 'network', 'inspect', identifier]))[0]
        require(data['Labels'].get(LABEL) == nonce, 'CLEANUP_NETWORK_OWNER_MISMATCH')
        records.append({'kind': 'network', 'id': identifier})
        subprocess.run([docker, 'network', 'rm', identifier], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Volume names come only from inspected nonce-owned containers. Do not
    # enumerate or remove unrelated dangling volumes from the host.
    for name in volumes:
        if subprocess.run([docker, 'volume', 'inspect', name], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0:
            subprocess.run([docker, 'volume', 'rm', name], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for record in records:
        command = [docker, 'network', 'inspect'] if record['kind'] == 'network' else [docker, 'inspect']
        require(subprocess.run([*command, record['id']], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL).returncode != 0, 'OWNED_RESOURCE_REMAINS')
    for name in volumes:
        require(subprocess.run([docker, 'volume', 'inspect', name], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL).returncode != 0, 'OWNED_VOLUME_REMAINS')
    return {'resources': records, 'volumes': sorted(volumes), 'allAbsent': True}


def run_phase(phase, source, modules_source, docker, before_source, before_producer):
    # macOS /tmp resolves to /private/tmp. Compare canonical owned roots with
    # the canonical AST argument paths without widening the ancestry guard.
    work = Path(tempfile.mkdtemp(prefix='pos-origin-verification.')).resolve()
    work.chmod(0o700)
    nonce = work.name.split('.')[-1]
    ledger = work / 'resources.jsonl'
    environment = {name: os.environ[name] for name in ('PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT') if name in os.environ}
    environment.update({'TZ': 'UTC', 'NODE_ENV': 'test', 'PYTHONDONTWRITEBYTECODE': '1',
                        'ORIGIN_REAL_DOCKER': docker, 'ORIGIN_OWNER_NONCE': nonce,
                        'ORIGIN_RESOURCE_LEDGER': str(ledger), 'TMPDIR': str(work)})
    binary = work / 'bin'
    binary.mkdir()
    proxy = binary / 'docker'
    proxy.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' -B ' +
                     shlex.quote(str(HERE / 'assemble.py')) + ' --docker-proxy "$@"\n')
    proxy.chmod(0o700)
    environment['PATH'] = str(binary) + os.pathsep + environment.get('PATH', '')
    log = work / 'runner.log'
    result = {'phase': phase, 'completed': False, 'sourcePin': PIN,
              'scope': 'Bounded native origin verification; not complete public HTTP parity'}
    active = None

    def invoke(command, output):
        nonlocal active

        def bound_log():
            # Do not silently truncate a successful run. Exceeding this private
            # output bound terminates the writer and fails the native phase.
            resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))

        active = subprocess.Popen(command, cwd=BACKEND, env=environment, stdout=output,
                                  stderr=subprocess.STDOUT, start_new_session=True,
                                  preexec_fn=bound_log)
        status = active.wait()
        active = None
        require(status == 0, 'ORIGIN_' + phase.upper() + '_RUNNER_FAILED')

    def interrupt(_signum, _frame):
        if active is not None:
            try:
                os.killpg(active.pid, signal.SIGTERM)
                # Leave time for nonce-owned Docker cleanup within the parent
                # verifier's five-second termination grace.
                active.wait(timeout=2)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if active.poll() is None:
                    os.killpg(active.pid, signal.SIGKILL)
                    active.wait()
        raise RuntimeError('ORIGIN_VERIFICATION_INTERRUPTED')

    handlers = {number: signal.signal(number, interrupt) for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        write_json(work / 'before.json', {'source': before_source, 'producer': before_producer})
        modules = work / 'modules'
        shutil.copytree(modules_source, modules)
        producer_cache = work / 'producer-cache'
        producer_cache.mkdir(mode=0o700)
        assembly = work / 'assembly'
        spec = importlib.util.spec_from_file_location('origin_owned_assembler', UPSTREAM / 'assemble_payments.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def generate(arguments):
            # The assembler's callback supplies absolute AST/input/output paths.
            # Mount only each known source root and its owned staging parent.
            roots = [(UPSTREAM, '/contract'), (source, '/reference'), (work, '/owned')]
            mapped = []
            for value in arguments:
                if value.startswith('/'):
                    path = Path(value).resolve()
                    matches = [(root, mount) for root, mount in roots if path.is_relative_to(root)]
                    require(bool(matches), 'PRODUCER_PATH_OUTSIDE_OWNED_ROOTS')
                    root, mount = matches[0]
                    mapped.append(mount + '/' + str(path.relative_to(root)))
                else:
                    mapped.append(value)
            command = [str(proxy), 'run', '--rm', '--network', 'none', '--read-only',
                       '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m']
            for root, mount in roots:
                command += ['-v', str(root) + ':' + mount + ':ro']
            command += ['-v', str(producer_cache) + ':/cache', '-e', 'GOCACHE=/cache',
                        '-e', 'GO111MODULE=off', '-w', '/tmp', GO, 'go', 'run', *mapped]
            with (work / 'producer.log').open('ab') as errors:
                return subprocess.check_output(command, env=environment, stderr=errors, timeout=120)

        manifest = module.assemble_payments(source, assembly, generate=generate)
        write_json(work / 'assembly-manifest.json', manifest)
        build = work / 'build-cache'
        if phase == 'calendar':
            environment['POS_EXPIRY_NATIVE_SLOT_RELEASED'] = 'yes'
            command = ['sh', str(ORIGINS / 'expiry-review/run-active-calendar.sh'), str(assembly),
                       str(modules), str(build), str(source), str(work / 'calendar-evidence')]
        elif phase == 'general':
            build.mkdir(mode=0o700)
            command = ['sh', str(ORIGINS / 'run-native-tests.sh'), str(assembly), str(modules), str(build)]
        else:
            build.mkdir(mode=0o700)
            # The head runner does not provide the general/calendar loader
            # replacement. Compile/vet the immutable assembly before creating a
            # separate runtime copy with a strict fixture-only loader. Only that
            # copy reaches package startup, on an internal network.
            with (work / 'original-build-vet.log').open('wb') as output:
                for action in ('build', 'vet'):
                    invoke([str(proxy), 'run', '--rm', '--network', 'none',
                            '-v', str(assembly) + ':/source:ro',
                            '-v', str(modules) + ':/module-cache:ro',
                            '-v', str(build) + ':/build-cache', '-w', '/source',
                            '-e', 'GOMODCACHE=/module-cache', '-e', 'GOCACHE=/build-cache',
                            GO, 'go', action, '-mod=readonly', './internal/poscheckout', './juspay'], output)
            runtime = work / 'head-runtime'
            shutil.copytree(assembly, runtime)
            loader = runtime / 'config/env.go'
            original_loader_hash = digest(loader)
            loader.write_text('package config\nimport "os"\nfunc InitEnv(){' +
                              'if os.Getenv("ENV")!="POS_ORIGIN_HEAD_FIXTURE"||' +
                              'os.Getenv("DB")!="root@tcp(mysql:3306)/native_head_go_validation?parseTime=true"' +
                              '{panic("refusing non-isolated origin head fixture startup")}}\n')
            result['excludedBootstrapBoundary'] = {
                'path': 'config/env.go', 'originalSha256': original_loader_hash,
                'runtimeSha256': digest(loader), 'scope': 'fixture loader only; original startup not exercised'}
            network = 'pos-origin-verifier-' + nonce.lower()
            capture([str(proxy), 'network', 'create', network], env=environment)
            identifier = capture([str(proxy), 'run', '-d', '--name', network, '--network', network,
                                  '--network-alias', 'mysql', '-p', '127.0.0.1::3306',
                                  '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-e', 'MYSQL_ROOT_HOST=%',
                                  '-e', 'MYSQL_DATABASE=pos_rewrite_checkout_test', MYSQL], env=environment).decode().strip()
            for attempt in range(60):
                probe = subprocess.run([docker, 'exec', identifier, 'mysql', '--protocol=TCP',
                                        '-h127.0.0.1', '-uroot', '-e', 'SELECT 1'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if probe.returncode == 0:
                    break
                require(attempt < 59, 'OWNED_MYSQL_NOT_READY')
                time.sleep(1)
            port = capture([docker, 'port', identifier, '3306/tcp']).decode().strip().split(':')[-1]
            environment.update({'CHECKOUT_MYSQL_TEST_URL': 'mysql://root@127.0.0.1:' + port + '/pos_rewrite_checkout_test',
                                'POS_ORIGIN_HEAD_DOCKER_NETWORK': network,
                                'ENV': 'POS_ORIGIN_HEAD_FIXTURE',
                                'DB': 'root@tcp(mysql:3306)/native_head_go_validation?parseTime=true'})
            # The runner's Go container environment is explicit, so forward
            # these two fixture-only settings through the owned Docker proxy.
            environment['ORIGIN_HEAD_RUNTIME'] = '1'
            command = ['node', '--import', 'tsx', str(ORIGINS / 'run-head-native-tests.mjs'),
                       str(BACKEND), str(runtime), str(modules), str(build)]
        with log.open('wb') as output:
            invoke(command, output)
        require(source_state(source) == before_source, 'SOURCE_CHANGED_DURING_VERIFICATION')
        require(producer_state() == before_producer, 'PRODUCER_CHANGED_DURING_VERIFICATION')
        require(json.loads((assembly / 'pos-composed-payments-manifest.json').read_text()) == manifest,
                'ASSEMBLY_MANIFEST_CHANGED')
        require(all(digest(assembly / name) == expected for name, expected in manifest['files'].items()),
                'ASSEMBLY_CHANGED_DURING_VERIFICATION')
        if phase in ('general', 'head'):
            text = log.read_text()
            expected = ('TestOriginNativeHeadFreshAuthorityAndActualIsolation',
                        'TestOriginNativeHeadCapacityReaderBoundaries',
                        'TestOriginNativeHeadCapacityActualCaller',
                        'TestOriginNativeFirstStartHasDurableCheckpointAndBaselineFence') if phase == 'head' else (
                            'TestOriginNativeTerminalReadAndStartGuard', 'TestOriginNativeRecoveryUseAndLostACK',
                            'TestOriginNativeEffectReadNeverRedispatches', 'TestOriginNativeFundingSeparatesCashFromBank',
                            'TestOriginNativeCSKFundingRetainsOriginalDeclarationAfterRotation', 'TestOriginProofKeyBounds',
                            'TestOriginGatewayLostOrderACKRecoversOnlyGET', 'TestOriginGatewayDirectRecoveryCannotCreateCustomer')
            for name in expected:
                require(bool(re.search(r'(?m)^--- PASS: ' + name + r' \(', text)),
                        'REQUIRED_NATIVE_CASE_NOT_PASSED')
            if phase == 'head':
                require('--- SKIP:' not in text, 'REQUIRED_HEAD_CASE_SKIPPED')
                changed = [name for name, expected_hash in manifest['files'].items()
                           if digest(runtime / name) != expected_hash]
                require(changed == ['config/env.go'] and
                        digest(runtime / 'config/env.go') == result['excludedBootstrapBoundary']['runtimeSha256'],
                        'HEAD_RUNTIME_EXCLUSION_CHANGED')
            result['requiredPassedCases'] = list(expected)
        result['completed'] = True
    except Exception as error:
        result['failure'] = str(error) if isinstance(error, RuntimeError) else 'ORIGIN_PHASE_SETUP_OR_EXECUTION_FAILED'
    finally:
        try:
            after = {'source': source_state(source), 'producer': producer_state()}
            write_json(work / 'after.json', after)
            require(after == {'source': before_source, 'producer': before_producer},
                    'VERIFICATION_INPUT_CHANGED')
            result['inputsUnchanged'] = True
        except Exception:
            result['completed'] = False
            result['inputsUnchanged'] = False
            result['failure'] = 'VERIFICATION_INPUT_CHANGED_OR_UNAVAILABLE'
        try:
            result['cleanup'] = cleanup(docker, nonce, ledger)
        except Exception:
            result['completed'] = False
            result['cleanup'] = {'allAbsent': False}
            result['failure'] = 'OWNED_RESOURCE_CLEANUP_FAILED'
        for number, handler in handlers.items():
            signal.signal(number, handler)
        result['runnerLogSha256'] = digest(log) if log.exists() else None
        result['originalBuildVetLogSha256'] = digest(work / 'original-build-vet.log') if (work / 'original-build-vet.log').exists() else None
        result['assemblyManifestSha256'] = digest(work / 'assembly-manifest.json') if (work / 'assembly-manifest.json').exists() else None
        write_json(work / 'result.json', result)
        # Source/caches/logs stay private for review. No raw diagnostics escape.
        print(json.dumps({'module': 'verification', 'resource': 'other-origin-' + phase,
                          'eventId': 'verification.other-origin.' + phase + '.completed',
                          'eventInstanceId': str(uuid.uuid4()), 'requestId': None, 'userId': None,
                          'completed': result['completed'], 'evidenceDirectory': str(work),
                          'failure': result.get('failure')}), flush=True)
    return result['completed']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('preflight', 'general', 'head', 'calendar'))
    arguments = parser.parse_args()
    os.umask(0o077)
    source, modules, docker, source_hashes, producer_hashes = preflight()
    if arguments.phase == 'preflight':
        print(json.dumps({'module': 'verification', 'resource': 'other-origin-preflight',
                          'eventId': 'verification.other-origin.preflight.completed',
                          'eventInstanceId': str(uuid.uuid4()), 'requestId': None, 'userId': None,
                          'valid': True, 'sourcePin': PIN}))
        return 0
    return 0 if run_phase(arguments.phase, source, modules, docker, source_hashes, producer_hashes) else 1


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--docker-proxy':
        docker_proxy()
    else:
        try:
            sys.exit(main())
        except Exception as error:
            code = str(error) if isinstance(error, RuntimeError) else 'ORIGIN_VERIFICATION_PREFLIGHT_FAILED'
            print(json.dumps({'module': 'verification', 'resource': 'other-origin-preflight',
                              'eventId': 'verification.other-origin.preflight.failed',
                              'eventInstanceId': str(uuid.uuid4()), 'requestId': None, 'userId': None,
                              'failure': code}), file=sys.stderr)
            sys.exit(1)
