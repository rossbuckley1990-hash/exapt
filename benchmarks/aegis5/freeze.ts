import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
export const ROOT=path.resolve(import.meta.dirname,'../..');
const directories=['packages','apps','vendor','demos','scripts','test','benchmarks/aegis5'];
const singles=['package.json','package-lock.json','tsconfig.json','LICENSE','NOTICE','README.md'];
export function currentFiles(root=ROOT):Array<{path:string;sha256:string}>{
  const files:Array<{path:string;sha256:string}>=[];
  const walk=(rel:string)=>{const full=path.join(root,rel);if(!fs.existsSync(full))return;const s=fs.lstatSync(full);if(s.isSymbolicLink())throw new Error(`Source symlink not permitted: ${rel}`);if(s.isDirectory()){for(const n of fs.readdirSync(full).sort())if(!['node_modules','.git'].includes(n))walk(path.join(rel,n));}else if(s.isFile())files.push({path:rel,sha256:sha(fs.readFileSync(full))});};
  for(const rel of [...directories,...singles])walk(rel);return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export function checkFreeze(manifest:string,root=ROOT):void{
  const frozen=JSON.parse(fs.readFileSync(manifest,'utf8'));
  for(const f of frozen.files){const full=path.join(root,f.path);if(!fs.existsSync(full)||sha(fs.readFileSync(full))!==f.sha256)throw new Error(`Frozen source changed: ${f.path}`);}
}
export function freeze(destination:string){
  destination=path.resolve(destination);if(fs.existsSync(destination))throw new Error('Do not replace an existing freeze');fs.mkdirSync(destination,{recursive:true});
  const files=currentFiles();
  for(const f of files){const target=path.join(destination,'source',f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(ROOT,f.path),target);}
  const digest=sha(JSON.stringify(files));
  const manifest={format:'exapt/aegis5-freeze@1',at:new Date().toISOString(),sha256:digest,head:spawnSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).stdout.trim(),dirty:spawnSync('git',['status','--short'],{cwd:ROOT,encoding:'utf8'}).stdout,files};
  fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2));checkFreeze(path.join(destination,'manifest.json'),path.join(destination,'source'));
  console.log(JSON.stringify({destination,sha256:digest,files:files.length}));return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename))freeze(process.argv[2]);
