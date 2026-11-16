"""Extract reviewed original allocation statements without starting upstream.

By default compare the saved outputs only. --write is an explicit artifact edit.
"""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from prepare_patches import original
from ordinary.prepare_patch import private_auth_source

IMAGE='golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d'


def outputs():
    source=original('payments','juspay/model.go')
    with tempfile.TemporaryDirectory(prefix='pos-source-allocations-') as temporary:
        (Path(temporary)/'model.go').write_text(source)
        command=['docker','run','--rm','-v',temporary+':/input:ro','-v',str(ROOT)+':/contract:ro','-w','/tmp','-e','GO111MODULE=off',IMAGE,'go','run','/contract/ordinary/transform_source.go','-input','/input/model.go']
        allocation=subprocess.check_output(command,text=True)
        fixture=subprocess.check_output(command+['-models'],text=True)
        oracle=subprocess.check_output(command+['-oracle'],text=True).replace('package juspay','package sourcefixture',1)
    adapter=(ROOT/'payload/juspay/pos_checkout_http.go').read_text().replace('package juspay','package sourcefixture',1)
    if adapter.count('\t"backend-tss-domestic_payments_api/utils"\n')!=1:
        raise RuntimeError('Reviewed HTTP adapter import changed')
    adapter=adapter.replace('\t"backend-tss-domestic_payments_api/utils"\n','').replace('utils.Db','fixtureAdapterDB')
    return {
        ROOT/'payload/juspay/pos_checkout_source.go':allocation,
        ROOT/'go/internal/poscheckout/sourcefixture/source_allocations.go':fixture,
        ROOT/'go/internal/poscheckout/sourcefixture/source_oracle.go':oracle,
        ROOT/'go/internal/poscheckout/sourcefixture/source_records.go':(ROOT/'payload/juspay/pos_checkout_records.go').read_text().replace('package juspay','package sourcefixture',1),
        ROOT/'go/internal/poscheckout/sourcefixture/source_adapter.go':adapter,
        ROOT/'go/internal/poscheckout/sourcefixture/source_auth.go':private_auth_source().replace('package auth','package sourcefixture',1),
        ROOT/'go/internal/poscheckout/sourcefixture/customer_consent_migration.sql':(ROOT.parents[1]/'src/modules/checkout/migrations/0017_customer_consent_proof.sql').read_text(),
        ROOT/'go/internal/poscheckout/sourcefixture/membership_migration.sql':(ROOT.parents[1]/'src/modules/checkout/cancellations/benefit-migration.sql').read_text()+(ROOT.parents[1]/'src/modules/checkout/cancellations/membership-producer-migration.sql').read_text(),
        ROOT/'go/internal/poscheckout/sourcefixture/membership_fence.sql':(ROOT/'pending-cancellation/membership-fence.sql').read_text(),
        ROOT/'ordinary/customer-consent-migration.sql':(ROOT.parents[1]/'src/modules/checkout/migrations/0017_customer_consent_proof.sql').read_text(),
    }


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--write',action='store_true')
    arguments=parser.parse_args()
    for path,content in outputs().items():
        if arguments.write:
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(content)
        elif not path.exists() or path.read_text()!=content:
            raise RuntimeError('The reviewed allocation artifact differs from its pinned source extraction: '+str(path.relative_to(ROOT)))
        print(str(path.relative_to(ROOT))+' '+hashlib.sha256(content.encode()).hexdigest())
