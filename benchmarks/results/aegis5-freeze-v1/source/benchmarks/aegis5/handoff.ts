// Fresh real agent sessions with no original conversation. Hidden expected values never enter MCP.
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {codingAgent} from './agent.ts';import {checkFreeze,ROOT} from './freeze.ts';
const argv=process.argv.slice(2);const opt=(n:string,d='')=>{const i=argv.indexOf('--'+n);return i<0?d:argv[i+1];};
const results=path.resolve(opt('out'));const publicRoot=path.resolve(opt('public'));const sealed=path.resolve(opt('sealed','/private/tmp/exapt-aegis5-sealed'));const manifest=path.resolve(opt('freeze'));checkFreeze(manifest);
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const save=(p:string,v:unknown)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2));};
const spent=()=>{let total=0;const walk=(d:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()&&!['home','workspace','public'].includes(e.name))walk(p);else if(e.name==='cell.json'){const c=read(p);total+=typeof c.costUsd==='number'?c.costUsd:0.6;}}};walk(results);return total;};
for(const name of fs.readdirSync(publicRoot).filter(n=>fs.existsSync(path.join(publicRoot,n,'task.json'))).sort()){
 const task=read(path.join(publicRoot,name,'task.json'));
 for(const arm of ['B','D']){
  checkFreeze(manifest);const cold=path.join(results,task.id,arm,'cold');const dir=path.join(results,task.id,arm,'handoff');const cell=path.join(dir,'cell.json');if(fs.existsSync(cell))continue;
  const old=fs.existsSync(path.join(cold,'cell.json'))?read(path.join(cold,'cell.json')):null;
  if(!old?.claimed){save(cell,{task:task.id,arm,stage:'handoff',status:'blocked-by-cold',costUsd:0});continue;}
  if(spent()+0.6>10){save(cell,{task:task.id,arm,stage:'handoff',status:'budget-blocked',costUsd:0});continue;}
  const c=read(path.join(sealed,task.id,'cases.json')).find((c:any)=>c.phase==='warm'&&c.expect==='output');
  if(!c){save(cell,{task:task.id,arm,stage:'handoff',status:'no-warm-case',costUsd:0});continue;}
  const workspace=path.join(dir,'workspace');fs.mkdirSync(path.join(workspace,'previous'),{recursive:true});fs.mkdirSync(path.join(workspace,'out'),{recursive:true});
  const input=path.join(workspace,c.binary?'input.bin':'input.txt');const output=path.join(workspace,'out/result.txt');fs.writeFileSync(input,c.binary?Buffer.from(c.input,'base64'):c.input);
  const id=arm==='D'?read(path.join(cold,'manifest.json')).id:undefined;
  const home=path.join(dir,'home');if(arm==='D')fs.cpSync(path.join(cold,'home'),home,{recursive:true});else fs.copyFileSync(path.join(cold,'candidate.mjs'),path.join(workspace,'previous/capability.mjs'));
  save(cell,{task:task.id,arm,stage:'handoff',status:'started',costUsd:null});
  const prompt=arm==='D'?`You are a fresh agent with no earlier conversation. Discover the retained EXAPT capability that performs: ${task.intent}. Explain its scope if needed, and use it on ${input}. Write the exact result to ${output} using exapt_use output_path. Do not invent or regenerate code. No model-powered synthesis is available. End with DONE only if the operation completed; otherwise report the limitation.`:`You are a fresh coding-agent session. A previous session saved previous/capability.mjs exporting transform(input,lib). Reuse it to perform: ${task.intent}. Input is ${path.basename(input)} (${c.binary?'binary Buffer':'UTF-8 text'}). Use the aegis terminal to run the saved code and write the exact returned result to out/result.txt. Do not regenerate the original solution. Report limitations honestly.`;
  try{
   const server=arm==='D'?{name:'exapt',command:process.execPath,args:[path.join(ROOT,'apps/cli/exapt.ts'),'mcp'],env:{EXAPT_HOME:home,EXAPT_MODEL:'none',EXAPT_PROGRAMS:'',EXAPT_DATA_ROOTS:workspace,EXAPT_MCP_LOG:path.join(dir,'tools.jsonl')},tools:['exapt_discover','exapt_memory','exapt_explain','exapt_use']}:undefined;
   const session=await codingAgent(path.join(dir,'agent'),workspace,prompt,opt('model','sonnet'),0.6,server);
   const actual=fs.existsSync(output)?fs.readFileSync(output,'utf8'):null;
   const scored=actual===null?{equal:false}:JSON.parse(spawnSync('python3',[path.join(import.meta.dirname,'exact-score.py')],{input:JSON.stringify({mode:task.comparison,expected:c.expected,actual}),encoding:'utf8'}).stdout);
   const log=arm==='D'?path.join(dir,'tools.jsonl'):path.join(dir,'agent/tools.jsonl');
   const calls=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
   save(cell,{task:task.id,arm,stage:'handoff',status:'finished',correct:scored.equal,caseId:c.id,costUsd:session.costUsd,session,toolCalls:calls.length,tools: calls.map(c=>c.tool??c.name),originalConversation:false,regenerationToolsAvailable:arm==='D'?false:'terminal available; inspect recorded calls',actual});
  }catch(error){save(cell,{task:task.id,arm,stage:'handoff',status:'incomplete',error:String(error),costUsd:null});}
  console.log(JSON.stringify(read(cell)));
 }
}
