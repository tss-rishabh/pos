"""Pure fixture bridge; no source imports, database or external I/O."""
import json
import sys
from writer_protocol import verify,portable_hash

value=json.loads(sys.stdin.read())
if value['action']=='verify':result=verify(value['header'],value['key'],value['now'])
elif value['action']=='hash':result={'hash':portable_hash(value['value'])}
else:raise RuntimeError('Unknown fixture action')
print(json.dumps(result,separators=(',',':'),ensure_ascii=False))
