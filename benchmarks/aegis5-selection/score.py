#!/usr/bin/env python3
"""AEGIS-5 independent evaluator. Public control code; corpus is never mounted.

verify: verify commitments, no task contents emitted.
score: evaluate a provided CommonJS transform with the fixed sealed corpus.
No model calls, acquisition, repair, retries, engine imports, or oracle adaptation.
"""
from pathlib import Path
import argparse, base64, collections, hashlib, json, math, os, selectors, subprocess, time, uuid

PUBLIC=Path(__file__).resolve().parent
SEALED=Path('/private/tmp/exapt-aegis5-sealed')
IMAGE='sha256:69f266c3ec9d93ce85b5643431560e9eedefb54f252730c84453239c2e68f071'
PHASES=['cold','warm','compatible','incompatible','composition']
REFUSAL={'error':'UNSUPPORTED_INPUT'}
def sha(b):return hashlib.sha256(b).hexdigest()
def pack(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def read(path):return json.loads(Path(path).read_text())
def within(path,roots=(PUBLIC,SEALED)):
    p=Path(path).resolve()
    if not any(p.is_relative_to(r.resolve()) for r in roots):raise ValueError('All submissions, inventory and reports must be inside the two selector directories')
    return p
def validate_manifest(name,root):
    m=read(root/name)
    for item in m['files']:
        p=(root/item['path']).resolve()
        if not p.is_relative_to(root.resolve()) or sha(p.read_bytes())!=item['sha256']:raise ValueError('Commitment mismatch: '+item['path'])
    return sha((root/name).read_bytes())
def verify():
    lock=read(PUBLIC/'FREEZE.json')
    actual={'publicManifestSha256':validate_manifest('PUBLIC-MANIFEST.json',PUBLIC),'sealedManifestSha256':validate_manifest('SEALED-MANIFEST.json',SEALED)}
    for key,val in actual.items():
        if lock[key]!=val:raise ValueError('Freeze mismatch: '+key)
    return {'verified':True,**actual,'freezeSha256':sha((PUBLIC/'FREEZE.json').read_bytes())}
def docker_execute(payload,timeout=10):
    # Neither submission directories, expected outputs, other cases nor host sockets
    # enter Docker. One container per case also supplies fresh-session evaluation.
    runner=(PUBLIC/'runner.cjs').read_text()
    name='aegis5-'+uuid.uuid4().hex
    cmd=['docker','run','--rm','--name',name,'--pull','never','--network','none','--read-only',
         '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64',
         '--memory','256m','--memory-swap','256m','--cpus','1','--user','65534:65534',
         '--env','TZ=UTC','--env','LANG=C.UTF-8',IMAGE,'node','--disable-proto=throw','-e',runner]
    start=time.monotonic();p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        # Payload is small enough for the live Node reader; no expected values are sent.
        p.stdin.write(pack(payload).encode());p.stdin.close()
        sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,'out');sel.register(p.stderr,selectors.EVENT_READ,'err')
        chunks={'out':bytearray(),'err':bytearray()};total=0
        while sel.get_map():
            remaining=timeout-(time.monotonic()-start)
            if remaining<=0:raise TimeoutError('container timeout')
            for key,_ in sel.select(min(remaining,.2)):
                b=os.read(key.fileobj.fileno(),65536)
                if not b:sel.unregister(key.fileobj);continue
                total+=len(b)
                if total>2*1048576:raise ValueError('container output limit')
                chunks[key.data].extend(b)
        code=p.wait(timeout=max(.01,timeout-(time.monotonic()-start)))
        if code:raise ValueError('container exit '+str(code)+': '+chunks['err'][:1000].decode(errors='replace'))
        result=json.loads(chunks['out'])
        if not isinstance(result,dict) or type(result.get('ok')) is not bool:raise ValueError('invalid runner envelope')
        result['elapsedSeconds']=round(time.monotonic()-start,6)
        return result
    except Exception as e:
        p.kill();p.wait()
        # Killing the Docker client does not reliably terminate the container.
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        return {'ok':False,'error':str(e),'calls':{},'elapsedSeconds':round(time.monotonic()-start,6)}
    finally:
        for f in [p.stdout,p.stderr]:f.close()
def strict_json(s):
    def pairs(items):
        d={}
        for k,v in items:
            if k in d:raise ValueError('duplicate JSON key')
            d[k]=v
        return d
    def constant(s):raise ValueError('non-finite JSON number')
    return json.loads(s,object_pairs_hook=pairs,parse_constant=constant)
def equal(a,b):
    # JSON numeric equality, without Python's True == 1 behavior.
    if isinstance(a,bool) or isinstance(b,bool):return type(a)==type(b) and a==b
    if isinstance(a,(int,float)) and isinstance(b,(int,float)):return math.isfinite(a) and math.isfinite(b) and a==b
    if type(a)!=type(b):return False
    if isinstance(a,dict):return a.keys()==b.keys() and all(equal(a[k],b[k]) for k in a)
    if isinstance(a,list):return len(a)==len(b) and all(equal(x,y) for x,y in zip(a,b))
    return a==b
def compare(output,expected,mode):
    if not isinstance(output,str):return False
    try:
        if mode=='json':return equal(strict_json(output),strict_json(expected))
        if mode=='records':return collections.Counter(output.splitlines())==collections.Counter(expected.splitlines())
        return output==expected
    except (ValueError,TypeError,OverflowError):return False
