import { spawnSync } from 'node:child_process';
import { type Store } from './storage.js';
import { check, now, text } from './errors.js';

export interface RecoveryEvidenceInput {
  version: 1;
  validation: {command:string;result:string}[];
  artifacts: string[];
  jobs: {id:string;description:string;state:'running'|'completed'|'failed'|'stopped'|'unknown';disposition:'finish'|'stop'|'adopt';reference?:string}[];
}
export interface RepositoryEvidence {
  status: 'available'|'unavailable';
  observed_at: string;
  directory: string;
  root: string|null;
  git_dir: string|null;
  common_dir: string|null;
  branch: string|null;
  head: string|null;
  dirty: boolean|null;
  reason: string|null;
}
export interface TaskEvidence {
  items: {id:string;version:number;status:string;owner:string|null;for_role:string|null}[];
  total: number;
  truncated: boolean;
}
export const MAX_EVIDENCE_BYTES=32_768;
export const MAX_CHECKPOINT_BYTES=96_000;

function object(value:unknown,label:string):Record<string,unknown> {
  check(value!==null && typeof value==='object' && !Array.isArray(value),`${label} must be an object`);
  return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,allowed:string[],label:string):void {
  check(Object.keys(value).every(key=>allowed.includes(key)),`${label} contains an unknown field`);
}
function array(value:unknown,label:string):unknown[] {
  check(Array.isArray(value) && value.length<=20,`${label} must be an array with at most 20 entries`);return value;
}
export function validateRecoveryEvidence(value:unknown):RecoveryEvidenceInput {
  const entry=object(value,'evidence');keys(entry,['version','validation','artifacts','jobs'],'evidence');
  check(entry.version===1,'evidence version must be 1');
  check(Buffer.byteLength(JSON.stringify(value),'utf8')<=MAX_EVIDENCE_BYTES,'evidence must be at most 32768 bytes');
  const validation=array(entry.validation,'validation').map(raw=>{
    const item=object(raw,'validation entry');keys(item,['command','result'],'validation entry');
    return {command:text(item.command,'validation command',1_000),result:text(item.result,'validation result',2_000)};
  });
  const artifacts=array(entry.artifacts,'artifacts').map(value=>text(value,'artifact reference',1_000));
  const seen=new Set<string>();
  const jobs=array(entry.jobs,'jobs').map(raw=>{
    const item=object(raw,'job');keys(item,['id','description','state','disposition','reference'],'job');
    const id=text(item.id,'job id',100);check(!seen.has(id),'job ids must be unique');seen.add(id);
    const description=text(item.description,'job description',1_000);
    check(typeof item.state==='string' && ['running','completed','failed','stopped','unknown'].includes(item.state),'job state must be running, completed, failed, stopped or unknown');
    check(typeof item.disposition==='string' && ['finish','stop','adopt'].includes(item.disposition),'job disposition must be finish, stop or adopt');
    const reference=item.reference===undefined?undefined:text(item.reference,'job reference',1_000);
    return {id,description,state:item.state as RecoveryEvidenceInput['jobs'][number]['state'],disposition:item.disposition as RecoveryEvidenceInput['jobs'][number]['disposition'],...(reference===undefined?{}:{reference})};
  });
  return {version:1,validation,artifacts,jobs};
}

