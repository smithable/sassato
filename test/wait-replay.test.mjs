import test from 'node:test';
import assert from 'node:assert/strict';
import { replayWaitTrace } from '../scripts/wait-replay.mjs';
test('timestamp replay batches bursts, includes ordinary updates only while collecting, and flushes quiet gaps',()=>{
  const trace=[{id:'old ordinary',at:0,wake:false},{id:'E1',at:1000},{id:'M2',at:2000,wake:false},{id:'E3',at:3000},{id:'E4',at:200_000}];
  const result=replayWaitTrace(trace);assert.equal(result.before_wakes,3);assert.equal(result.after_wakes,2);
  assert.deepEqual(result.batches[0].events,['E1','M2','E3']);assert.equal(result.batches[0].at,123_000);
});
test('timestamp replay observes hard maximum and immediate preemption',()=>{
  const trace=[0,90_000,180_000,270_000,360_000,450_000,540_000,630_000].map((at,i)=>({id:'E'+i,at}));
  const result=replayWaitTrace(trace);assert.equal(result.batches[0].reason,'max');assert.equal(result.batches[0].at,600_000);
  const immediate=replayWaitTrace([{id:'urgent',at:0},{id:'answer',at:3000,immediate:true},{id:'next',at:4000}]);
  assert.equal(immediate.after_wakes,2);assert.equal(immediate.batches[0].at,3000);assert.equal(immediate.batches[0].reason,'immediate');
});
test('timestamp replay pages bounded batches and supports explicit first-event baseline',()=>{
  const trace=Array.from({length:105},(_,i)=>({id:'E'+i,at:i}));
  const batched=replayWaitTrace(trace);assert.deepEqual(batched.batches.map(b=>b.events.length),[100,5]);assert.equal(batched.batches[0].reason,'capacity');
  assert.equal(replayWaitTrace(trace,{settle:0}).after_wakes,105);
});
test('timestamp replay rejects malformed settings and trace fields',()=>{
  assert.throws(()=>replayWaitTrace([{id:'E1',at:NaN}]));assert.throws(()=>replayWaitTrace([{id:'E1',at:0,immediate:'yes'}]));
  assert.throws(()=>replayWaitTrace([],{settle:-1}));assert.throws(()=>replayWaitTrace([],{settleMax:0}));
});
