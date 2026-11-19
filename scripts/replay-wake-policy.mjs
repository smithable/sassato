// Replay timestamped routing metadata through the built score and age rules. No database writes.
import { readFileSync } from 'node:fs';
import { effectiveWakePolicy, scoredWake, WAKE_SPEEDS, WORKFLOW_WAKE_POINTS } from '../dist/wake-policy.js';

const { start, end, paused = false, trace } = JSON.parse(readFileSync(0, 'utf8'));
const first=Date.parse(start),last=Date.parse(end);
if(!Number.isFinite(first)||!Number.isFinite(last)||first>=last||!Array.isArray(trace))
  throw new Error('Expected start, end and a metadata trace');
const immediateKinds={now:'now',answer:'answer',ping:'supervisor-ping'};
const eventWeight={mail:1,urgent:5,'reply-needed':3,...WORKFLOW_WAKE_POINTS};

function replay(speed) {
  const policy=effectiveWakePolicy(speed),idleMs=policy.idle_minutes*60_000;
  const pending=new Map(),counts={};
  let now=first,idleAt=now+idleMs,stopped=paused,eligible=false,sequence=0;
  const count=reason=>{counts[reason]=(counts[reason]??0)+1;};
  const score=()=>scoredWake([...pending.values()],policy,now);
  const deliver=reason=>{count(reason);pending.clear();idleAt=now+idleMs;};
  const turn=()=>{
    if(stopped)return;
    const reason=score().reason;
    if(reason)deliver(reason);
    else if(now>=idleAt){
      if(eligible)deliver('idle');
      else idleAt=now+idleMs;
    }
  };
  let offset=0;
  while(offset<=trace.length){
    const at=offset===trace.length?last:Date.parse(trace[offset][0]);
    if(!Number.isFinite(at)||at<now||at>last)throw new Error('Trace must be ordered and inside its time range');
    for(let due=Math.min(score().due,idleAt);!stopped&&due<at;due=Math.min(score().due,idleAt)){
      now=Math.max(now,due);turn();
    }
    if(at===last)break;
    now=at;
    while(offset<trace.length&&Date.parse(trace[offset][0])===at){
      const [,kind,id,weight]=trace[offset++];
      if(kind==='requested'){if(!stopped)count('stop');stopped=true;continue;}
      if(kind==='cleared'){stopped=false;idleAt=now+idleMs;continue;}
      if(kind==='eligible'||kind==='ineligible'){eligible=kind==='eligible';continue;}
      if(kind==='write'){idleAt=now+idleMs;continue;}
      if(kind==='ack'){for(const [key,item] of pending)if(item.id===id)pending.delete(key);continue;}
      const immediate=Object.hasOwn(immediateKinds,kind)?immediateKinds[kind]:undefined;
      const w=weight??(Object.hasOwn(eventWeight,kind)?eventWeight[kind]:immediate?0:undefined);
      if(!Number.isInteger(w)||w<0||w>10)throw new Error(`Unknown or invalid trace weight: ${kind}`);
      const key=JSON.stringify([kind,id]);
      if(!pending.has(key))pending.set(key,{id,at,event:++sequence,weight:w,immediate});
    }
    turn();
  }
  return {total:Object.values(counts).reduce((sum,n)=>sum+n,0),counts};
}

console.log(JSON.stringify(Object.fromEntries(WAKE_SPEEDS.map(speed=>[speed,replay(speed)]))));
