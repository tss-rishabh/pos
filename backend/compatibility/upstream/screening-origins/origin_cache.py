"""Compare the captured Redis state before an original deferred mutation.

The receipt and mutation are one Lua command. A newer untracked writer changes
the dump and is preserved; a lost reply can be observed without another write.
"""
import base64
import math
from origin_contracts import canonical,digest,fail,unsafe


def scalar(value):
    if value is None:return ''
    if type(value) is bool:return '1' if value else '0'
    if type(value) in (str,int) or type(value) is float and math.isfinite(value):return str(value)
    fail('SCREENING_ORIGIN_CACHE_UNQUALIFIED')


def operation(method,args,kwargs):
    if not isinstance(args,list) or not isinstance(kwargs,dict) or not args or not isinstance(args[0],str):fail('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
    key=args[0];values=[];keys=[key]
    if method=='set':
        if len(args)!=2 or set(kwargs)-{'ex','px','keepttl'}:fail()
        values=['SET',key,scalar(args[1])]
        if kwargs.get('keepttl') is True:
            if set(kwargs)!={'keepttl'}:fail()
            values+=['KEEPTTL']
        else:
            if kwargs.get('ex') is not None and kwargs.get('px') is not None:fail()
            for name,unit in (('ex','EX'),('px','PX')):
                if kwargs.get(name) is not None:
                    ttl=kwargs[name]
                    if type(ttl) is not int or not 0<ttl<=31536000000:fail()
                    values+=[unit,str(ttl)]
    elif method in ('setex','psetex'):
        if len(args)!=3 or kwargs or type(args[1]) is not int or args[1]<=0:fail()
        values=[method.upper(),key,str(args[1]),scalar(args[2])]
    elif method=='delete':
        if kwargs or not all(isinstance(item,str) for item in args):fail()
        keys=args;values=['DEL',*args]
    elif method in ('expire','pexpire'):
        if len(args)!=2 or kwargs or type(args[1]) is not int or args[1]<0:fail()
        values=[method.upper(),key,str(args[1])]
    elif method in ('hset','hmset'):
        mapping=kwargs.get('mapping')
        if len(args)==2 and isinstance(args[1],dict) and not kwargs:mapping=args[1]
        elif len(args)==3 and not kwargs:mapping={scalar(args[1]):args[2]}
        elif len(args)!=1 or set(kwargs)!={'mapping'}:fail()
        if not isinstance(mapping,dict) or not mapping:fail()
        values=['HSET',key,*[part for name,value in mapping.items() for part in (scalar(name),scalar(value))]]
    elif method in ('hdel','sadd','srem','zrem'):
        if len(args)<2 or kwargs:fail()
        values=[method.upper(),key,*map(scalar,args[1:])]
    elif method=='zadd':
        if len(args)!=2 or kwargs or not isinstance(args[1],dict) or not args[1]:fail()
        values=['ZADD',key,*[part for member,score in args[1].items() for part in (scalar(score),scalar(member))]]
    else:fail('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
    if len(keys)>100 or len(values)>1000 or any(not item or len(item.encode())>4096 or item.startswith('screening_origin_') for item in keys):fail()
    return keys,values


def observe(cache,alias,method,args,kwargs,effects):
    try:
        if not isinstance(alias,str) or not alias:fail()
        keys,_values=operation(method,args,kwargs);result=[]
        for key in keys:
            previous=None
            for index,item in enumerate(effects):
                if item.get('kind')=='cache' and item.get('alias')==alias and any(row['key']==key for row in item.get('observations',[])):previous=index
            dump=cache.dump(key)
            if dump is not None and (not isinstance(dump,bytes) or len(dump)>250000):fail()
            result.append({'key':key,'dump':None if dump is None else base64.b64encode(dump).decode(),'previousOrdinal':previous})
        if len(canonical(result).encode())>400000:fail()
        return result
    except Exception:unsafe('SCREENING_ORIGIN_CACHE_UNQUALIFIED')


LUA="""local n=tonumber(ARGV[1]); local receipt=ARGV[2];
if redis.call('GET',KEYS[2*n+1])==receipt then return 2 end;
for i=1,n do
 local present=ARGV[2+4*(i-1)+1];local expected=ARGV[2+4*(i-1)+2];
 local previous=ARGV[2+4*(i-1)+3];local current=redis.call('DUMP',KEYS[i]);
 if previous~='' then
  if redis.call('GET',KEYS[n+i])~=previous..(current or '<nil>') then return 0 end;
 elseif (present=='0' and current) or (present=='1' and current~=expected) then return 0 end;
end;
local command=cjson.decode(ARGV[3+4*n]);redis.call(unpack(command));
for i=1,n do local owner=ARGV[2+4*(i-1)+4];local current=redis.call('DUMP',KEYS[i]);redis.call('SET',KEYS[n+i],owner..(current or '<nil>')) end;
redis.call('SET',KEYS[2*n+1],receipt);return 1"""


def execute(cache,effect,effect_id,key):
    keys,command=operation(effect['method'],effect['args'],effect['kwargs'])
    observations=effect.get('observations')
    if not isinstance(observations,list) or [item.get('key') for item in observations]!=keys:fail('SCREENING_ORIGIN_CACHE_UNQUALIFIED')
    owners=['screening_origin_owner_'+digest(key,'cache-key',{'alias':effect['alias'],'key':item}) for item in keys]
    receipt=digest(key,'cache-effect',{'effectId':effect_id,'commandId':effect['commandId']})
    arguments=[str(len(keys)),receipt]
    for item in observations:
        previous=item['previousOrdinal']
        if previous is not None and (type(previous) is not int or not 0<=previous<effect['ordinal']):fail()
        token=lambda ordinal:digest(key,'cache-owner',{'commandId':effect['commandId'],'ordinal':ordinal,'alias':effect['alias'],'key':item['key']})
        try:dump=b'' if item['dump'] is None else base64.b64decode(item['dump'],validate=True)
        except Exception:fail()
        arguments.extend(['0' if item['dump'] is None else '1',dump,'' if previous is None else token(previous),token(effect['ordinal'])])
    arguments.append(canonical(command))
    result=cache.eval(LUA,2*len(keys)+1,*keys,*owners,'screening_origin_effect_'+effect_id,*arguments)
    if type(result) is not int or result not in (1,2):fail('SCREENING_ORIGIN_CACHE_CHANGED')
