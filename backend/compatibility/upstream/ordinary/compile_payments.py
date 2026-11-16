"""Compile both payments patches in a disposable archive; never start upstream."""
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from prepare_patches import TARGETS

repository,commit=TARGETS['payments']
if subprocess.check_output(['git','rev-parse','HEAD'],cwd=repository,text=True).strip()!=commit:
    raise RuntimeError('Payments source is not at the reviewed revision')
with tempfile.TemporaryDirectory(prefix='pos-ordinary-payments-')as temporary:
    archive=subprocess.check_output(['git','archive',commit],cwd=repository)
    with tarfile.open(fileobj=io.BytesIO(archive))as source:
        destination=Path(temporary).resolve();members=source.getmembers()
        for member in members:
            target=(destination/member.name).resolve()
            if destination not in target.parents or not(member.isfile()or member.isdir()):
                raise RuntimeError('Unexpected pinned archive member')
            member.mode&=0o777
        source.extractall(temporary,members=members)
    for name in ['payments-pos-exchange.patch','payments-pos-checkout.patch']:
        patch=ROOT/'patches'/name
        subprocess.run(['git','apply','--check',str(patch)],cwd=temporary,check=True)
        subprocess.run(['git','apply',str(patch)],cwd=temporary,check=True)
    subprocess.run(['docker','run','--rm','-v',temporary+':/work','-w','/work','golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d','go','build','.','./juspay','./cmd/pos-checkout-effects'],check=True)
