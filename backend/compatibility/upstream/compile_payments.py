"""Compile the patched payments package in a disposable archive, never in source."""
import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prepare_pos_compatibility',ROOT/'prepare_patches.py')
prepare=importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
prepare.build()
repository,commit=prepare.TARGETS['payments']
with tempfile.TemporaryDirectory(prefix='pos-payments-compatibility-') as temporary:
    archive=subprocess.check_output(['git','archive',commit],cwd=repository)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        destination=Path(temporary).resolve()
        members=source.getmembers()
        for member in members:
            target=(destination/member.name).resolve()
            if destination not in target.parents or not(member.isfile() or member.isdir()):raise RuntimeError('Unexpected archive member in pinned source')
            member.mode &= 0o777
        source.extractall(temporary,members=members)
    patch=ROOT/'patches/payments-pos-exchange.patch'
    subprocess.run(['git','apply','--check',str(patch)],cwd=temporary,check=True)
    subprocess.run(['git','apply',str(patch)],cwd=temporary,check=True)
    subprocess.run(['docker','run','--rm','-v',temporary+':/work','-w','/work','golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d','go','build','./juspay'],check=True)
