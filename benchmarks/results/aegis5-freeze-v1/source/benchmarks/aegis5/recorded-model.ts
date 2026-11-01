// Research-only capture. Prompts contain the challenge's public fixtures, never credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ClaudeCli, type ModelAdapter, type CompletionRequest, type Completion } from '../../packages/model-adapters/index.ts';

export class RecordedModel implements ModelAdapter {
  readonly provider = 'claude-cli';
  readonly real = true;
  readonly model: string;
  readonly dir: string;
  readonly cap: number;
  readonly maxCalls: number;
  spent = 0;
  calls = 0;
  unknownCosts = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dir:string,model:string,cap=0.6,maxCalls=8) {
    this.dir=dir;this.model=model;this.cap=cap;this.maxCalls=maxCalls;fs.mkdirSync(dir,{recursive:true});
  }
  complete(req:CompletionRequest):Promise<Completion> {
    const work=this.queue.then(async()=>{
      if(this.calls>=this.maxCalls || this.spent>=this.cap) throw new Error('Research trial model budget exhausted');
      const id=++this.calls;
      const record:{[k:string]:unknown}={id,at:new Date().toISOString(),request:req,capRemainingUsd:this.cap-this.spent};
      const save=()=>{const bytes=JSON.stringify(record,null,2)+'\n';fs.writeFileSync(path.join(this.dir,`${id}.json`),bytes);fs.writeFileSync(path.join(this.dir,`${id}.sha256`),createHash('sha256').update(bytes).digest('hex')+'\n');};
      save();
      try {
        const reply=await new ClaudeCli({model:this.model,maxBudgetUsd:this.cap-this.spent,timeoutMs:240000}).complete(req);
        record.reply=reply;this.spent+=reply.usage.costUsd??0;record.totalReportedCostUsd=this.spent;save();return reply;
      } catch(error) {
        this.unknownCosts=true;
        record.error=String(error);record.usage='unavailable if provider returned an error; do not count as zero';save();throw error;
      }
    });
    this.queue=work.catch(()=>{});return work;
  }
}