def source(path):
    p=within(path);raw=p.read_bytes()
    if len(raw)>1048576:raise ValueError('Program source exceeds 1 MiB')
    return {'path':str(p),'sha256':sha(raw),'source':raw.decode('utf8')}
def reuse_requirement(tid,c):
    if c['phase']!='composition':return 0
    o=json.loads(c['input'])
    return len(o['images']) if tid=='a5-01' else len(o['labels']) if tid=='a5-02' else 1
def evaluate(tid,program,composition=None,retained=None,phases=None):
    spec=read(PUBLIC/tid/'task.json');cases=read(SEALED/tid/'cases.json');results=[]
    for c in cases:
        if phases and c['phase'] not in phases:continue
        composing=c['phase']=='composition';p=composition if composing else program
        if p is None:
            results.append({'id':c['id'],'phase':c['phase'],'pass':False,'error':'missing composition program','retainedCalls':0,'reusePass':False});continue
        library={}
        if composing:library[tid]=program['source']
        for k,v in (retained or {}).items():
            if k==tid:raise ValueError('Cannot override first-stage retained transform')
            library[k]=v['source']
        result=docker_execute({'source':p['source'],'retained':library,'input':c['input'],'binary':c['binary']})
        passed=result.get('ok') is True and compare(result.get('output'),c['expected'],spec['comparison'])
        # Wrong output, crashes, timeout and malformed JSON never count as refusal.
        count=result.get('calls',{}).get(tid,0);required=reuse_requirement(tid,c)
        if type(count) is not int or count<0:count=0
        row={'id':c['id'],'phase':c['phase'],'expect':c['expect'],'pass':passed,'retainedCalls':count,'requiredRetainedCalls':required,'reusePass':passed and count>=required,'elapsedSeconds':result['elapsedSeconds']}
        if not result.get('ok'):row['error']=result.get('error','execution error')
        # Diagnostic output is sealed, and never fed back into model repair.
        if 'output' in result:row['actualSha256']=sha(result['output'].encode())
        results.append(row)
    byphase={}
    for phase in PHASES:
        rr=[r for r in results if r['phase']==phase]
        if rr:byphase[phase]={'passed':sum(r['pass'] for r in rr),'total':len(rr),'accuracy':sum(r['pass'] for r in rr)/len(rr)}
    comp=[r for r in results if r['phase']=='composition']
    return {'programSha256':program['sha256'],'compositionSha256':composition['sha256'] if composition else None,'retainedSha256':{k:v['sha256'] for k,v in (retained or {}).items()},'phases':byphase,'macroAccuracy':sum(x['accuracy'] for x in byphase.values())/len(byphase),'compositionReuseAccuracy':sum(r['reusePass'] for r in comp)/len(comp) if comp else None,'cases':results}
def main():
    ap=argparse.ArgumentParser(description=__doc__);sp=ap.add_subparsers(dest='command',required=True)
    sp.add_parser('verify')
    s=sp.add_parser('score');s.add_argument('--task',required=True,choices=['a5-01','a5-02','a5-03']);s.add_argument('--program',required=True)
    s.add_argument('--arm',required=True,choices=['candidate','saved-executable','exposed-operation'])
    s.add_argument('--composition-program');s.add_argument('--retained',action='append',default=[],metavar='ID=PATH')
    s.add_argument('--exposed-program',action='append',default=[],metavar='NAME=PATH')
    s.add_argument('--inventory',help='Pre-acquisition exposed-operation inventory JSON supplied after engine freeze')
    s.add_argument('--report',help='Optional NEW sealed report path. Default: sealed/runs/unique-id.json')
    args=ap.parse_args();verification=verify()
    if args.command=='verify':print(pack(verification));return
    retained={}
    for item in args.retained:
        k,p=item.split('=',1);retained[k]=source(p)
    program=source(args.program);comp=source(args.composition_program) if args.composition_program else None
    report={'suite':verification,'arm':args.arm,'task':args.task,'image':IMAGE,'node':'22.23.4','freshContainerPerCase':True,'paidModelCalls':0,'result':evaluate(args.task,program,comp,retained)}
    controls={}
    for item in args.exposed_program:
        name,path=item.split('=',1);controls[name]=evaluate(args.task,source(path),phases=PHASES[:-1])
    report['exposedOperationControls']=controls
    if args.inventory:
        p=within(args.inventory);report['inventory']={'sha256':sha(p.read_bytes()),'data':read(p)}
    else:report['inventory']=None
    if any(all(x['pass'] for x in v['cases']) for v in controls.values()):novelty='existing exposed operation solves the frozen first-stage contract; no new capability demonstrated'
    elif controls and args.inventory:novelty='candidate may extend the supplied tested operation set; completeness of inventory requires independent audit'
    else:novelty='undetermined: no complete pre-acquisition exposed-operation evidence; existing software primitives are disclosed in each public task'
    report['noveltyAssessment']=novelty
    destination=within(args.report) if args.report else SEALED/'runs'/(uuid.uuid4().hex+'.json')
    if not destination.is_relative_to(SEALED):raise ValueError('Hidden case reports must remain sealed')
    destination.parent.mkdir(parents=True,exist_ok=True)
    with destination.open('x') as f:json.dump(report,f,indent=2,ensure_ascii=False);f.write('\n')
    print(pack({'report':str(destination),'task':args.task,'arm':args.arm,'phases':report['result']['phases'],'macroAccuracy':report['result']['macroAccuracy'],'compositionReuseAccuracy':report['result']['compositionReuseAccuracy'],'noveltyAssessment':novelty}))
if __name__=='__main__':main()
