import { check, integer } from './errors.js';

export const WAKE_SPEEDS = ['slow', 'normal', 'fast'] as const;
export type WakeSpeed = typeof WAKE_SPEEDS[number];
export type WakeMode = 'legacy' | 'scored';
export interface RoleWakePolicy {
  threshold?: number;
  urgent_seconds?: number;
  reply_seconds?: number;
}

const defaults = {threshold:10, urgent_seconds:120, reply_seconds:300};
const profiles = {
  slow:{threshold:2, age:3, idle:100, checkpoint:120, ping:5},
  normal:{threshold:1, age:1, idle:50, checkpoint:60, ping:2},
  fast:{threshold:0.5, age:0.3, idle:25, checkpoint:30, ping:1},
};

export function effectiveWakePolicy(speed:WakeSpeed, role:RoleWakePolicy = {}) {
  const base={...defaults,...role}, profile=profiles[speed];
  return {
    threshold:Math.ceil(base.threshold*profile.threshold),
    urgent_seconds:Math.max(1,Math.ceil(base.urgent_seconds*profile.age)),
    reply_seconds:Math.max(1,Math.ceil(base.reply_seconds*profile.age)),
    idle_minutes:profile.idle,
    checkpoint_minutes:profile.checkpoint,
    ping_minutes:profile.ping,
  };
}

export function validateRoleWakePolicy(value:unknown):RoleWakePolicy {
  check(value && typeof value==='object' && !Array.isArray(value),'A role wake policy must be an object');
  const policy:RoleWakePolicy={};
  for(const [key,setting] of Object.entries(value)) {
    check(key==='threshold'||key==='urgent_seconds'||key==='reply_seconds',`Unknown role wake setting: ${key}`);
    check(typeof setting==='number',`${key} must be a JSON integer`);
    policy[key]=integer(setting,key,1,key==='threshold'?Math.floor(Number.MAX_SAFE_INTEGER/2):2_147_483);
  }
  return policy;
}

export const WORKFLOW_WAKE_POINTS:Readonly<Record<string,number>> = {
  'task-finished':1,'review-approved':1,
  'task-assigned':3,'task-ready':3,'review-submitted':3,'blocker-resolved':3,
  'review-rejected':5,'blocker-assigned':5,'dependency-dropped':5,
};
export type EffectiveWakePolicy = ReturnType<typeof effectiveWakePolicy>;
export interface WakeScore {
  reason:'immediate'|'age'|'threshold'|'continuation'|'idle';
  total:number;
  threshold:number;
  speed:WakeSpeed;
  trigger?:string;
  immediate_cause?:'supervisor-ping'|'answer'|'now';
  age_limit_seconds?:number;
}
export interface ScoredItem {
  at:number;
  event:number;
  weight:number;
  immediate?:'supervisor-ping' | 'answer' | 'now';
}

/** Shared arithmetic for live delivery and metadata replays. The boundary is wall-clock time. */
export function scoredWake<T extends ScoredItem>(items:readonly T[],policy:EffectiveWakePolicy,now:number) {
  const total=items.reduce((sum,item)=>sum+item.weight,0);
  const immediate=items.find(item=>item.immediate==='supervisor-ping')??items.find(item=>item.immediate);
  let due=Infinity,oldest:T|undefined;
  for(const item of items) {
    if(item.weight<2)continue;
    const deadline=item.at+(item.weight>=5?policy.urgent_seconds:policy.reply_seconds)*1000;
    if(deadline<due){due=deadline;oldest=item;}
  }
  const trigger=immediate??(due<=now?oldest:undefined);
  const reason=immediate?'immediate':due<=now?'age':total>=policy.threshold?'threshold':undefined;
  return {total,threshold:policy.threshold,due,reason,trigger} as const;
}
