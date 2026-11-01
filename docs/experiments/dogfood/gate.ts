import fs from "node:fs"; import path from "node:path";
import { configFromEnv, Exapt } from "/Users/ross/EXAPT/packages/protocol/engine.ts";
import { Judge, mutationScore, type TestCase } from "/Users/ross/EXAPT/packages/experiment-engine/index.ts";
const SP="/private/tmp/claude-501/-Users-ross-EXAPT/89ac2e4f-b3ab-45ad-bbbb-ce80cac1ae83/scratchpad/dogfood";
const e = await Exapt.open(configFromEnv({} as any, { home: SP+"/home", programs: [], model: null }));
const runs = e.runs(20);
const overfit = runs.find(r=>r.capability?.id.includes("text-to-text"))!;
const v2 = runs.find(r=>r.capability?.version===2 && r.accepted)!;
const v1 = runs.find(r=>r.capability?.id==="exapt:text-to-ndjson-e52395" && r.capability?.version===1)!;
const names=fs.readdirSync(SP+"/corpus").filter(f=>f.endsWith(".tap")).map(f=>f.slice(0,-4)).sort();
const cases:TestCase[]=names.map((n,i)=>({id:n,tier:i%3===0?"visible":i%3===1?"independent":"holdout",input:fs.readFileSync(`${SP}/corpus/${n}.tap`,"utf8"),expected:fs.readFileSync(`${SP}/corpus/${n}.truth.ndjson`,"utf8"),origin:"corpus"} as TestCase));
cases.push({id:"m1",tier:"malformed",input:"%%% not tap",origin:"malformed",note:"not this format at all"} as TestCase,{id:"m2",tier:"malformed",input:"",origin:"malformed",note:"empty input"} as TestCase);
const judge=new Judge(e.universe,{...v2.contract!,oracles:[],consumer:null});
for (const [label,run] of [["v1 original",v1],["overfit quote hack",overfit],["v2 clean repair",v2]] as const){
  const src=e.vault.get(run.accepted!.sha256).toString("utf8");
  const s=await mutationScore(e.backend,judge,src,cases);
  console.log(label.padEnd(20),"value faults caught",s.value.killed+"/"+s.value.total,(s.value.killed/s.value.total).toFixed(2),"| all",s.killed+"/"+s.total);
}
// Do independently produced programs agree? Needs no truth at all.
const progs=[["v1",e.vault.get(v1.accepted!.sha256).toString("utf8")],["hack",e.vault.get(overfit.accepted!.sha256).toString("utf8")],["v2",e.vault.get(v2.accepted!.sha256).toString("utf8")]];
const inputs=[...names.map(n=>[n,fs.readFileSync(`${SP}/corpus/${n}.tap`,"utf8")]),...["b1"].map(n=>[n,fs.readFileSync(`${SP}/breakc/${n}.tap`,"utf8")]),["amb",fs.readFileSync(SP+"/amb.tap","utf8")],["z",fs.readFileSync(SP+"/final2c/z.tap","utf8")]];
for (const [n,text] of inputs){ const outs=[]; for(const [l,src] of progs){ const r=await e.backend.run({source:src,input:text}); outs.push(r.status==="ok"?r.output:"THROW:"+r.error); }
 const same=outs[0]===outs[1]&&outs[1]===outs[2]; if(!same){ const rows=outs.map(o=>String(o).trim().split("\n")); const k=Math.max(...rows.map(r=>r.length)); for(let i=0;i<k;i++){ if(rows[0][i]!==rows[1][i]||rows[1][i]!==rows[2][i]){ console.log("DISAGREE",n,"row",i+1,"\n   v1  ",String(rows[0][i]).slice(0,100),"\n   hack",String(rows[1][i]).slice(0,100),"\n   v2  ",String(rows[2][i]).slice(0,100)); break; } } } }
await e.host.rc.flush();
