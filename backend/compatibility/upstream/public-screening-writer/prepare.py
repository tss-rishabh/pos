"""Generate the review-only public PosOrder bootstrap/hook composition."""
import argparse
import difflib
import hashlib
import json
import os
import sys
from pathlib import Path

HERE=Path(__file__).resolve().parent
COMMON=HERE.parent/'legacy-order-imports'
sys.path.insert(0,str(COMMON))
from source_runtime import checked_source
SOURCE=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',str(HERE.parents[4]/'backend-tss-api_v2')))


def once(value,old,new):
    if value.count(old)!=1:raise RuntimeError('Pinned public writer composition boundary changed')
    return value.replace(old,new,1)


def outputs():
    original=checked_source(SOURCE,'main.py')
    main=once(original,'from controllers import (','from pos_node_screening import install\n_node_screening = install(__file__)\n\nfrom controllers import (')
    main=once(main,'(db_session, db_session_r) = make_sessions()',
              '(db_session, db_session_r) = _node_screening.routes(*make_sessions())\n_node_screening.activate(vars(OrderController))')
    main=once(main,'middleware = [DatabaseManager(','middleware = [_node_screening, DatabaseManager(')
    main=once(main,"app.add_route(settings.POS_API_PREFIX + '/order', OrderController.PosOrder())",
              "app.add_route(settings.POS_API_PREFIX + '/order', _node_screening.order_resource(OrderController.PosOrder()))")
    controller=checked_source(SOURCE,'controllers/OrderController.py')
    # Preserve the real decorator and every original body statement. Only the
    # PosOrder validation boundary gains the native signed-snapshot hook.
    before,after=controller.split('class PosOrder():',1)
    after=once(after,'        ValidateCheckout().on_post(req, resp)',
               '        ValidateCheckout().on_post(req, resp)\n        from pos_node_screening import after_validate\n        after_validate(req)')
    controller_candidate=before+'class PosOrder():'+after
    sys.path.insert(0,str(HERE.parent/'offline-cash-pricing'))
    from source_refunds import refund_tree
    refund_tree(SOURCE,'pos-refund-per-hp-v1')
    # Compose the actual approved two UPDATE predicates without reserializing
    # the original controller or changing any other source business statements.
    approved=(HERE.parent/'offline-cash-pricing/patches/refund-by-hp-id.patch').read_text()
    removed=[line[1:] for line in approved.splitlines() if line.startswith('-') and not line.startswith('---')]
    added=[line[1:] for line in approved.splitlines() if line.startswith('+') and not line.startswith('+++')]
    if len(removed)!=2 or len(added)!=2:raise RuntimeError('Approved refund patch changed')
    for old,new in zip(removed,added):controller_candidate=once(controller_candidate,old,new)
    changes={'main.py':(original,main),'controllers/OrderController.py':(controller,controller_candidate)}
    entry='''"""Installed only with the reviewed source bundle and explicit contracts."""\nimport os\nimport sys\nfrom pathlib import Path\n_module_root=Path(os.environ['POS_NODE_SCREENING_MODULE_ROOT']).resolve()\nsys.path.insert(0,str(_module_root/'legacy-order-imports'))\nsys.path.insert(0,str(_module_root/'offline-cash-pricing'))\nsys.path.insert(0,str(_module_root/'public-screening-writer'))\nfrom bootstrap import Bootstrap,after_validate\ndef install(main_file):return Bootstrap(Path(main_file).resolve().parent)\n'''
    changes['pos_node_screening.py']=('',entry)
    patch=''.join(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+name if old else '/dev/null',tofile='b/'+name)) for name,(old,new) in changes.items())
    files=('writer_protocol.py','native_authority.py','creation.py','source_frame.py','bootstrap.py','public_effects.py','migration.review.sql')
    manifest={'contract':'pos-node-screening-writer-v1','activated':False,'sourceCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
              'scope':'Node POS origin only; other public/system writers unqualified',
              'base':{name:hashlib.sha256(old.encode()).hexdigest() for name,(old,_) in changes.items() if old},
              'candidate':{name:hashlib.sha256(new.encode()).hexdigest() for name,(_,new) in changes.items()},
              'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in files},
              'modelComposition':{'contract':'pos-import-source-model-v1','activated':False,
                'files':{name:hashlib.sha256((COMMON/name).read_bytes()).hexdigest() for name in ('model_compat.py','transaction.py')}},
              'patchSha256':hashlib.sha256(patch.encode()).hexdigest()}
    return {'public-pos-screening.patch':patch,'manifest.json':json.dumps(manifest,indent=2)+'\n'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');args=parser.parse_args()
    for name,value in outputs().items():
        path=HERE/name
        if args.write:path.write_text(value)
        elif not path.exists() or path.read_text()!=value:raise RuntimeError('Public screening artifact differs: '+name)
        print(name+' '+hashlib.sha256(value.encode()).hexdigest())
