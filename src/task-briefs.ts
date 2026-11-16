import { createHash,randomUUID } from 'node:crypto';
import { type Store,type Row } from './storage.js';
import { check,id,integer,now,safe,text } from './errors.js';
import { currentBinding,inspectCheckout,registeredCheckout } from './checkouts.js';
import { dirtyManifest } from './dirty-manifest.js';
import { getNotificationProgress } from './notification-progress.js';
import { assertWorkAllowed } from './control.js';
import { assertPhysicalIdentity } from './repository-identity.js';

export interface BriefInput {
  version:1; objective:string; acceptance:string[]; decisions:{decision:string;source:string}[];
  open_issues:string[]; validation:{command:string;result:string}[]; artifacts:string[]; next_action:string;
  configuration:{digest:string;provenance:string[]};
  jobs:{id:string;state:'completed'|'failed'|'stopped';evidence:string}[];
}
export function validateBriefInput(value:unknown):BriefInput {
  check(value && typeof value==='object' && !Array.isArray(value),'Brief must be an object');
  const v=value as Row;
  check(Object.keys(v).every(key=>['version','objective','acceptance','decisions','open_issues','validation','artifacts','next_action','configuration','jobs'].includes(key)),'Unknown brief field');
  check(v.version===1,'Brief version must be 1');safe(value);
  check(Buffer.byteLength(JSON.stringify(value))<=32768,'Brief exceeds 32768 bytes');
  text(v.objective,'objective',4000);text(v.next_action,'next action',4000);
  const array=(value:unknown,label:string):unknown[]=>{check(Array.isArray(value) && value.length<=100,`${label} must be an array with at most 100 entries`);return value;};
  for(const key of ['acceptance','open_issues','artifacts'])for(const entry of array(v[key],key))text(entry,key,2000);
  check(v.acceptance.length>0,'Brief needs acceptance criteria');
  for(const entry of array(v.decisions,'decisions')) {
    check(entry && typeof entry==='object' && Object.keys(entry).every(key=>['decision','source'].includes(key)),'Invalid decision entry');
    text((entry as Row).decision,'decision',2000);text((entry as Row).source,'decision source',2000);
  }
  for(const entry of array(v.validation,'validation')) {
    check(entry && typeof entry==='object' && Object.keys(entry).every(key=>['command','result'].includes(key)),'Invalid validation entry');
    text((entry as Row).command,'validation command',1000);text((entry as Row).result,'validation result',2000);
  }
  check(v.configuration && typeof v.configuration==='object' && Object.keys(v.configuration).every(key=>['digest','provenance'].includes(key)),'Invalid configuration evidence');
  check(typeof v.configuration.digest==='string' && /^[a-f0-9]{64}$/.test(v.configuration.digest),'Configuration digest must be SHA-256');
  const provenance=array(v.configuration.provenance,'configuration provenance');check(provenance.length>0,'Configuration provenance is required');
  provenance.forEach(value=>text(value,'configuration provenance',2000));
  const seen=new Set<string>();
  for(const entry of array(v.jobs,'jobs')) {
    check(entry && typeof entry==='object' && Object.keys(entry).every(key=>['id','state','evidence'].includes(key)),'Invalid settled job entry');
    const job=entry as Row;text(job.id,'job id',100);check(!seen.has(job.id),'Duplicate job id');seen.add(job.id);
    check(['completed','failed','stopped'].includes(job.state),'Running or unknown jobs block handover');text(job.evidence,'settled job evidence',2000);
  }
  return v as BriefInput;
}
const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function captureAndSaveBrief(s:Store,taskId:string,input:unknown,expectedVersion:number,intent?:{to:string;summary:string}):Row {
  const reported=validateBriefInput(input),actor=s.requireActor(),binding=currentBinding(s,taskId);
  const identity=inspectCheckout(s,binding.checkout_id,binding.working_dir),manifest=dirtyManifest(identity.checkout_root);
  const roleConfig=s.role(actor),roleConfigDigest=digest(roleConfig);
  const fresh=inspectCheckout(s,binding.checkout_id,binding.working_dir);
  check(JSON.stringify(identity)===JSON.stringify(fresh) && digest(manifest)===digest(dirtyManifest(identity.checkout_root)),'Git or dirty files changed during brief capture; retry',4);
  return s.tx(()=>{
    assertWorkAllowed(s,actor);
    const task=s.task(taskId);
    check(task.owner===actor && ['doing','review'].includes(task.status),'Only the active task owner may save a brief',3);
    check(task.version===integer(expectedVersion,'task version',1),'Task changed; inspect its current version',4);
    check(currentBinding(s,taskId).id===binding.id,'Checkout binding changed during capture',4);
    check(digest(s.role(actor))===roleConfigDigest,'Role configuration changed during capture',4);
    check(!s.get("SELECT id FROM jobs WHERE workspace_id=? AND role=? AND status IN ('waiting','running')",s.ws,actor),'Active jobs block handover',4);
    assertPhysicalIdentity(identity);
    if(intent) {
      const target=s.role(intent.to);check(!task.human_only || target.kind==='human','Human-only work cannot be handed to an agent',3);
      check(intent.to!==actor,'Task already belongs to this role',4);text(intent.summary,'handoff summary');
    }
    const progress=getNotificationProgress(s);check(progress,'Save a safely handled notification cursor before the brief',4);
    const taskVersions=s.all("SELECT id,version,status,owner FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id",s.ws,actor).map(row=>({...row,id:`T${row.id}`}));
    const registry=registeredCheckout(s,binding.checkout_id);
    const body={version:1,reported,observed:{project_id:registry.project_id,repository_id:registry.repository_id,checkout_id:binding.checkout_id,binding_id:binding.id,provider:binding.provider,provider_session_id:binding.provider_session_id,role:actor,repository:identity,dirty_manifest:manifest,dirty_digest:digest(manifest),role_configuration_digest:roleConfigDigest,task_versions:taskVersions,notification_progress:progress},readiness:'recorded-only; managed quiescence and finalization are not established'};
    const serialized=JSON.stringify(body);check(Buffer.byteLength(serialized)<=32768,'Complete brief exceeds 32768 bytes; shorten fields or split work without omitting dirty evidence');
    const brief={id:randomUUID(),workspace_id:s.ws,task_id:task.id,role:actor,binding_id:binding.id,body,digest:digest(body),created_at:now()};
    s.run('INSERT INTO task_briefs VALUES(?,?,?,?,?,?,?,?)',brief.id,s.ws,task.id,actor,binding.id,serialized,brief.digest,brief.created_at);
    s.event('task-brief',brief.id,'saved',{task:taskId,binding_id:binding.id,digest:brief.digest,task_version:task.version});
    if(intent) {
      const canonicalTask=`T${task.id}`;
      const event=s.event('task-handoff',canonicalTask,'pending',{...intent,brief_id:brief.id,brief_digest:brief.digest,task_version:expectedVersion,binding_id:brief.binding_id});
      return {id:`E${event}`,task_id:canonicalTask,to:intent.to,brief_id:brief.id,state:'pending-retirement',owner:actor,reason:'Task ownership and checkout reservation retained; verified retirement is required before finalization'};
    }
    return brief;
  });
}
export function saveTaskBrief(s:Store,taskId:string,input:unknown,expectedVersion:number):Row {
  return captureAndSaveBrief(s,taskId,input,expectedVersion);
}
export function showTaskBrief(s:Store,taskId:string):Row|null {
  s.task(taskId);
  const row=s.get('SELECT * FROM task_briefs WHERE workspace_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1',s.ws,id(taskId,'T'));
  return row?{...row,body:JSON.parse(row.body)}:null;
}
export function pendingBoundHandoff(s:Store,taskId:string,to:string,summary:string,input:unknown,expectedVersion:number):Row {
  // This is a durable request, never evidence that the current worker is quiescent.
  // Ownership and checkout reservations remain with the old role until verified retirement.
  return captureAndSaveBrief(s,taskId,input,expectedVersion,{to,summary});
}
