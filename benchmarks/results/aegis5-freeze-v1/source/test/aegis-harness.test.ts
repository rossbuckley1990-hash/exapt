import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {safePath} from '../benchmarks/aegis5/terminal.ts';
import {tempDir,sandboxSkip} from './support.ts';

test('baseline workspace cannot escape or write public fixtures',()=>{
  const root=tempDir('aegis');
  assert.throws(()=>safePath(root,'../escape',true),/escapes/);
  assert.throws(()=>safePath(root,'/etc/passwd'),/relative/);
  assert.throws(()=>safePath(root,'examples/input.json',true),/writable/);
  fs.symlinkSync('/private/tmp',path.join(root,'out'));
  assert.throws(()=>safePath(root,'out/escape',true),/Symlinks/);
});

test('independent scoring rejects one-unit errors, unsafe integer rounding, duplicate keys and boolean/number substitution',()=>{
  const compare=(expected:string,actual:string)=>JSON.parse(spawnSync('python3',['benchmarks/aegis5/exact-score.py'],{input:JSON.stringify({mode:'json',expected,actual}),encoding:'utf8'}).stdout).equal;
  assert.equal(compare('{"v":1}','{"v":2}'),false);
  assert.equal(compare('{"v":9007199254740993}','{"v":9007199254740992}'),false);
  assert.equal(compare('{"v":1}','{"v":1,"v":1}'),false);
  assert.equal(compare('{"v":1}','{"v":true}'),false);
  assert.equal(compare('{"v":1,"b":2}','{"b":2,"v":1.0}'),true);
});

test('baseline MCP terminal executes only inside the constrained workspace', {skip:sandboxSkip},()=>{
  const dir=tempDir('aegis-terminal');const root=path.join(dir,'workspace');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'input.txt'),'public fixture');
  const calls=[
    {jsonrpc:'2.0',id:1,method:'initialize',params:{}},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'write',arguments:{path:'out/probe.mjs',text:"import fs from 'node:fs'; console.log(fs.readFileSync('input.txt','utf8')); fs.writeFileSync('out/probe.txt','saved');"}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'shell',arguments:{command:'node out/probe.mjs'}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'read',arguments:{path:'out/probe.txt'}}},
  ];
  const r=spawnSync(process.execPath,['benchmarks/aegis5/terminal.ts',root,path.join(dir,'tools.jsonl')],{input:calls.map(c=>JSON.stringify(c)).join('\n')+'\n',encoding:'utf8',timeout:120000});
  assert.equal(r.status,0,r.stderr);
  const replies=r.stdout.trim().split('\n').map(s=>JSON.parse(s));
  const shell=JSON.parse(replies.find(r=>r.id===3).result.content[0].text);
  assert.equal(shell.status,0,JSON.stringify(shell));assert.match(shell.stdout,/public fixture/);
  assert.equal(JSON.parse(replies.find(r=>r.id===4).result.content[0].text),'saved');
});
