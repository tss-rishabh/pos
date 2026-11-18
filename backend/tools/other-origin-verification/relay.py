"""Loopback-only MySQL fixture transport over an owned Docker exec.

The database protocol is streamed unchanged and never inspected or logged.
This is a fixture seam, not a general TCP half-close or latency qualification.
"""
from __future__ import annotations

import json
import os
import re
import select
import signal
import socket
import subprocess
import threading
import time

LABEL = 'pos-rewrite.other-origin-verification'
COMMAND = r'''printf '%s\n' "$$" >&2
exec 3<>/dev/tcp/127.0.0.1/3306 || exit 1
origin_relay_reader=
origin_relay_writer=
trap 'test -z "$origin_relay_reader" || kill "$origin_relay_reader" 2>/dev/null; test -z "$origin_relay_writer" || kill "$origin_relay_writer" 2>/dev/null; exit 0' TERM HUP INT
# Explicit stdin redirection prevents bash from attaching /dev/null to this
# asynchronous writer. The shell waits for the server reader, so server EOF
# closes stdout even when the client waits for EOF before closing its input.
cat <&0 >&3 &
origin_relay_writer=$!
cat <&3 &
origin_relay_reader=$!
wait "$origin_relay_reader"
kill "$origin_relay_writer" 2>/dev/null || true
wait "$origin_relay_writer" 2>/dev/null || true
'''


class MySQLExecRelay:
    """Bound 32 concurrent local connections to one nonce-owned container."""

    def __init__(self, docker, container, nonce):
        if not re.fullmatch(r'[0-9a-f]{64}', container):
            raise RuntimeError('RELAY_OWNED_CONTAINER_ID_REQUIRED')
        data = json.loads(subprocess.check_output(
            [docker, 'inspect', container], stderr=subprocess.DEVNULL))[0]
        if data['Config']['Labels'].get(LABEL) != nonce:
            raise RuntimeError('RELAY_CONTAINER_OWNER_MISMATCH')
        self.docker = docker
        self.container = container
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.slots = threading.BoundedSemaphore(32)
        self.peers = set()
        self.processes = set()
        self.threads = []
        self.accepted = 0
        self.rejected = 0
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(32)
        self.listener.settimeout(0.1)
        self.port = self.listener.getsockname()[1]
        self.acceptor = threading.Thread(target=self._accept, daemon=True)
        self.acceptor.start()

    def _accept(self):
        while not self.closed.is_set():
            try:
                peer, _address = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not self.slots.acquire(blocking=False):
                peer.close()
                self.rejected += 1
                continue
            with self.lock:
                self.peers.add(peer)
                self.accepted += 1
            thread = threading.Thread(target=self._stream, args=(peer,), daemon=True)
            self.threads.append(thread)
            thread.start()

    def _stop_exec(self, process, shell_pid):
        # Only a validated PID emitted by this exact fixed-command Docker exec
        # is accepted. No client bytes become a command or an argument.
        if shell_pid and process.poll() is None:
            try:
                subprocess.run([self.docker, 'exec', self.container, '/bin/kill',
                                '-TERM', shell_pid], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=0.5, check=False)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=0.25)

    def _stream(self, peer):
        process = None
        shell_pid = None
        try:
            process = subprocess.Popen([self.docker, 'exec', '-i', self.container,
                                        '/bin/bash', '-c', COMMAND], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True, bufsize=0)
            with self.lock:
                self.processes.add(process)
            # The fixed command emits just its shell PID on stderr before the
            # database handshake; never copy stderr into public diagnostics.
            ready, _, _ = select.select([process.stderr], [], [], 5)
            if not ready:
                return
            identity = os.read(process.stderr.fileno(), 64).strip()
            if not re.fullmatch(rb'[1-9][0-9]{0,9}', identity):
                return
            shell_pid = identity.decode('ascii')
            peer.setblocking(False)
            os.set_blocking(process.stdin.fileno(), False)
            os.set_blocking(process.stdout.fileno(), False)
            upload = bytearray()
            download = bytearray()
            client_eof = False
            server_eof = False
            input_closed = False
            output_closed = False
            while not self.closed.is_set():
                readers = []
                writers = []
                if not client_eof and len(upload) < 1024 * 1024:
                    readers.append(peer)
                if not server_eof and len(download) < 1024 * 1024:
                    readers.append(process.stdout)
                if upload and not input_closed:
                    writers.append(process.stdin)
                if download:
                    writers.append(peer)
                ready_read, ready_write, _ = select.select(readers, writers, [], 0.1)
                for channel in ready_read:
                    if channel is peer:
                        chunk = peer.recv(65536)
                        if chunk:
                            upload.extend(chunk)
                        else:
                            client_eof = True
                    else:
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if chunk:
                            download.extend(chunk)
                        else:
                            server_eof = True
                for channel in ready_write:
                    if channel is peer:
                        written = peer.send(download)
                        del download[:written]
                    else:
                        written = os.write(process.stdin.fileno(), upload)
                        del upload[:written]
                if client_eof and not upload and not input_closed:
                    process.stdin.close()
                    input_closed = True
                if server_eof and not download and not output_closed:
                    peer.shutdown(socket.SHUT_WR)
                    output_closed = True
                if input_closed and output_closed:
                    break
        except (OSError, ValueError, subprocess.SubprocessError):
            # Fixed boolean/count diagnostics only; no database protocol bytes,
            # SQL, raw errors, customer fields, or credential values are logged.
            pass
        finally:
            peer.close()
            if process is not None:
                if process.stdin is not None and not process.stdin.closed:
                    process.stdin.close()
                self._stop_exec(process, shell_pid)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
                with self.lock:
                    self.processes.discard(process)
            with self.lock:
                self.peers.discard(peer)
            self.slots.release()

    def close(self):
        self.closed.set()
        self.listener.close()
        with self.lock:
            peers = list(self.peers)
        for peer in peers:
            try:
                peer.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            peer.close()
        deadline = time.monotonic() + 1.5
        self.acceptor.join(timeout=0.2)
        for thread in self.threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        with self.lock:
            processes = list(self.processes)
        for process in processes:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for thread in self.threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        with self.lock:
            clients_stopped = not self.processes
        return {'transport': 'loopback-docker-exec-mysql', 'accepted': self.accepted,
                'rejected': self.rejected,
                'listenerClosed': self.listener.fileno() == -1,
                'allThreadsStopped': not any(thread.is_alive() for thread in self.threads),
                'allExecClientsStopped': clients_stopped}
