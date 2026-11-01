"""Independent strict scorer; no imports from EXAPT and no numeric tolerances."""
from decimal import Decimal
import json, sys

def pairs(items):
    out={}
    for k,v in items:
        if k in out: raise ValueError('duplicate JSON key')
        out[k]=v
    return out

def reject(x): raise ValueError('nonfinite JSON constant')
def load(s): return json.loads(s,parse_int=Decimal,parse_float=Decimal,parse_constant=reject,object_pairs_hook=pairs)
def canonical(v):
    if isinstance(v,dict): return ('object',tuple((k,canonical(x)) for k,x in sorted(v.items())))
    if isinstance(v,list): return ('array',tuple(canonical(x) for x in v))
    if isinstance(v,Decimal): return ('number',v)
    return (type(v).__name__,v)

request=json.load(sys.stdin)
try:
    mode=request['mode']
    def parse(s):
        if mode=='records': return [canonical(load(l)) for l in s.splitlines() if l.strip()]
        if mode=='json': return canonical(load(s))
        return s.rstrip('\r\n')
    print(json.dumps({'equal':parse(request['expected'])==parse(request['actual'])}))
except Exception as e:
    print(json.dumps({'equal':False,'error':str(e)}))
