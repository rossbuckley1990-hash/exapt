// Generic challenge runner. Task semantics and oracle answers are supplied only by the selector.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Exapt,configFromEnv} from '../../packages/protocol/engine.ts';
import {DockerBackend} from '../../packages/execution/index.ts';
import {RecordedModel} from './recorded-model.ts';
import {codingAgent} from './agent.ts';
import {checkFreeze,ROOT} from './freeze.ts';
import {SerialDockerBackend} from './serial-backend.ts';
import {engineWorker} from './worker.ts';
import type {Goal} from '../../packages/capability-universe/index.ts';

const args=process.argv.slice(2);
const opt=(name:string,fallback='')=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const publicRoot=path.resolve(opt('public'));
const sealedRoot=path.resolve(opt('sealed','/private/tmp/exapt-aegis5-sealed'));
const results=path.resolve(opt('out','benchmarks/results/aegis5-pilot'));
const freezeFile=path.resolve(opt('freeze'));
const modelName=opt('model','sonnet');
const phase=opt('phase','cold');
if(!opt('public')||!opt('freeze'))throw new Error('--public and --freeze are required');
checkFreeze(freezeFile);
fs.mkdirSync(results,{recursive:true});
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p:string,x:unknown)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');};
const backend=new DockerBackend({attestation:path.join(results,'sandbox-attestation.json')});
const exact=(mode:string,expected:string,actual:string)=>{
 const r=spawnSync('python3',[path.join(import.meta.dirname,'exact-score.py')],{input:JSON.stringify({mode,expected,actual}),encoding:'utf8',timeout:10000});
 if(r.status!==0)throw new Error(r.stderr);return readJson(r.stdout).equal===true;
};
const readJson=(s:string)=>JSON.parse(s);
type Task={id:string;intent:string;inputKind:'text'|'binary';instructions:string;examples:Array<{input:string;truth:string}>;targetSample:string;comparison:'text'|'json'|'records';software:unknown;limitations:string[]};
type Hidden={id:string;input:string;binary:boolean;expected:string;phase:string;expect:'output'|'refusal'};
const tasks=fs.readdirSync(publicRoot).filter(n=>fs.existsSync(path.join(publicRoot,n,'task.json'))).sort().map(n=>({dir:path.join(publicRoot,n),task:read(path.join(publicRoot,n,'task.json')) as Task}));
if(tasks.length!==3)throw new Error(`Expected exactly three selector tasks, found ${tasks.length}`);
const allCells=()=>{const cells:any[]=[];const walk=(d:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()&&e.name!=='workspace'&&e.name!=='home'&&e.name!=='public')walk(p);else if(e.name==='cell.json')cells.push(read(p));}};walk(results);return cells;};
const expenditure=()=>allCells().reduce((n,c)=>n+(typeof c.costUsd==='number'?c.costUsd:0.6),0);
function goalFor(task:Task,dir:string):Goal{
 const ref=(name:string)=>({path:path.join(dir,name)});
 return {id:task.id,intent:task.intent+'\n'+task.instructions,have:{samples:[ref(task.examples[0].input)]},want:{sample:ref(task.targetSample)},corpus:task.examples.map((p,i)=>({name:`public-${i}`,input:ref(p.input),truth:ref(p.truth)}))};
}
async function score(task:Task,source:string|undefined,libs:Record<string,string>,stage:string,dir:string){
 const hiddenFile=path.join(sealedRoot,task.id,'cases.json');const all=read(hiddenFile) as Hidden[];
 const cases=all.filter(c=>c.phase===stage);const rows=[];
 for(const c of cases){
  if(!source){rows.push({id:c.id,pass:false,blocked:'No executable artefact',expect:c.expect});continue;}
  const r=await backend.run({source,input:c.binary?Buffer.from(c.input,'base64'):c.input,libs});
  const pass=c.expect==='refusal'?r.status==='threw':r.status==='ok'&&exact(task.comparison,c.expected,r.output??'');
  rows.push({id:c.id,pass,expect:c.expect,status:r.status,output:r.output,error:r.error,ms:r.ms});
 }
 const report={corpusSha256:sha(fs.readFileSync(hiddenFile)),stage,passed:rows.filter(r=>r.pass).length,total:rows.length,rows};write(path.join(dir,stage+'-score.json'),report);return report;
}
function libsFor(e:Exapt,id:string){const m=e.vault.manifest(id);const libs:Record<string,string>={};for(const d of m?.dependencies??[])if(d.kind==='capability'){const dep=e.vault.manifest(d.id,d.version);if(dep)libs[d.id]=e.vault.source(dep);}return libs;}