/** Read-only bounded subprocesses run before the checkpoint's database transaction. */
export function observeRepository(directory:string):RepositoryEvidence {
  text(directory,'repository directory',4_096);
  const result:RepositoryEvidence={status:'unavailable',observed_at:now(),directory,root:null,git_dir:null,common_dir:null,branch:null,head:null,dirty:null,reason:null};
  const env={...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE']) delete env[key as keyof typeof env];
  const run=(args:string[],maxBuffer=16_384)=>spawnSync('git',['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',directory,...args],{encoding:'utf8',timeout:2_000,maxBuffer,env,shell:false});
  const root=run(['rev-parse','--show-toplevel']);
  if(root.error || root.status!==0) {result.reason='Git worktree unavailable: not a repository, missing Git, inaccessible directory or bounded probe failure.';return result;}
  const rootPath=root.stdout.trimEnd();
  if(!rootPath || rootPath.length>4096) {result.reason='Git returned unsupported or oversized repository metadata.';return result;}
  result.root=rootPath;
  const gitDir=run(['rev-parse','--absolute-git-dir']),commonDir=run(['rev-parse','--path-format=absolute','--git-common-dir']);
  const branch=run(['symbolic-ref','--quiet','--short','HEAD']),head=run(['rev-parse','--verify','--quiet','HEAD']);
  const status=run(['status','--porcelain=v1','-z','--untracked-files=normal'],262_144);
  if(gitDir.error || gitDir.status!==0 || commonDir.error || commonDir.status!==0 || branch.error || ![0,1].includes(branch.status??-1) || head.error || ![0,1].includes(head.status??-1) || status.error || status.status!==0) {
    result.reason='Git evidence probe failed or exceeded its time/output limit; inspect the worktree before recovery.';return result;
  }
  const paths=[result.root,gitDir.stdout.trimEnd(),commonDir.stdout.trimEnd()];
  if(paths.some(value=>!value || value.length>4096) || branch.stdout.length>1024 || (head.status===0 && !/^[0-9a-f]{40,64}\s*$/.test(head.stdout))) {
    result.reason='Git returned unsupported or oversized repository metadata.';return result;
  }
  result.status='available';result.git_dir=paths[1];result.common_dir=paths[2];
  result.branch=branch.status===0?branch.stdout.trimEnd():null;result.head=head.status===0?head.stdout.trimEnd():null;
  result.dirty=status.stdout.length>0;return result;
}

/** Called under the checkpoint transaction, including task IDs routed to this role. */
export function observeTasks(s:Store,role:string):TaskEvidence {
  const predicate="workspace_id=? AND (owner=? OR for_role=?) AND status NOT IN ('done','dropped')";
  const total=Number(s.get(`SELECT count(*) AS n FROM tasks WHERE ${predicate}`,s.ws,role,role)!.n);
  const items=s.all(`SELECT id,version,status,owner,for_role FROM tasks WHERE ${predicate} ORDER BY id LIMIT 100`,s.ws,role,role).map(row=>({id:`T${row.id}`,version:Number(row.version),status:String(row.status),owner:row.owner as string|null,for_role:row.for_role as string|null}));
  return {items,total,truncated:total>items.length};
}

/** Validate persisted evidence without running commands or consulting the filesystem. */
export function inspectRecoveryEvidence(value:unknown, expected?:{role:string;event_id:number}):{evidence:Record<string,unknown>|null;missing:string[];malformed:boolean} {
  const missing:string[]=[];
  const timestamp=(value:unknown):boolean=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
  try {
    const evidence=object(value,'saved evidence');check(evidence.version===1,'saved evidence version');
    check(Buffer.byteLength(JSON.stringify(evidence),'utf8')<=MAX_CHECKPOINT_BYTES,'saved evidence size');
    const observed=object(evidence.observed,'observed evidence');
    const repository=object(observed.repository,'repository evidence');
    check(typeof repository.status==='string' && ['available','unavailable'].includes(repository.status),'repository status');
    check(timestamp(repository.observed_at),'repository observation time');
    check(typeof repository.directory==='string' && repository.directory.length<=4096,'repository directory');
    for(const key of ['root','git_dir','common_dir','branch','head','reason']) check(repository[key]===null || typeof repository[key]==='string' && (repository[key] as string).length<=4096,'repository metadata');
    check(repository.dirty===null || typeof repository.dirty==='boolean','repository dirty status');
    if(repository.status==='available') check(typeof repository.root==='string' && typeof repository.git_dir==='string' && typeof repository.common_dir==='string' && typeof repository.dirty==='boolean','available repository metadata');
    else missing.push('Repository evidence was unavailable when saved; inspect the working directory.');
    const tasks=object(observed.tasks,'observed tasks');
    check(Array.isArray(tasks.items) && tasks.items.length<=100,'observed task list');
    check(Number.isSafeInteger(tasks.total) && Number(tasks.total)>=tasks.items.length && tasks.truncated===(Number(tasks.total)>tasks.items.length),'observed task counts');
    const ids=new Set<string>();
    for(const raw of tasks.items) {
      const item=object(raw,'observed task');
      check(typeof item.id==='string' && /^T[1-9][0-9]*$/.test(item.id) && !ids.has(item.id),'observed task id');ids.add(item.id);
      check(Number.isSafeInteger(item.version) && Number(item.version)>0,'observed task version');
      check(typeof item.status==='string' && ['open','doing','blocked','review'].includes(item.status),'observed task status');
      for(const key of ['owner','for_role']) check(item[key]===null || typeof item[key]==='string','observed task role');
    }
    if(tasks.truncated) missing.push('Task evidence is truncated to 100 entries; inspect current task records for the complete set.');
    if(evidence.reported===null) missing.push('Agent validation, artifacts and job evidence were not supplied; absence does not mean no jobs or tests.');
    else validateRecoveryEvidence(evidence.reported);
    if(observed.notification_progress===null) missing.push('No durable notification progress had been saved.');
    else {
      const progress=object(observed.notification_progress,'notification progress');
      check(typeof progress.id==='string' && /^E[1-9][0-9]*$/.test(progress.id),'notification progress identity');
      const eventId=Number(progress.id.slice(1));
      check(Number.isSafeInteger(eventId) && (!expected || eventId<expected.event_id),'notification progress event');
      check(typeof progress.role==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(progress.role) && (!expected || progress.role===expected.role),'notification progress role');
      check(timestamp(progress.saved_at),'notification progress timestamp');
      check(Number.isSafeInteger(progress.cursor) && Number(progress.cursor)>=0 && Number.isSafeInteger(progress.version) && Number(progress.version)>0,'notification progress version/cursor');
      check(Number(progress.cursor)<eventId,'notification progress cursor must precede its saved event');
    }
    return {evidence,missing,malformed:false};
  } catch {
    return {evidence:null,missing:['Saved recovery evidence is malformed or unsupported; inspect its audit event and refresh the checkpoint.'],malformed:true};
  }
}
