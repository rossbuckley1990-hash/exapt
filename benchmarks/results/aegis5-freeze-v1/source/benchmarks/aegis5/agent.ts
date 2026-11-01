import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface AgentResult { exit:number|null; elapsedMs:number; costUsd:number|null; inputTokens:number|null; outputTokens:number|null; turns:number|null; error?:string; modelUsage?:unknown; permissionDenials?:unknown }

export async function codingAgent(dir:string,workspace:string,prompt:string,model:string,cap=0.6,server?:{name:string;command:string;args:string[];env?:Record<string,string>;tools:string[]}):Promise<AgentResult>{
  fs.mkdirSync(dir,{recursive:true});
  const terminal=path.resolve(import.meta.dirname,'terminal.ts');
  const chosen=server??{name:'aegis',command:process.execPath,args:[terminal,workspace,path.join(dir,'tools.jsonl')],tools:['list','read','write','shell']};
  const config=path.join(dir,'mcp.json');
  fs.writeFileSync(config,JSON.stringify({mcpServers:{[chosen.name]:{command:chosen.command,args:chosen.args,...(chosen.env?{env:chosen.env}:{})}}},null,2));
  fs.writeFileSync(path.join(dir,'prompt.txt'),prompt);
  const cwd=path.join(dir,'empty-client');fs.mkdirSync(cwd,{recursive:true});
  const args=['-p','--output-format','json','--model',model,'--tools','','--strict-mcp-config','--mcp-config',config,'--setting-sources','','--no-session-persistence','--max-turns','8','--max-budget-usd',String(cap),'--allowedTools',...chosen.tools.map(t=>`mcp__${chosen.name}__${t}`)];
  fs.writeFileSync(path.join(dir,'invocation.json'),JSON.stringify({command:'claude',args,cwd,cap},null,2));
  const start=Date.now();
  const raw=await new Promise<{exit:number|null;stdout:string;stderr:string;error?:string}>(resolve=>{
    const p=spawn('claude',args,{cwd,env:process.env,stdio:['pipe','pipe','pipe'],detached:true});let stdout='',stderr='',error:string|undefined;
    const stop=(reason:string)=>{error=reason;try{process.kill(-p.pid!,'SIGKILL');}catch{p.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop('10-minute trial timeout'),600000);
    p.stdout.on('data',d=>{stdout+=d;if(stdout.length>8*1024*1024)stop('client output limit');});
    p.stderr.on('data',d=>{stderr+=d;if(stderr.length>1024*1024)stop('client stderr limit');});
    p.stdin.on('error',()=>{});p.stdin.end(prompt);
    p.on('error',e=>{clearTimeout(timer);resolve({exit:null,stdout,stderr,error:String(e)});});
    p.on('close',exit=>{clearTimeout(timer);resolve({exit,stdout,stderr,...(error?{error}:{})});});
  });
  fs.writeFileSync(path.join(dir,'response.json'),raw.stdout);fs.writeFileSync(path.join(dir,'stderr.txt'),raw.stderr);
  let b:any;try{b=JSON.parse(raw.stdout);}catch{}
  const u=b?.usage;
  const result:AgentResult={exit:raw.exit,elapsedMs:Date.now()-start,costUsd:typeof b?.total_cost_usd==='number'?b.total_cost_usd:null,inputTokens:u?(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0):null,outputTokens:u?.output_tokens??null,turns:b?.num_turns??null,modelUsage:b?.modelUsage,permissionDenials:b?.permission_denials,...(raw.error||b?.is_error?{error:raw.error??String(b.result??b.subtype)}:{})};
  fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify(result,null,2));return result;
}
