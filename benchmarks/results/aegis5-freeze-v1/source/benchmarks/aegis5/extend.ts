// Compatible adaptation and composition use only selector-released public examples.
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {DockerBackend} from '../../packages/execution/index.ts';
import {codingAgent} from './agent.ts';import {engineWorker} from './worker.ts';import {checkFreeze} from './freeze.ts';
const argv=process.argv.slice(2);const opt=(n:string,d='')=>{const i=argv.indexOf('--'+n);return i<0?d:argv[i+1];};
const results=path.resolve(opt('out'));const publicRoot=path.resolve(opt('public'));const sealed=path.resolve(opt('sealed','/private/tmp/exapt-aegis5-sealed'));const frozen=path.resolve(opt('freeze'));const stage=opt('phase','composition');checkFreeze(frozen);
if(!['compatible','composition'].includes(stage))throw new Error('Only compatible adaptation or composition may create a new candidate');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const save=(p:string,v:unknown)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2));};
const backend=new DockerBackend({attestation:path.join(results,'sandbox-attestation.json')});
const used=()=>{let n=0;const walk=(d:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()&&!['home','workspace','public'].includes(e.name))walk(p);else if(e.name==='cell.json'){const c=read(p);n+=typeof c.costUsd==='number'?c.costUsd:0.6;}}};walk(results);return n;};
for(const name of fs.readdirSync(publicRoot).filter(n=>fs.existsSync(path.join(publicRoot,n,'task.json'))).sort()){
 const parentDir=path.join(publicRoot,name);const original=read(path.join(parentDir,'task.json'));const variantDir=path.join(parentDir,stage);const variantFile=path.join(variantDir,'task.json');
 for(const arm of ['B','D']){
  checkFreeze(frozen);const cold=path.join(results,original.id,arm,'cold');const dir=path.join(results,original.id,arm,stage+'-attempt');const cell=path.join(dir,'cell.json');if(fs.existsSync(cell))continue;
  const prior=fs.existsSync(path.join(cold,'cell.json'))?read(path.join(cold,'cell.json')):null;
  if(!prior?.claimed||!fs.existsSync(variantFile)){save(cell,{task:original.id,arm,stage:stage+'-attempt',status:!prior?.claimed?'blocked-by-cold':'no-public-variant-spec',costUsd:0});continue;}
  if(used()+0.6>10){save(cell,{task:original.id,arm,stage:stage+'-attempt',status:'budget-blocked',costUsd:0});continue;}
  const task=read(variantFile);const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace,{recursive:true});
  const copy=(from:string,prefix:string,t:any)=>{for(const file of new Set<string>([t.targetSample,...t.examples.flatMap((p:any)=>[p.input,p.truth])])){const src=path.resolve(from,file);if(!src.startsWith(path.resolve(from)+path.sep))throw new Error('Fixture path escapes public source');const dst=path.join(workspace,prefix,file);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}};
  copy(variantDir,'',task);
  if(stage==='compatible'){
   copy(parentDir,'prior-public',original);
   task.examples=[...task.examples,...original.examples.map((p:any)=>({input:path.join('prior-public',p.input),truth:path.join('prior-public',p.truth)}))];
   task.instructions+='\nPreserve the original requirements on the prior-public cases as well as handling the new cases.';
  }
  save(path.join(workspace,'task.json'),task);
  const start=Date.now();save(cell,{task:original.id,arm,stage:stage+'-attempt',status:'started',costUsd:null});let costUsd:number|null=null;
  try{
   let source:string|undefined,libs:Record<string,string>={},claimed=false,evidence:any;
   if(arm==='D'){
    fs.cpSync(path.join(cold,'home'),path.join(dir,'home'),{recursive:true});
    const worker=await engineWorker(dir,workspace,opt('model','sonnet'));save(path.join(dir,'worker.json'),worker);
    if(worker.error||!fs.existsSync(path.join(dir,'engine-result.json')))throw new Error(worker.error??'Worker did not finish');
    const r=read(path.join(dir,'engine-result.json'));costUsd=r.costUsd;claimed=r.claimed;evidence=r;if(r.error)throw new Error(r.error);
    if(fs.existsSync(path.join(dir,'candidate.mjs')))source=fs.readFileSync(path.join(dir,'candidate.mjs'),'utf8');
    if(fs.existsSync(path.join(dir,'libs.json')))libs=read(path.join(dir,'libs.json'));
   }else{
    fs.mkdirSync(path.join(workspace,'previous'),{recursive:true});const previous=fs.readFileSync(path.join(cold,'candidate.mjs'),'utf8');fs.writeFileSync(path.join(workspace,'previous/capability.mjs'),previous);libs={...read(path.join(cold,'libs.json')),previous};
    save(path.join(workspace,'previous/libraries.json'),libs);
    const prompt=`Read task.json and solve this ${stage} task using the aegis terminal. The previous capability and libraries are in previous/. You may inspect, execute, test and reuse that code. Write out/capability.mjs exporting transform(input,lib) returning a string and out/RESULT.json with status done or not-possible. lib.previous is the saved transform; other saved libraries are described in previous/libraries.json. Use the previous capability as a building block when useful. Validate your new code against the supplied requirements and boundaries. Do not embed example answers. The execution constraints and authority are the same as before; no original conversation is available.`;
    const session=await codingAgent(path.join(dir,'agent'),workspace,prompt,opt('model','sonnet'));costUsd=session.costUsd;evidence=session;
    if(fs.existsSync(path.join(workspace,'out/capability.mjs')))source=fs.readFileSync(path.join(workspace,'out/capability.mjs'),'utf8');
    if(fs.existsSync(path.join(workspace,'out/RESULT.json')))claimed=read(path.join(workspace,'out/RESULT.json')).status==='done';
   }
   if(source)fs.writeFileSync(path.join(dir,'candidate.mjs'),source);save(path.join(dir,'libs.json'),libs);
   const hidden=read(path.join(sealed,original.id,'cases.json')).filter((c:any)=>c.phase===stage||(stage==='compatible'&&c.phase==='cold'));
   const rows=[];
   for(const c of hidden){if(!source){rows.push({id:c.id,pass:false,blocked:'No candidate'});continue;}const r=await backend.run({source,input:c.binary?Buffer.from(c.input,'base64'):c.input,libs});const pass=c.expect==='refusal'?r.status==='threw':r.status==='ok'&&JSON.parse(spawnSync('python3',[path.join(import.meta.dirname,'exact-score.py')],{input:JSON.stringify({mode:task.comparison,expected:c.expected,actual:r.output??''}),encoding:'utf8'}).stdout).equal;rows.push({id:c.id,phase:c.phase,pass,status:r.status,output:r.output,error:r.error});}
   // A claimed composition must depend on an earlier retained implementation in execution.
   const ablations=[];
   const inheritedHashes=new Set([sha(fs.readFileSync(path.join(cold,'candidate.mjs'),'utf8')),...Object.values(read(path.join(cold,'libs.json'))).map(s=>sha(String(s))),...(fs.existsSync(path.join(cold,'generated.mjs'))?[sha(fs.readFileSync(path.join(cold,'generated.mjs'),'utf8'))]:[])]);
   if(stage==='composition'&&source){const c=hidden.find((c:any)=>c.expect==='output');if(c)for(const key of Object.keys(libs).filter(k=>inheritedHashes.has(sha(libs[k])))){const altered={...libs,[key]:'export function transform(){throw new Error("HELPER_ABLATED");}'};const r=await backend.run({source,input:c.binary?Buffer.from(c.input,'base64'):c.input,libs:altered});ablations.push({helper:key,helperSha256:sha(libs[key]),status:r.status,error:r.error,dependsOnHelper:r.status!=='ok'||r.output!==rows.find(x=>x.id===c.id)?.output});}}
   save(path.join(dir,'score.json'),{rows,ablations});
   const passed=rows.filter(r=>r.pass).length;const dependency=stage!=='composition'||ablations.some(a=>a.dependsOnHelper);
   save(cell,{task:original.id,arm,stage:stage+'-attempt',status:'finished',claimed,correct:claimed&&rows.length>0&&passed===rows.length&&dependency,falseSuccess:claimed&&passed<rows.length,hidden:{passed,total:rows.length},compositionDependencyEstablished:stage==='composition'?dependency:undefined,costUsd,elapsedMs:Date.now()-start,evidence,sourceSha256:source?sha(source):null,ablations});
  }catch(error){save(cell,{task:original.id,arm,stage:stage+'-attempt',status:'incomplete',error:String(error),costUsd,elapsedMs:Date.now()-start});}
  console.log(JSON.stringify(read(cell)));
 }
}
