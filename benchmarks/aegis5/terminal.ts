// The baseline's terminal is inside the same disposable Docker boundary as EXAPT candidates.
// No model command is ever passed to a host shell. Workspace files travel over stdin.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DockerBackend } from '../../packages/execution/index.ts';

const MAX_BYTES=8*1024*1024;
const SHELL=`export async function transform(envelope) {
  const fs=await import('node:fs'); const path=await import('node:path'); const cp=await import('node:child_process');
  const request=JSON.parse(envelope); const root='/tmp/workspace'; fs.mkdirSync(root,{recursive:true});
  for(const [name,data] of Object.entries(request.files)) {
    const file=path.resolve(root,name); if(!file.startsWith(root+'/')) throw new Error('path escapes workspace');
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,Buffer.from(data,'base64'));
  }
  const r=cp.spawnSync('/bin/sh',['-c',request.command],{cwd:root,encoding:'utf8',timeout:6000,maxBuffer:1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,TMPDIR:'/tmp'}});
  const files={};let size=0;
  const walk=(dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const p=path.join(dir,entry.name); if(entry.isDirectory())walk(p);else if(entry.isFile()) {
      const stat=fs.statSync(p);size+=stat.size;if(size>8388608)throw new Error('workspace exceeds 8MiB');
      const name=path.relative(root,p);if(name.startsWith('out/')||name.startsWith('work/')) files[name]=fs.readFileSync(p).toString('base64');
    }
  }}; walk(root);
  return JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout?.slice(0,12000),stderr:r.stderr?.slice(0,12000),files});
}`;

export function safePath(root:string,name:string,writable=false):string {
  if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\0'))throw new Error('Use a relative workspace path');
  const full=path.resolve(root,name);
  if(!full.startsWith(path.resolve(root)+path.sep))throw new Error('Path escapes workspace');
  if(writable&&!['out','work'].includes(path.relative(root,full).split(path.sep)[0]))throw new Error('Only out/ and work/ are writable');
  let cursor=full;
  while(cursor!==root){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw new Error('Symlinks are not permitted');cursor=path.dirname(cursor);}
  return full;
}

const definitions=[
  {name:'list',description:'List files in the isolated task workspace.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'read',description:'Read a public fixture or a saved script. Binary files can be read as base64.',inputSchema:{type:'object',properties:{path:{type:'string'},encoding:{type:'string',enum:['utf8','base64']}},required:['path'],additionalProperties:false}},
  {name:'write',description:'Write a file under out/ or work/. Submit out/capability.mjs exporting transform(input,lib) and out/RESULT.json with status done or not-possible.',inputSchema:{type:'object',properties:{path:{type:'string'},text:{type:'string'}},required:['path','text'],additionalProperties:false}},
  {name:'shell',description:'Run a shell command in a disposable Node 22 Linux container with no network, no host files or credentials, 256MiB RAM, one CPU, 32 processes, and 8s total timeout. Public inputs are staged in the workspace; only out/ and work/ changes persist. Node standard modules and ordinary Linux commands are available.',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}},
];

export async function terminal(root:string,log:string):Promise<void>{
  root=path.resolve(root);fs.mkdirSync(path.join(root,'out'),{recursive:true});fs.mkdirSync(path.join(root,'work'),{recursive:true});
  const backend=new DockerBackend({attestation:path.join(path.dirname(root),'terminal-attestation.json')});
  let calls=0;
  const files=()=>{const result:Record<string,string>={};let total=0;const walk=(dir:string)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);if(e.isSymbolicLink())throw new Error('Symlink in workspace');if(e.isDirectory())walk(p);else if(e.isFile()){const b=fs.readFileSync(p);total+=b.length;if(total>MAX_BYTES)throw new Error('Workspace exceeds 8MiB');result[path.relative(root,p)]=b.toString('base64');}
  }};walk(root);return result;};
  const invoke=async(name:string,a:Record<string,any>)=>{
    if(++calls>80)throw new Error('80-call trial tool budget exhausted');
    if(name==='list')return Object.keys(files());
    if(name==='read'){const b=fs.readFileSync(safePath(root,a.path));if(b.length>256*1024)throw new Error('Read limited to 256KiB; inspect with shell');return b.toString(a.encoding==='base64'?'base64':'utf8');}
    if(name==='write'){if(typeof a.text!=='string'||Buffer.byteLength(a.text)>1024*1024)throw new Error('File is not text or exceeds 1MiB');const p=safePath(root,a.path,true);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,a.text);return {written:a.path,bytes:Buffer.byteLength(a.text)};}
    if(name==='shell'){
      if(typeof a.command!=='string'||a.command.length>20000)throw new Error('Invalid command');
      const r=await backend.run({source:SHELL,input:JSON.stringify({files:files(),command:a.command})});
      if(r.status!=='ok')return r;
      const output=JSON.parse(r.output!);let size=0;
      for(const [name,data] of Object.entries(output.files??{})){const file=safePath(root,name,true);if(typeof data!=='string')throw new Error('Invalid file data');const b=Buffer.from(data,'base64');size+=b.length;if(size>MAX_BYTES)throw new Error('Returned files exceed limit');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b);}
      const {files:changed,...rest}=output;return {...rest,changed:Object.keys(changed??{})};
    }
    throw new Error('Unknown tool');
  };
  const handle=async(msg:any)=>{
    if(msg.id===undefined)return;
    let response:any;
    if(msg.method==='initialize')response={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'aegis',version:'1.0.0'}};
    else if(msg.method==='tools/list')response={tools:definitions};
    else if(msg.method==='ping')response={};
    else if(msg.method==='tools/call'){
      const at=new Date().toISOString();const start=Date.now();
      try{const result=await invoke(msg.params.name,msg.params.arguments??{});response={content:[{type:'text',text:JSON.stringify(result)}]};fs.appendFileSync(log,JSON.stringify({at,name:msg.params.name,args:msg.params.arguments,result,ms:Date.now()-start})+'\n');}
      catch(error){response={isError:true,content:[{type:'text',text:String(error)}]};fs.appendFileSync(log,JSON.stringify({at,name:msg.params.name,args:msg.params.arguments,error:String(error),ms:Date.now()-start})+'\n');}
    } else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}})+'\n');return;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:response})+'\n');
  };
  const lines=readline.createInterface({input:process.stdin});let queue=Promise.resolve();
  for await(const line of lines){if(!line.trim())continue;const msg=JSON.parse(line);queue=queue.then(()=>handle(msg));}
  await queue;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)) await terminal(process.argv[2],process.argv[3]);
