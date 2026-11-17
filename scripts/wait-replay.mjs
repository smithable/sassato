/** Replay sanitized role-directed notification timestamps; never reads a coordination database. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { DigestWindow,DIGEST_LIMIT } from '../dist/wait-digest.js';

export function replayWaitTrace(events,{settle=120,settleMax=600}={}) {
  assert.ok(Number.isSafeInteger(settle)&&settle>=0&&settle<=3600);
  assert.ok(Number.isSafeInteger(settleMax)&&settleMax>0&&settleMax<=3600);
  assert.ok(Array.isArray(events)&&events.length<=100_000);
  const ordered=events.map((event,i)=>{
    assert.ok(event&&typeof event.id==='string'&&Number.isFinite(event.at));
    assert.ok(event.wake===undefined||typeof event.wake==='boolean');
    assert.ok(event.immediate===undefined||typeof event.immediate==='boolean');
    return {...event,sequence:i};
  }).sort((a,b)=>a.at-b.at||a.sequence-b.sequence);
  const batches=[];let pending=[],window=new DigestWindow(settle,settleMax);
  const flush=(at,reason)=>{if(!pending.length)return;batches.push({at,reason,events:pending.map(e=>e.id),wake_events:pending.filter(e=>e.wake!==false).length,max_delay_ms:Math.max(...pending.map(e=>at-e.at))});pending=[];window=new DigestWindow(settle,settleMax);};
  for(const event of ordered) {
    if(pending.length&&event.at>window.deadline())flush(window.deadline(),window.reason(window.deadline()));
    if(!pending.length&&event.wake===false)continue;
    pending.push(event);window.add(event.at);
    if(!settle||event.immediate)flush(event.at,event.immediate?'immediate':'single-event');
    else if(pending.length>=DIGEST_LIMIT)flush(event.at,'capacity');
    else if(window.reason(event.at)==='max')flush(event.at,'max');
  }
  if(pending.length)flush(window.deadline(),window.reason(window.deadline()));
  const before=ordered.filter(e=>e.wake!==false).length,after=batches.length;
  return {events:ordered.length,before_wakes:before,after_wakes:after,reduction_percent:before?Math.round((before-after)/before*10000)/100:0,settle_seconds:settle,settle_max_seconds:settleMax,max_delay_ms:batches.reduce((max,b)=>Math.max(max,b.max_delay_ms),0),batches};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [path,settle='120',maximum='600']=process.argv.slice(2);assert.ok(path,'Usage: node scripts/wait-replay.mjs TRACE.json [SETTLE_SECONDS] [MAX_SECONDS]');
  const trace=JSON.parse(readFileSync(path,'utf8'));console.log(JSON.stringify(replayWaitTrace(trace.events??trace,{settle:Number(settle),settleMax:Number(maximum)}),null,2));
}
