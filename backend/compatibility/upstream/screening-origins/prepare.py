"""Generate legacy POS caller overlays; never modify the supplied checkout."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
from source_hooks import LEGACY_COMMIT,legacy_changes,manifest

HERE=Path(__file__).resolve().parent


def outputs(root):
    root=Path(root).resolve(strict=True)
    revision=subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],check=True,
                            capture_output=True,text=True).stdout.strip()
    if revision!=LEGACY_COMMIT:raise RuntimeError('Pinned legacy source required')
    changes=legacy_changes(root)
    for name,(original,_) in changes.items():
        if not original:continue
        pinned=subprocess.run(['git','-C',str(root),'show',LEGACY_COMMIT+':'+name],
                              check=True,capture_output=True).stdout
        if original.encode()!=pinned:raise RuntimeError('Legacy source input changed')
    patch=''.join(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),
        fromfile='a/'+name if old else '/dev/null',tofile='b/'+name))
        for name,(old,new) in changes.items())
    data={**manifest(changes),'scope':'original legacy Django/MPos caller',
          'base':{name:hashlib.sha256(old.encode()).hexdigest()
                  for name,(old,_) in changes.items() if old},
          'patchSha256':hashlib.sha256(patch.encode()).hexdigest(),
          'files':{path.name:hashlib.sha256(path.read_bytes()).hexdigest()
                   for path in sorted(HERE.iterdir()) if path.suffix in ('.py','.sql','.mjs')}}
    return {'legacy-pos-origin.patch':patch,'legacy-manifest.json':json.dumps(data,indent=2)+'\n'}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source-root',default=os.environ.get('POS_LEGACY_ORIGIN_SOURCE_ROOT'))
    parser.add_argument('--write',action='store_true')
    args=parser.parse_args()
    if not args.source_root:parser.error('An immutable legacy source root is required')
    for name,value in outputs(args.source_root).items():
        target=HERE/name
        if args.write:target.write_text(value)
        elif not target.exists() or target.read_text()!=value:raise RuntimeError('Legacy origin artifact differs')
        print(name+' '+hashlib.sha256(value.encode()).hexdigest())