async function cold(item:{dir:string;task:Task},arm:'B'|'D'){
 const {task}=item;const dir=path.join(results,task.id,arm,'cold');const cell=path.join(dir,'cell.json');
 if(fs.existsSync(cell))return; // Never overwrite a failed or interrupted cell.
 if(expenditure()+0.6>10){write(cell,{task:task.id,arm,stage:'cold',status:'budget-blocked',costUsd:0});return;}
 fs.mkdirSync(dir,{recursive:true});write(cell,{task:task.id,arm,stage:'cold',status:'started',costUsd:null});
 const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace,{recursive:true});
 // Release only this phase's public fixtures, not future change/composition examples.
 for(const name of new Set(['task.json',task.targetSample,...task.examples.flatMap(p=>[p.input,p.truth])])){
  const from=path.resolve(item.dir,name);if(!from.startsWith(path.resolve(item.dir)+path.sep))throw new Error('Public fixture path escapes task');
  const to=path.resolve(workspace,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
 }
 const start=Date.now();
 let source:string|undefined;let libs:Record<string,string>={};let claimed=false;let evidence:any;let costUsd:number|null=null;
 try{
  if(arm==='B'){
   const prompt=`Solve the computational task described in task.json and its public fixtures using the aegis MCP terminal. Read the instructions and examples. You may inspect, write and execute code, run your own tests, and debug. Validate boundary cases; do not guess missing information. Deliver a reusable out/capability.mjs exporting transform(input, lib) that returns a string (input is ${task.inputKind==='binary'?'a Node Buffer':'a string'}). It will run inside the same isolated Node22 environment without networking or host files. You may use Node standard modules. Do not embed the example answers. Save out/RESULT.json with {"status":"done"|"not-possible","notes":"..."}. Mark done only when you believe your implementation generalises. Your scripts will be retained for later sessions. Task: ${task.intent}`;
   const session=await codingAgent(path.join(dir,'agent'),workspace,prompt,modelName);costUsd=session.costUsd;evidence=session;
   const file=path.join(workspace,'out/capability.mjs');if(fs.existsSync(file))source=fs.readFileSync(file,'utf8');
   const result=path.join(workspace,'out/RESULT.json');if(fs.existsSync(result))claimed=read(result).status==='done';
  } else {
   const worker=await engineWorker(dir,workspace,modelName);write(path.join(dir,'worker.json'),worker);
   if(worker.error||!fs.existsSync(path.join(dir,'engine-result.json')))throw new Error(worker.error??`Engine worker exited ${worker.exit} without a result`);
   const result=read(path.join(dir,'engine-result.json'));costUsd=result.costUsd;claimed=result.claimed;evidence=result;if(result.error)throw new Error(result.error);
   if(fs.existsSync(path.join(dir,'candidate.mjs')))source=fs.readFileSync(path.join(dir,'candidate.mjs'),'utf8');
   if(fs.existsSync(path.join(dir,'libs.json')))libs=read(path.join(dir,'libs.json'));
  }
  if(source)fs.writeFileSync(path.join(dir,'candidate.mjs'),source);write(path.join(dir,'libs.json'),libs);
  const hidden=await score(task,source,libs,'cold',dir);
  write(cell,{task:task.id,arm,stage:'cold',status:'finished',claimed,correct:claimed&&hidden.total>0&&hidden.passed===hidden.total,falseSuccess:claimed&&hidden.passed<hidden.total,unverifiedCorrect:!claimed&&!!source&&hidden.total>0&&hidden.passed===hidden.total,hidden:{passed:hidden.passed,total:hidden.total},sourceSha256:source?sha(source):null,codeBytes:source?Buffer.byteLength(source):0,costUsd,elapsedMs:Date.now()-start,evidence,manualInterventions:0});
 }catch(error){write(cell,{task:task.id,arm,stage:'cold',status:'incomplete',error:String(error),costUsd,elapsedMs:Date.now()-start});}
 console.log(JSON.stringify(read(cell)));
}

async function reuse(item:{dir:string;task:Task},arm:'B'|'D',stage:string){
 const {task}=item;const coldDir=path.join(results,task.id,arm,'cold');const dir=path.join(results,task.id,arm,stage);const cell=path.join(dir,'cell.json');if(fs.existsSync(cell))return;
 const previous=fs.existsSync(path.join(coldDir,'cell.json'))?read(path.join(coldDir,'cell.json')):undefined;
 if(!previous?.claimed){write(cell,{task:task.id,arm,stage,status:'blocked-by-cold',costUsd:0});return;}
 const source=fs.readFileSync(path.join(coldDir,'candidate.mjs'),'utf8');const libs=read(path.join(coldDir,'libs.json'));
 const start=Date.now();fs.mkdirSync(dir,{recursive:true});
 // Independent execution by a fresh host process; no resynthesis and no conversation state.
 const hidden=await score(task,source,libs,stage,dir);
 write(cell,{task:task.id,arm,stage,status:'finished',costUsd:0,modelCalls:0,hidden:{passed:hidden.passed,total:hidden.total},allPassed:hidden.total>0&&hidden.passed===hidden.total,elapsedMs:Date.now()-start,scope:stage==='warm'?'Deterministic saved-artefact reuse; MCP agent handoff is scored separately.':'Input/contract change probe only unless selector explicitly supplies a changed executable dependency. No claim of automatic adaptation.',sourceSha256:sha(source)});
 console.log(JSON.stringify(read(cell)));
}

write(path.join(results,'study.json'),{model:modelName,freeze:read(freezeFile).sha256,publicRoot,sealedRoot,phase,at:new Date().toISOString(),preregistrationSha256:sha(fs.readFileSync(path.join(import.meta.dirname,'PREREGISTRATION.md')))});
for(const [i,item] of tasks.entries())for(const arm of (i%2?['D','B']:['B','D']) as Array<'B'|'D'>){checkFreeze(freezeFile);if(phase==='cold')await cold(item,arm);else if(['warm','compatible','incompatible'].includes(phase))await reuse(item,arm,phase);else throw new Error('Use --phase cold|warm|compatible|incompatible');}
write(path.join(results,'summary.json'),{at:new Date().toISOString(),cells:allCells(),reservedOrReportedCostUsd:expenditure()});
