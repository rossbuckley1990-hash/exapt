import assert from 'node:assert/strict';
import test from 'node:test';
import { verify } from '../packages/verification/index.ts';
import { sniff, type Universe } from '../packages/capability-universe/index.ts';
import type { BehaviouralContract, TestBench, TestCase, Tier } from '../packages/experiment-engine/index.ts';

for (const [name,held,level] of [
  ['one holdout', ['held-a'], 'passed-holdout'],
  ['three copies of one holdout', ['held-a','held-a','held-a'], 'passed-holdout'],
  ['three distinct holdouts', ['held-a','held-b','held-c'], 'verified-in-domain'],
] as const) test(`verification requires distinct independent inputs: ${name}`, async () => {
  const cases=(tier:Tier,inputs:readonly string[]):TestCase[]=>inputs.map((input,i)=>({id:`${tier}-${i}`,tier,input,expected:input,origin:'corpus'}));
  const bench={visible:async()=>cases('visible',['shown']), independent:async()=>cases('independent',['independent']), boundary:async()=>[], malformed:()=>[], holdout:async()=>cases('holdout',held),describeDomain:()=>['test fixture'],limitations:[] } as unknown as TestBench;
  const contract={inputKind:'text',source:{repr:sniff('text'),sample:'text'},target:{repr:sniff('text'),sample:'text'},consumer:null,oracles:[],properties:[]} as unknown as BehaviouralContract;
  const result=await verify({universe:{} as Universe,contract,bench,source:'export function transform(input) { return input; }',producer:'test-double',kind:'test-double',seed:1,
    backend:{name:'nonexecuting-test-double',enforces:[],notEstablished:['test only'],run:async req=>({status:'ok',output:String(req.input),ms:0})}});
  assert.equal(result.level,level);
  if(level==='passed-holdout') assert.match(result.limitations.join(' '),/at least 3 are required/);
});
