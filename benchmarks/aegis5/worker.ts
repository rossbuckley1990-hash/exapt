import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
export async function engineWorker(dir:string,workspace:string,model:string):Promise<{exit:number|null;error?:string}>{
 return new Promise(resolve=>{
  const p=spawn(process.execPath,[path.join(import.meta.dirname,'engine-trial.ts'),dir,workspace,model],{stdio:['ignore','pipe','pipe'],detached:true});
  const out=fs.createWriteStream(path.join(dir,'worker.stdout.txt'));const err=fs.createWriteStream(path.join(dir,'worker.stderr.txt'));p.stdout.pipe(out);p.stderr.pipe(err);
  let error:string|undefined;const timer=setTimeout(()=>{error='10-minute trial timeout';try{process.kill(-p.pid!,'SIGKILL');}catch{p.kill('SIGKILL');}},600000);
  p.on('error',e=>{clearTimeout(timer);resolve({exit:null,error:String(e)});});
  p.on('close',exit=>{clearTimeout(timer);resolve({exit,...(error?{error}:{})});});
 });
}
