// One engine trial per process so wall-clock limits terminate model and container clients too.
import fs from 'node:fs';import path from 'node:path';
import {Exapt,configFromEnv} from '../../packages/protocol/engine.ts';
import {RecordedModel} from './recorded-model.ts';import {SerialDockerBackend} from './serial-backend.ts';
const [dir,workspace,modelName]=process.argv.slice(2);
const task=JSON.parse(fs.readFileSync(path.join(workspace,'task.json'),'utf8'));
const model=new RecordedModel(path.join(dir,'transcript'),modelName,0.6,8);
const e=await Exapt.open(configFromEnv({}, {home:path.join(dir,'home'),programs:[],model,strategy:'auto',backend:new SerialDockerBackend({attestation:path.join(dir,'sandbox-attestation.json')}),budget:{maxCalls:8,maxTokens:120000,maxCostUsd:0.6}}));
const save=(name:string,value:unknown)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2));
try{
 const ref=(file:string)=>({path:path.join(workspace,file)});
 const run=await e.startInvention({id:task.id,intent:task.intent+'\n'+task.instructions,have:{samples:[ref(task.examples[0].input)]},want:{sample:ref(task.targetSample)},corpus:task.examples.map((p:any,i:number)=>({name:`public-${i}`,input:ref(p.input),truth:ref(p.truth)}))},workspace,{seed:20261101});
 save('run.json',run);
 const manifest=run.capability?e.vault.manifest(run.capability.id):undefined;
 let source:string|undefined;const libs:Record<string,string>={};
 if(manifest){
  save('manifest.json',manifest);source=e.vault.source(manifest);fs.writeFileSync(path.join(dir,'generated.mjs'),source);
  for(const d of manifest.dependencies)if(d.kind==='capability'){const m=e.vault.manifest(d.id,d.version);if(m)libs[d.id]=e.vault.source(m);}
  // Independent scoring must execute the completed route, not feed raw input to its last step.
  if(run.workflow?.ok&&run.workflow.steps.length>1){
   const steps=run.workflow.steps.map(s=>s.tool);let complete=true;
   for(const id of steps){const m=e.vault.manifest(id);if(!m){complete=false;break;}libs[id]=e.vault.source(m);for(const d of m.dependencies)if(d.kind==='capability'){const dep=e.vault.manifest(d.id,d.version);if(dep)libs[d.id]=e.vault.source(dep);}}
   if(complete)source=`export async function transform(input,lib){let value=input;for(const id of ${JSON.stringify(steps)})value=await lib[id](value,lib);return value;}\n`;
   else throw new Error('Scoring a route with native programs is not implemented; no partial-route success claimed');
  }
 }
 if(source)fs.writeFileSync(path.join(dir,'candidate.mjs'),source);save('libs.json',libs);
 save('engine-result.json',{claimed:run.status==='completed'&&run.capability?.status==='verified-within-scope'&&run.workflow?.ok===true,costUsd:model.unknownCosts?null:model.spent,reportedCostUsd:model.spent,modelCalls:model.calls,evidence:{run:run.id,status:run.status,outcome:run.outcome,evidence:run.evidence,capability:run.capability}});
}catch(error){save('engine-result.json',{claimed:false,error:String(error),costUsd:model.unknownCosts?null:model.spent,reportedCostUsd:model.spent,modelCalls:model.calls});process.exitCode=1;}
finally{await e.host.rc.flush();}
