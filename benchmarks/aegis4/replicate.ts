import fs from 'node:fs';
import path from 'node:path';
import { demo4 } from '../../demos/invariant-telemetry/run.ts';
import { RecordedModel } from '../aegis5/recorded-model.ts';

const dir=path.resolve(process.argv[2]??`benchmarks/results/aegis4-replication-${Date.now()}`);
if(fs.existsSync(dir))throw new Error('Refusing to overwrite a trial');
fs.mkdirSync(dir,{recursive:true});
const model=new RecordedModel(path.join(dir,'transcript'),process.env.AEGIS_MODEL??'sonnet',0.6,6);
const start=Date.now();
try {
  const result=await demo4({dir,seed:2026,engineConfig:{model,budget:{maxCalls:6,maxTokens:80000,maxCostUsd:0.6},strategy:'auto'}});
  fs.writeFileSync(path.join(dir,'replication.json'),JSON.stringify({result,elapsedMs:Date.now()-start,modelCalls:model.calls,reportedCostUsd:model.spent,scope:'Replication on strengthened verification and expanded corpus, not an exact replay of the unpinned historical checkout'},null,2));
  process.exitCode=result.ok?0:1;
} catch(error) {
  fs.writeFileSync(path.join(dir,'replication.json'),JSON.stringify({error:String(error),elapsedMs:Date.now()-start,modelCalls:model.calls,reportedCostUsd:model.spent},null,2));
  console.error(error);process.exitCode=1;
}
