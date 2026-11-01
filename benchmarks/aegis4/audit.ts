import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DockerBackend, IMAGE, selfTest, dockerStatus } from '../../packages/execution/index.ts';
import { mutantsOf } from '../../packages/experiment-engine/index.ts';
import { Exapt, configFromEnv } from '../../packages/protocol/engine.ts';
import { negativeControls } from '../../demos/invariant-telemetry/controls.ts';
import { pool } from '../../packages/shared/index.ts';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const originals = path.resolve('benchmarks/results/aegis4-originals');
const dir = path.resolve(process.argv[2] ?? `benchmarks/results/aegis4-audit-${Date.now()}`);
if (fs.existsSync(dir)) throw new Error('Do not overwrite audit evidence');
fs.mkdirSync(dir, { recursive: true });
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const inventory = JSON.parse(fs.readFileSync(path.join(originals,'inventory.json'),'utf8'));
for (const file of inventory.inventory) if (sha(fs.readFileSync(path.join(originals,file.path))) !== file.sha256) throw new Error(`Archived file changed: ${file.path}`);
const success = inventory.attempts.find((r: any) => r.evidence?.level === 'verified-in-domain');
const root = path.join(originals,success.directory);
const originalHome = path.join(root,'.exapt');
const source = fs.readFileSync(path.join(originalHome,'objects',success.accepted.sha256),'utf8');
if (sha(source) !== success.accepted.sha256) throw new Error('Candidate hash mismatch');
fs.writeFileSync(path.join(dir,'candidate.mjs'),source);
const backend = new DockerBackend({attestation:path.join(dir,'sandbox-attestation.json')});
const isolation = await selfTest(backend);
save('isolation.json',{...isolation,docker:dockerStatus(),image:IMAGE});
if (!isolation.ok) throw new Error('Containment self-test failed; no candidate execution');

type Case = { id: string; input: string; expected?: string; refusal: boolean; provenance: string };
const oracle = path.resolve('benchmarks/aegis4/oracle.py');
const cases: Case[] = [];
const add = (id:string,input:string,provenance:string) => {
  const r=spawnSync('python3',[oracle],{input,encoding:'utf8',timeout:5000});
  if(r.status!==0) throw new Error(r.stderr);
  const out=JSON.parse(r.stdout);
  cases.push({id,input,...(out.ok?{expected:out.output}:{}),refusal:!out.ok,provenance});
};
for(const name of fs.readdirSync(path.join(root,'corpus')).filter(n=>n.endsWith('.input.txt')).sort()) {
  const input=fs.readFileSync(path.join(root,'corpus',name),'utf8');
  add(`original-${name}`,input,'original fixture checked by independently implemented Python oracle');
  const stored=fs.readFileSync(path.join(root,'corpus',name.replace('.input.txt','.truth.ndjson')),'utf8');
  if (stored.trim()!==cases.at(-1)!.expected?.trim()) throw new Error('Independent oracle disagrees with original truth');
}
const names=['Pages free','Pages active','Pages inactive','Pages speculative','Pages wired down','Pages occupied by compressor'];
const make=(page:number,counts:number[])=>`Mach Virtual Memory Statistics: (page size of ${page} bytes)\n`+names.map((n,i)=>`${n}: ${counts[i]}.`).join('\n')+'\n';
for(const page of [4096,16384,65536]) for(const [i,counts] of [[0,0,0,0,0,0],[1,3,7,13,29,61],[12000,140000,380000,3000,220000,350000]].entries()) add(`page-${page}-counts-${i}`,make(page,counts),'new audit domain checks; integer products computed in Python');
const full=make(16384,[1,3,7,13,29,61]);
add('empty','','boundary: empty input');
add('header-only',full.split('\n')[0]+'\n','boundary: one-line valid header');
add('one-invalid-line','not telemetry\n','boundary: one-line invalid input');
add('missing-metric',full.split('\n').slice(0,-2).join('\n')+'\n','malformed: required metric absent');
add('zero-page-size',full.replace('16384 bytes','0 bytes'),'malformed: zero scale');
add('duplicate-metric',full+'Pages free: 999.\n','NEW stricter ambiguity requirement; not established by original suite');
add('invalid-header-prefix','garbage '+full,'NEW strict header requirement; not established by original suite');
add('blank-line',full.replace('Pages active','\nPages active'),'valid blank line');
const live=spawnSync('/usr/bin/vm_stat',[],{encoding:'utf8',timeout:5000});
if(live.status===0) add('live-host',live.stdout,'fresh /usr/bin/vm_stat; no synthetic fallback');
save('cases.json',cases);
save('oracle.json',{path:oracle,sha256:sha(fs.readFileSync(oracle)),limitations:['Independent implementation, not an external human oracle.', 'This tests six selected metrics, not a physical conservation law.']});

const programs=[{name:'accepted-original',source,kind:'original'},...negativeControls(16384).map(c=>({name:c.name,source:c.candidate.source,kind:'negative-control'})),...mutantsOf(source).map(m=>({...m,kind:`mutant-${m.kind}`}))];
fs.mkdirSync(path.join(dir,'programs'));
const results=await pool(programs,2,async p=>{
  const hash=sha(p.source);fs.writeFileSync(path.join(dir,'programs',hash+'.mjs'),p.source);
  const rows=[];
  for(const c of cases) {
    const r=await backend.run({source:p.source,input:c.input,limits:{timeoutMs:3000}});
    const pass=c.refusal?r.status==='threw':r.status==='ok'&&r.output?.trim()===c.expected?.trim();
    rows.push({id:c.id,pass,status:r.status,error:r.error,ms:r.ms,...(r.output!==undefined?{output:r.output}:{} )});
  }
  const result={name:p.name,kind:p.kind,sha256:hash,passed:rows.filter(r=>r.pass).length,total:rows.length,rows};
  save(hash+'.json',result);console.log(JSON.stringify({name:p.name,passed:result.passed,total:result.total}));return result;
});
const mutant=results.find(r=>r.name==='literal changed at 206')!;
const original=results[0];
const sameValuesAndRefusals=original.rows.every((r,i)=>r.status===mutant.rows[i].status&&(r.status!=='ok'||r.output===mutant.rows[i].output));

const home=path.join(dir,'replay-home');fs.cpSync(originalHome,home,{recursive:true});
const e=await Exapt.open(configFromEnv({}, {home,programs:[path.join(root,'programs')],model:null}));
let invocation:unknown;
try {
  if(live.status!==0) invocation={blocked:'vm_stat unavailable; no fallback'};
  else {
    const cap=JSON.parse(fs.readFileSync(path.join(root,'demo4-telemetry-report.json'),'utf8')).capability.id;
    const r=await e.use(cap,live.stdout);
    const expected=cases.find(c=>c.id==='live-host')!.expected;
    invocation={...r,exactMatch:r.output.trim()===expected?.trim()};
  }
} finally {await e.host.rc.flush();}
save('report.json',{sourceSha256:sha(source),originalRun:success.id,originalMutation:success.evidence.mutation,
  historicalTranscript:'Unavailable: logs record only character counts and usage. No full prompt/response was retained.',
  historicalSourceRevision:'Unavailable: original dirty checkout was not pinned.',
  isolation,results:results.map(({rows,...r})=>({...r,failures:rows.filter(x=>!x.pass).map(x=>x.id)})),
  survivingLiteral:{name:mutant.name,sameValuesAndRefusals,classification:'Equivalent for successful outputs and rejection, assuming error messages are not part of the contract. Exact exception messages differ.',reason:'Only line counts 0 and 1 change the branch. Both subsequently reject (missing header or missing required metrics). Counts >=2 follow identical code. Raw scores remain unchanged.'},liveInvocation:invocation});
console.log(JSON.stringify({report:path.join(dir,'report.json'),sameValuesAndRefusals,originalFailures:original.rows.filter(r=>!r.pass).map(r=>r.id)},null,2));
